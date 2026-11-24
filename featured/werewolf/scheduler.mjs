import { pending, validate } from './rules.mjs';
import { observe } from './visibility.mjs';
import { buildRequest, localDecision, parseDecision, updateMemory } from './ai.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  calls: 120, concurrency: 3, maxInputChars: 11500, maxOutputTokens: 480, repairAttempts: 1,
});

export const createMemory = () => ({ bySeat: {} });
export const createUsage = () => ({
  calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  reportedCalls: 0, reportedInputCalls: 0, reportedOutputCalls: 0, reportedTotalCalls: 0, fallbacks: 0,
});

const HUMAN = 1;
const yieldToPage = () => new Promise(resolve => setTimeout(resolve, 0));

function boundedInteger(value, min, max, fallback) {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export async function runAI({ getState, commit, adapter, signal, onProgress, memory, usage, limits = {} }) {
  const options = {
    calls: boundedInteger(limits.calls, 0, 9999, DEFAULT_LIMITS.calls),
    concurrency: boundedInteger(limits.concurrency, 1, 8, DEFAULT_LIMITS.concurrency),
    maxInputChars: boundedInteger(limits.maxInputChars, 1, 50000, DEFAULT_LIMITS.maxInputChars),
    maxOutputTokens: boundedInteger(limits.maxOutputTokens, 1, 4096, DEFAULT_LIMITS.maxOutputTokens),
    repairAttempts: boundedInteger(limits.repairAttempts, 0, 2, DEFAULT_LIMITS.repairAttempts),
  };
  memory.bySeat ??= {};
  let unavailable;
  const progress = busy => onProgress?.({ busy });

  function currentAction(action) {
    const latest = getState();
    if (signal?.aborted || !latest || latest.winner || latest.phase.id !== action.phaseId) return false;
    return pending(latest).some(item => item.id === action.id && item.actor === action.actor);
  }

  function recordUsage(reported) {
    if (!reported) return;
    const fields = Object.entries({
      inputTokens: 'reportedInputCalls', outputTokens: 'reportedOutputCalls', totalTokens: 'reportedTotalCalls',
    }).filter(([name]) =>
      Number.isSafeInteger(reported[name]) && reported[name] >= 0);
    if (!fields.length) return;
    usage.reportedCalls++;
    for (const [name, count] of fields) {
      usage[name] += reported[name];
      usage[count] = (usage[count] ?? 0) + 1;
    }
    progress(true);
  }

  async function propose(state, action, view) {
    if (!currentAction(action)) return null;
    const fallbackDecision = reason => ({
      decision: { payload: localDecision(view) },
      meta: adapter ? { mode: 'fallback', reason } : { mode: 'local' },
    });
    if (!adapter) return fallbackDecision();
    if (unavailable) return fallbackDecision(unavailable);

    for (let retry = 0; retry <= options.repairAttempts; retry++) {
      if (!currentAction(action)) return null;
      if (usage.calls >= options.calls) return fallbackDecision('budget');
      let messages;
      try {
        messages = buildRequest(view, memory.bySeat[action.actor], { maxInputChars: options.maxInputChars, repair: retry > 0 });
      } catch { return fallbackDecision('context'); }

      memory.bySeat[action.actor] = {
        ...(memory.bySeat[action.actor] ?? {}),
        observation: { phaseId: action.phaseId, actionId: action.id, messages },
      };
      usage.calls++;
      progress(true);

      try {
        const reply = await adapter.generate(messages, { signal, maxTokens: options.maxOutputTokens });
        recordUsage(reply?.usage);
        if (!currentAction(action)) return null;
        const decision = parseDecision(reply?.text, action);
        if (decision && validate(state, action, decision.payload)) return { decision, meta: { mode: 'model' } };
      } catch (error) {
        if (!currentAction(action) || error?.code === 'cancelled') return null;
        if (error?.code !== 'invalid_response') {
          unavailable = ['authorization', 'rate_limit', 'endpoint', 'parameters', 'http', 'network', 'timeout'].includes(error?.code)
            ? error.code : 'unavailable';
          return fallbackDecision(unavailable);
        }
      }
    }
    return fallbackDecision('invalid_action');
  }

  progress(true);
  try {
    while (!signal?.aborted) {
      const state = getState();
      if (!state || state.winner) return;
      const group = pending(state);
      if (!group.length || group.some(action => action.actor === HUMAN)) return;

      // Capture each seat's view before any response in this batch is applied.
      const batch = group.slice(0, options.concurrency).map(action => ({
        action, view: observe(state, action.actor, action),
      }));
      const replies = await Promise.all(batch.map(({ action, view }) => propose(state, action, view)));
      if (signal?.aborted) return;
      let advanced = false;
      for (const [index, reply] of replies.entries()) {
        const { action, view } = batch[index];
        if (!reply || !currentAction(action)) continue;
        const { decision, meta } = reply;
        if (!validate(getState(), action, decision.payload)) throw new Error('当前行动无法结算。');
        const previous = memory.bySeat[action.actor];
        memory.bySeat[action.actor] = {
          ...updateMemory(view, decision, previous), observation: previous?.observation, lastMode: meta.mode,
          ...(meta.reason ? { fallbackReason: meta.reason } : {}),
        };
        if (meta.mode === 'fallback') usage.fallbacks++;
        if (commit(action, decision.payload, meta) === false) {
          if (previous === undefined) delete memory.bySeat[action.actor];
          else memory.bySeat[action.actor] = previous;
          if (meta.mode === 'fallback') usage.fallbacks--;
          continue;
        }
        advanced = true;
        progress(true);
      }
      if (!advanced || getState() === state) return;
      // Let the page handle input and animation even when local bots resolve immediately.
      await yieldToPage();
    }
  } finally {
    progress(false);
  }
}
