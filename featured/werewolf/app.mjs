import { newGame, pending, submit, validate } from './rules.mjs';
import { observe, reveal } from './visibility.mjs';
import { createMemory, createUsage, runAI } from './scheduler.mjs';
import { createModelAdapter } from './model.mjs';
import { SAVE_KEY, clearSave, readSave, writeSave } from './save.mjs';
import { mount } from './view.mjs';
import { Playback, readingTime } from './playback.mjs';

const HUMAN = 1;
const SPEED_KEY = 'featured.werewolf.reading-speed';
const SPEEDS = ['manual', 'auto', 'fast'];
let state;
let memory;
let usage;
let adapter;
let connection = null;
let mode = 'local';
let revision = null;
let saved = null;
let saveExists = false;
let saveError = '';
let displaced = false;
let request;
let testRequest;
let testStatus = '';
let status = '';
let paused = false;
let speed = readingPreference();
let developer = false;
let playback = new Playback();
let timer;

const ui = mount(document.getElementById('game'), {
  start, resume, clear, action: humanAction, cancel, retry, test: testConnection,
  setSpeed, advancePlayback, skipPlayback,
  setDeveloper(value) { developer = Boolean(value); render(); },
  useLocal,
});

function refreshSave() {
  try {
    saveExists = localStorage.getItem(SAVE_KEY) !== null;
    saved = readSave();
    saveError = '';
  } catch {
    saved = null;
    saveError = '无法读取本地存档。可以清除它或开新局。';
  }
}

function persist() {
  if (!state || displaced) return;
  try {
    const presentation = playback.checkpoint();
    revision = writeSave({ state, mode, connection, memory, usage, presentation }, revision);
    saved = { revision, state, mode, connection, memory, usage, presentation };
    saveExists = true;
    saveError = '';
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('存档已在')) {
      displaced = true;
      paused = true;
      request?.abort();
      refreshSave();
      saveError = '另一个页面已更新存档。恢复存档后可以继续。';
    } else saveError = '本局仍可游玩。浏览器暂时无法保存存档。';
  }
}

function readingPreference() {
  try {
    const stored = localStorage.getItem(SPEED_KEY);
    return SPEEDS.includes(stored) ? stored : 'manual';
  } catch { return 'manual'; }
}

function setSpeed(value) {
  if (!SPEEDS.includes(value)) return;
  speed = value;
  try { localStorage.setItem(SPEED_KEY, speed); } catch { /* The current page still uses the selection. */ }
  if (speed === 'fast') skipPlayback();
  else { clearTimeout(timer); timer = undefined; schedulePlayback(); render(); }
}

function resetPlayback(checkpoint = null) {
  clearTimeout(timer);
  timer = undefined;
  playback = new Playback(state ? observe(state, HUMAN) : null, checkpoint);
  if (speed === 'fast') playback.skip();
  schedulePlayback();
}

function skipPlayback() {
  clearTimeout(timer);
  timer = undefined;
  if (playback.queue.length) {
    playback.skip();
    persist();
  }
  render();
}

function advancePlayback() {
  clearTimeout(timer);
  timer = undefined;
  if (playback.queue.length) {
    playback.advance();
    persist();
  }
  schedulePlayback();
  render();
}

function schedulePlayback() {
  if (speed === 'auto' && timer === undefined && playback.queue.length && !document.hidden) {
    timer = setTimeout(advancePlayback, readingTime(playback.cue));
  }
}

function updatePlayback(ownAction = false) {
  playback.push(observe(state, HUMAN), ownAction);
  if (speed === 'fast') playback.skip();
  schedulePlayback();
}

function render() {
  const playing = playback.queue.length > 0;
  const visible = playing ? { ...playback.view, legal: null } : playback.view;
  const canReview = Boolean(state?.winner && !playing) || developer;
  const feedback = saveError || status || (playing && speed === 'manual' ? '读完后再继续。' : '');
  const observations = canReview && memory ? Object.fromEntries(Object.entries(memory.bySeat)
    .filter(([, seat]) => seat.observation).map(([id, seat]) => [id, seat.observation])) : null;
  ui.render({
    view: visible, recap: state && canReview ? reveal(state, { developer }) : null,
    observations,
    busy: Boolean(request), paused, hasSave: saveExists, canResume: Boolean(saved), mode,
    resumeNeedsKey: Boolean((!state && saved?.mode === 'model' && !saved.state.winner) || (state && paused && mode === 'model' && !adapter)),
    savedConnection: saved?.connection ?? null, status: feedback, testStatus, testing: Boolean(testRequest),
    usage: canReview ? usage : null, speed, developer, playing,
    playbackCue: playback.cue, nextLabel: playback.queue[0]?.cue.next ?? '继续',
    pendingFrames: playback.queue.length,
  });
}

function configure(config) {
  const baseUrl = new URL(config.baseUrl.trim());
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new Error('服务地址请填写不含凭据或查询参数的 URL。');
  const modelName = config.model.trim();
  return {
    connection: { baseUrl: baseUrl.href, model: modelName },
    adapter: createModelAdapter({ baseUrl: baseUrl.href, model: modelName, key: config.key.trim() }),
  };
}

