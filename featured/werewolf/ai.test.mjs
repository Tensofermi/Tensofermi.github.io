import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { buildRequest, localDecision, parseDecision, updateMemory } from './ai.mjs';
import { CHARACTERS, HUMAN_AVATARS, characterById, characterLine } from './characters.mjs';
import { completionEndpoint, createModelAdapter } from './model.mjs';
import { BOARDS, ROLES } from './roles.mjs';
import { createMemory, createUsage, runAI } from './scheduler.mjs';
import { newGame, pending, submit, validate } from './rules.mjs';
import { observe } from './visibility.mjs';

function makeSession({ humanRole = 'villager', seed = 97, ...options } = {}) {
  let state = newGame({ humanRole, seed });
  const usage = createUsage();
  const memory = createMemory();
  const commits = [];
  const getState = () => state;
  return {
    usage, memory, commits, getState,
    step(payload) {
      const action = pending(state)[0];
      state = submit(state, action, payload ?? localDecision(observe(state, action.actor, action)));
    },
    run(extra = {}) {
      return runAI({
        getState, usage, memory, ...options,
        commit(action, payload, meta) {
          assert.match(meta.mode, /^(local|model|fallback)$/);
          assert.ok(validate(state, action, payload));
          state = submit(state, action, payload);
          commits.push({ action, payload, meta });
        },
        ...extra,
      });
    },
  };
}

test('validates structured response shape and keeps private decision fields out of payloads', () => {
  const vote = { kind: 'vote' };
  const text = '{"target":4,"suspect":3,"evidence":["e1"]}';
  assert.deepEqual(parseDecision(text, vote), { payload: { target: 4 }, suspect: 3, evidence: ['e1'] });
  assert.equal(parseDecision('{"target":4,"role":"wolf"}', vote), null);
  assert.equal(parseDecision('{"potion":"save","target":4}', { kind: 'use_potion' }), null);
  assert.equal(parseDecision('{"text":"甲𠮷乙"}', { kind: 'speak', maxLength: 2 }), null);
});

test('visibility controls every request and the evidence retained by each role', () => {
  const game = makeSession({ seed: 201 });
  const actions = new Set();
  for (let step = 0; !game.getState().winner && step < 200; step++) {
    const state = game.getState();
    const [action] = pending(state);
    const view = observe(state, action.actor, action);
    const messages = buildRequest(view, { facts: [{ id: '__foreign', summary: 'secret' }], judgement: { target: 5, sourceIds: ['__foreign'] } });
    const data = JSON.parse(messages[1].content);
    assert.equal(data.self.role, state.seats[action.actor - 1].role);
    const entitled = new Set([action.actor, ...(data.self.teammates ?? [])]);
    assert.deepEqual(data.seats.filter(seat => seat.role).map(seat => seat.id), data.seats.filter(seat => entitled.has(seat.id)).map(seat => seat.id));
    assert.ok(data.recentPrivate.every(event => {
      if (event.kind.startsWith('wolf_')) return data.self.role === 'wolf';
      if (event.kind === 'inspect') return data.self.role === 'seer' && event.seat === action.actor;
      return data.self.role === 'witch';
    }));
    assert.equal(messages[1].content.includes(action.id), false);
    assert.equal(messages[1].content.includes('__foreign'), false);
    assert.equal(messages.map(message => message.content).join('').length <= 11500, true);
    const memory = updateMemory(view, { suspect: 5, evidence: ['__foreign'] });
    assert.equal(JSON.stringify(memory).includes('__foreign'), false);
    actions.add(action.kind);
    game.step();
  }
  for (const kind of ['wolf_chat', 'wolf_kill', 'inspect', 'use_potion', 'speak', 'vote']) assert.ok(actions.has(kind), kind);
  assert.ok(game.getState().winner);
});

