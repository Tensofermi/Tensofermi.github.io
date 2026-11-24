import test from 'node:test';
import assert from 'node:assert/strict';
import { Playback, readingTime } from './playback.mjs';

const night = { id: 'p:1', day: 1, kind: 'phase', phase: 'night', text: '第 1 夜。' };
const dawn = { id: 'p:2', day: 1, kind: 'phase', phase: 'day_discussion', order: [2, 1], text: '天亮了。' };
const death = { id: 'p:3', day: 1, kind: 'death', seat: 3, text: '3 号卡芙卡昨夜出局。' };
const speech = { id: 'p:4', day: 1, kind: 'speak', seat: 2, text: '先听大家的理由。' };
const vote = { id: 'p:5', day: 1, kind: 'phase', phase: 'day_vote', text: '开始放逐投票。' };
const ballots = { id: 'p:6', day: 1, kind: 'votes', votes: [{ actor: 1, target: 2 }, { actor: 2, target: 1 }], text: '首轮投票结果。' };
const victory = { id: 'p:7', day: 1, kind: 'result', winner: 'village', text: '好人阵营获胜。' };

function view(events, options = {}) {
  return {
    self: { id: 1, name: '荧', role: 'villager', alive: true },
    seats: [{ id: 1, name: '荧', role: 'villager', alive: true },
      { id: 2, name: '芙宁娜', alive: true }, { id: 3, name: '卡芙卡', alive: !events.includes(death) }],
    events, privateEvents: [], phase: 'night', day: 1, legal: null, winner: null, ...options,
  };
}

test('dawn bundles the visible casualties, leaving the first speech for a separate click', () => {
  const reader = new Playback(view([night]));
  const latest = view([night, dawn, death, speech], { phase: 'day_discussion', legal: { id: 'human-turn' } });
  reader.push(latest);
  assert.equal(reader.view.phase, 'night');
  assert.equal(reader.view.seats[2].alive, true);
  assert.equal(reader.queue.length, 2);
  reader.advance();
  assert.equal(reader.cue.kind, 'dawn');
  assert.match(reader.cue.detail, /卡芙卡昨夜出局/);
  assert.equal(reader.view.seats[2].alive, false);
  assert.equal(reader.view.legal, null);
  reader.advance();
  assert.equal(reader.view.legal.id, 'human-turn');
  assert.equal(reader.cue.seat, 2);
});

test('refresh reconstructs unread public stages without revealing terminal roles', () => {
  const playback = new Playback(view([night, dawn, death, speech], { phase: 'day_discussion' }));
  const latest = view([night, dawn, death, speech, vote, ballots, victory], { phase: 'over', winner: 'village' });
  latest.seats[1].role = 'seer';
  playback.push(latest);
  assert.equal(playback.queue.length, 3);
  playback.advance();
  const restored = new Playback(latest, playback.checkpoint());
  assert.equal(restored.view.winner, null);
  assert.equal(restored.view.seats[1].role, undefined);
  assert.equal(restored.queue.length, 2);
  restored.advance();
  assert.match(restored.cue.detail, /1 号 1 票/);
  assert.equal(restored.view.seats[1].role, undefined);
  restored.advance();
  assert.equal(restored.cue.kind, 'result');
  assert.equal(restored.view.winner, 'village');
  assert.equal(restored.view.seats[1].role, 'seer');
});

test('only visible private records enter playback and fast-forward reaches the latest view', () => {
  const reader = new Playback(view([night]));
  const privateUtterance = { id: 's:1', day: 1, kind: 'wolf_chat', seat: 2, text: '我建议选 3 号。' };
  reader.push(view([night], { privateEvents: [privateUtterance] }));
  assert.equal(reader.view.privateEvents.length, 0);
  assert.equal(reader.queue[0].cue.kind, 'speech');
  reader.skip();
  assert.equal(reader.view.privateEvents[0].id, 's:1');
  assert.equal(reader.view.events.length, 1);
  assert.ok(readingTime({ detail: '长'.repeat(120) }) > readingTime({ detail: '短' }));
});

test('refresh keeps the last private speech open before unread daylight', () => {
  const reader = new Playback(view([night]));
  const utterance = { id: 's:1', day: 1, kind: 'wolf_chat', seat: 2, text: '我建议选 3 号。' };
  const latest = view([night, dawn, death], { phase: 'day_discussion', privateEvents: [utterance] });
  reader.push(latest);
  reader.advance();
  const restored = new Playback(latest, reader.checkpoint());
  assert.equal(restored.cue.detail, utterance.text);
  assert.equal(restored.view.phase, 'night');
  assert.equal(restored.queue[0].cue.kind, 'dawn');
});

test('a new human message is acknowledged immediately while the next stage remains unread', () => {
  const human = { ...speech, seat: 1 };
  const reader = new Playback(view([night, dawn, death], { phase: 'day_discussion' }));
  reader.push(view([night, dawn, death, human, vote], { phase: 'day_vote' }), true);
  assert.equal(reader.cue.seat, 1);
  assert.equal(reader.view.phase, 'day_discussion');
  assert.equal(reader.queue.length, 1);
});

