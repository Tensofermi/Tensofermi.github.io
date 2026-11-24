import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, pending, submit } from './rules.mjs';
import { BOARDS } from './roles.mjs';
import { observe, reveal } from './visibility.mjs';
import { localDecision } from './ai.mjs';
import { createMemory, createUsage, runAI } from './scheduler.mjs';
import { clearSave, readSave, SAVE_KEY, writeSave } from './save.mjs';

function storageFixture() {
  const data = new Map();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
}

for (const [board, roles] of Object.entries(BOARDS)) {
  const size = Number(board);
  for (const [humanRole, count] of Object.entries(roles)) {
    if (!count) continue;
    test(board + ' seats with a human ' + humanRole + ' can finish after restore', async () => {
      const storage = storageFixture();
      let state = newGame({ size, humanRole, seed: 111 });
      let memory = createMemory();
      const usage = createUsage();
      let revision = null;
      let didRestore = false;
      const save = () => {
        revision = writeSave({ state, mode: 'local', connection: null, memory, usage }, revision, storage);
      };
      for (let tick = 0; !state.winner && tick < 100; tick++) {
        await runAI({
          getState: () => state, commit(action, payload) { state = submit(state, action, payload); save(); },
          signal: new AbortController().signal, memory, usage,
        });
        if (state.winner) break;
        const action = pending(state).find(item => item.actor === 1);
        assert.ok(action);
        state = submit(state, action, localDecision(observe(state, 1, action)));
        save();
        if (!didRestore) {
          const restored = readSave(storage);
          assert.deepEqual(restored.state, state);
          assert.deepEqual(restored.memory, JSON.parse(JSON.stringify(memory)));
          state = restored.state;
          memory = restored.memory;
          didRestore = true;
        }
      }
      assert.ok(state.winner, humanRole + ' did not reach a winner');
      assert.ok(didRestore, 'scenario did not exercise restoration');
      assert.equal(reveal(state).seats.filter(seat => seat.role).length, size);
      assert.equal(usage.calls, 0);
      assert.equal(readSave(storage).state.winner, state.winner);
    });
  }
}

test('save excludes connection keys and guards against sequential stale writes', () => {
  const storage = storageFixture();
  const payload = {
    state: newGame({ seed: 1 }), mode: 'model', memory: createMemory(), usage: createUsage(),
    connection: { baseUrl: 'https://llm.example/v1', model: 'game-model', key: 'test-secret-marker' },
  };
  const initial = writeSave(payload, null, storage);
  assert.equal(initial, 1);
  assert.equal(readSave(storage).connection.key, undefined);
  assert.doesNotMatch(storage.getItem(SAVE_KEY), /test-secret-marker/);
  assert.equal(writeSave(payload, null, storage), 2);
  assert.throws(() => writeSave(payload, initial, storage), /另一个页面/);
  clearSave(storage);
  assert.equal(readSave(storage), null);
});