test('local bot reacts to repeated public suspicion from the human', () => {
  const state = newGame({ humanRole: 'villager', seed: 51 });
  const actor = state.seats.find(seat => seat.id > 1 && seat.role === 'villager');
  const view = observe(state, actor.id);
  const candidates = view.seats.filter(seat => seat.id > 1 && seat.id !== actor.id);
  view.legal = { kind: 'vote', targets: candidates.map(seat => seat.id), allowPass: false };
  const before = localDecision(view).target;
  const other = candidates.find(seat => seat.id !== before).id;
  view.events = Array.from({ length: 4 }, (_, index) => ({
    id: 'human-' + index, day: 1, kind: 'speak', seat: 1, text: '我明确怀疑' + other + '号，跟前一轮的理由不一致。',
  }));
  assert.equal(localDecision(view).target, other);
});

test('model instructions use the actual board and the human host frame', () => {
  for (const size of [6, 9, 12]) {
    const game = newGame({ size, seed: 52, humanRole: 'villager', avatar: 'lumine' });
    const [action] = pending(game);
    const view = observe(game, action.actor, action);
    const [system, data] = buildRequest(view);
    assert.match(system.content, /荧邀几位朋友围桌玩狼人杀/);
    assert.ok(system.content.includes(size + ' 人狼人杀'));
    for (const [role, count] of Object.entries(BOARDS[size])) {
      if (count) assert.ok(system.content.includes(ROLES[role].name + ' ' + count + ' 位'));
      else assert.ok(!system.content.includes(ROLES[role].name));
    }
    assert.equal(JSON.parse(data.content).self.personality.voice, view.self.personality.voice);
  }
});

test('every named character produces a distinct original line in each speech phase', () => {
  assert.equal(CHARACTERS.length, 11);
  assert.equal(HUMAN_AVATARS.lumine.name, '荧');
  assert.equal(characterById('retired'), null);
  for (const kind of ['speak', 'wolf_chat', 'last_words']) {
    for (const turn of [1, 2]) {
      const lines = CHARACTERS.map(character => characterLine({ characterId: character.id }, '4号', kind, turn));
      assert.equal(new Set(lines).size, 11);
      assert.ok(lines.every(line => line.includes('4号') && !line.includes('{target}')));
    }
  }
});

test('repairs one bad JSON action, counts requests immediately, and falls back once budget is spent', async () => {
  let requests = 0;
  const moment = [];
  const game = makeSession({ adapter: { async generate() {
    requests++;
    moment.push(game.usage.calls);
    return { text: requests === 1 ? '{broken' : '{"text":"今晚先选一个目标。"}', usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } };
  } }, limits: { calls: 2, concurrency: 1 } });
  await game.run();
  assert.deepEqual(moment, [1, 2]);
  assert.equal(game.usage.calls, 2);
  assert.equal(game.usage.reportedCalls, 2);
  assert.equal(game.usage.totalTokens, 24);
  assert.equal(game.commits[0].meta.mode, 'model');
  assert.ok(game.commits.slice(1).some(entry => entry.meta.reason === 'budget'));
  const diagnostic = game.memory.bySeat[game.commits[0].action.actor].observation;
  assert.match(diagnostic.messages[0].content, /上一次行动格式或目标无效/);
});

test('human votes first, AI ballots remain sealed, and concurrency is bounded', async () => {
  const game = makeSession();
  while (!pending(game.getState()).some(action => action.actor === 1 && action.kind === 'vote')) game.step();
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  const controller = new AbortController();
  const adapter = { async generate(messages) {
    active++;
    requests++;
    maxActive = Math.max(maxActive, active);
    const data = JSON.parse(messages[1].content);
    assert.ok(data.recentPublic.every(event => event.kind !== 'votes'));
    await new Promise(resolve => setTimeout(resolve, 6));
    active--;
    return { text: JSON.stringify({ target: data.targets[0] ?? null }) };
  } };
  await game.run({ adapter, limits: { concurrency: 2 } });
  assert.equal(requests, 0);
  const first = pending(game.getState()).find(action => action.actor === 1);
  let state = submit(game.getState(), first, { target: first.targets[0] });
  const startPhase = state.phase.id;
  await game.run({ getState: () => state, signal: controller.signal, adapter, limits: { concurrency: 2 }, commit(action, payload) {
    state = submit(state, action, payload);
    if (state.phase.id !== startPhase) controller.abort();
  } });
  assert.equal(maxActive, 2);
  assert.ok(requests > 2);
});