function start(config) {
  try {
    const chosen = config.mode === 'model' ? configure(config) : { adapter: undefined, connection: null };
    const started = newGame({ humanRole: config.humanRole || undefined, size: config.size, avatar: config.avatar });
    cancelRequests();
    state = started;
    mode = config.mode === 'model' ? 'model' : 'local';
    ({ adapter, connection } = chosen);
    usage = createUsage();
    memory = createMemory();
    revision = null;
    paused = false;
    displaced = false;
    developer = false;
    status = '';
    resetPlayback();
    persist();
    render();
    void drive();
  } catch (error) {
    status = configError(error);
    render();
  }
}

function resume(config) {
  refreshSave();
  if (!saved) { render(); return; }
  let restoredAdapter;
  let restoredConnection = saved.connection;
  if (saved.mode === 'model' && config?.key) {
    try {
      const chosen = configure({ ...saved.connection, ...config });
      restoredAdapter = chosen.adapter;
      restoredConnection = chosen.connection;
    } catch (error) {
      status = configError(error);
      render();
      return;
    }
  } else if (saved.mode === 'model' && mode === 'model' && adapter
    && saved.connection?.baseUrl === connection?.baseUrl && saved.connection?.model === connection?.model) {
    restoredAdapter = adapter;
  }
  cancelRequests();
  ({ state, mode, memory, usage, revision } = saved);
  connection = restoredConnection;
  adapter = restoredAdapter;
  paused = Boolean(!state.winner && mode === 'model' && !adapter);
  displaced = false;
  developer = false;
  status = paused ? '请重新连接模型，或切换到本地机器人继续。' : '';
  resetPlayback(saved.presentation);
  render();
  if (!paused) void drive();
}

function cancelRequests() {
  request?.abort();
  request = undefined;
  testRequest?.abort();
  testRequest = undefined;
  testStatus = '';
}

function clear() {
  try {
    clearSave();
    cancelRequests();
    state = undefined;
    memory = undefined;
    usage = undefined;
    adapter = undefined;
    connection = null;
    mode = 'local';
    revision = null;
    paused = false;
    displaced = false;
    developer = false;
    status = '';
    refreshSave();
    resetPlayback();
  } catch {
    saveError = '浏览器暂时无法清除本地存档。';
  }
  render();
}

function humanAction(payload, expectedActionId) {
  if (!state || state.winner || request || displaced || playback.queue.length || paused) return false;
  const option = pending(state).find(action => action.actor === HUMAN);
  if (!option || expectedActionId !== option.id) return false;
  if (!validate(state, option, payload)) {
    status = '这项操作不适用于当前回合。';
    render();
    return false;
  }
  state = submit(state, option, payload);
  status = '';
  updatePlayback(true);
  persist();
  render();
  void drive();
  return true;
}

function cancel() {
  if (!request) return;
  paused = true;
  request.abort();
  status = '已暂停。可以重试或继续查看发言。';
  persist();
  render();
}

function retry() {
  if (request || !state || displaced || (mode === 'model' && !adapter)) return;
  paused = false;
  status = '';
  void drive();
}

function useLocal() {
  if (!state || request || displaced) return;
  mode = 'local';
  adapter = undefined;
  connection = null;
  persist();
  retry();
  render();
}

async function drive() {
  if (!state || state.winner || request || paused || displaced || pending(state).some(action => action.actor === HUMAN)) return;
  if (mode === 'model' && !adapter) return;
  const active = new AbortController();
  request = active;
  render();
  try {
    await runAI({
      getState: () => state, adapter, signal: active.signal, memory, usage,
      commit: (action, payload) => {
        if (request !== active || active.signal.aborted || !validate(state, action, payload)) return false;
        state = submit(state, action, payload);
        updatePlayback();
        persist();
        render();
        return true;
      },
      onProgress: () => { if (request === active) { persist(); render(); } },
    });
  } catch {
    if (request === active && !active.signal.aborted) {
      paused = true;
      status = '本轮行动暂停。可以重试。';
    }
  } finally {
    if (request === active) {
      request = undefined;
      persist();
      render();
    }
  }
}

function configError(error) {
  if (error instanceof TypeError) return '请检查模型服务地址、模型名和 Key。';
  return error instanceof Error ? error.message : '无法配置模型连接。';
}

async function testConnection(config) {
  testRequest?.abort();
  const active = new AbortController();
  testRequest = active;
  testStatus = '正在测试连接…';
  render();
  try {
    const chosen = configure(config).adapter;
    await chosen.test({ signal: active.signal });
    if (testRequest === active) testStatus = '连接测试通过。';
  } catch (error) {
    if (testRequest === active) testStatus = configError(error);
  } finally {
    if (testRequest === active) { testRequest = undefined; render(); }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(timer);
    timer = undefined;
  } else schedulePlayback();
});

window.addEventListener('storage', event => {
  if (event.key !== SAVE_KEY && event.key !== null) return;
  refreshSave();
  if (state && revision !== saved?.revision) {
    displaced = true;
    paused = true;
    request?.abort();
    saveError = '另一个页面已更新存档。恢复存档后可以继续。';
  }
  render();
});

refreshSave();
render();