test('late replies from a cancelled, already-resolved action cannot commit', async () => {
  for (const invalidate of ['abort', 'resolve']) {
    const controller = new AbortController();
    const game = makeSession({ signal: controller.signal });
    let deliver;
    const response = new Promise(resolve => { deliver = resolve; });
    const running = game.run({ adapter: { generate: () => response } });
    assert.equal(game.usage.calls, 1);
    if (invalidate === 'abort') controller.abort();
    else game.step();
    deliver({ text: '{"text":"迟到的发言"}' });
    await running;
    assert.equal(game.commits.length, 0);
    assert.ok(!game.getState().events.some(event => event.text === '迟到的发言'));
  }
});

test('connection test uses Chat Completions, avoids redirects and reports real tokens', async () => {
  const seen = [];
  const adapter = createModelAdapter({
    baseUrl: 'https://service.example/v1/',
    model: 'demo',
    key: 'only-in-header',
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}', reasoning_content: 'discard' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }));
    },
  });
  const outcome = await adapter.test();
  assert.equal(seen[0].url, 'https://service.example/v1/chat/completions');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer only-in-header');
  assert.ok(!seen[0].init.body.includes('only-in-header'));
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(JSON.stringify(outcome).includes('discard'), false);
  assert.throws(() => completionEndpoint('https://user:password@service.example/v1'));
});

test('hung transport times out, and rate-limited bodies with credentials stay out of errors', async () => {
  const settings = { baseUrl: 'https://service.example', model: 'demo', key: 'private-use-only' };
  const hung = createModelAdapter({ ...settings, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  await assert.rejects(hung.generate([]), { code: 'timeout' });
  const rateLimited = createModelAdapter({ ...settings, fetchImpl: () => new Response(settings.key, { status: 429 }) });
  await assert.rejects(rateLimited.generate([]), error => error.code === 'rate_limit' && !error.message.includes(settings.key));
  const game = makeSession({ adapter: hung });
  await game.run();
  assert.equal(game.usage.calls, 1);
  assert.ok(game.commits.every(entry => entry.meta.reason === 'timeout'));
});

test('a whole game runs through a real HTTP connection to a simulated provider', async () => {
  const requestBodies = [];
  const syntheticKey = 'test-fixture-key-no-live-service';
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
      || request.headers.authorization !== 'Bearer ' + syntheticKey) {
      response.writeHead(400).end();
      return;
    }
    let body = '';
    for await (const piece of request) body += piece;
    const parsed = JSON.parse(body);
    requestBodies.push(parsed);
    const observation = JSON.parse(parsed.messages[1].content);
    const payload = observation.maxTextLength ? { text: '这轮我会从目前的公开信息来判断。' }
      : observation.canSave !== undefined ? { potion: observation.canSave ? 'save' : 'pass' }
        : { target: observation.targets[0] ?? null };
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
    }));
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const adapter = createModelAdapter({ baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock-werewolf', key: syntheticKey });
    const game = makeSession({ humanRole: 'wolf', seed: 18, adapter, limits: { calls: 100 } });
    for (let cycle = 0; !game.getState().winner && cycle < 80; cycle++) {
      await game.run();
      if (game.getState().winner) break;
      assert.equal(pending(game.getState())[0].actor, 1);
      game.step();
    }
    assert.ok(game.getState().winner);
    assert.ok(requestBodies.length > 10);
    assert.equal(game.usage.calls, requestBodies.length);
    assert.equal(game.usage.totalTokens, requestBodies.length * 11);
    assert.equal(game.usage.fallbacks, 0);
    assert.equal(JSON.stringify({ game: game.getState(), memory: game.memory, requestBodies }).includes(syntheticKey), false);
    assert.ok(game.commits.every(entry => entry.meta.mode === 'model'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
