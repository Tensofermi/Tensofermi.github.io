import { restoreState } from './rules.mjs';

export const SAVE_KEY = 'featured.werewolf.save';
const VERSION = 1;

export function readSave(storage = localStorage) {
  const raw = storage.getItem(SAVE_KEY);
  if (raw === null) return null;
  const save = JSON.parse(raw);
  if (save?.version !== VERSION || !Number.isSafeInteger(save.revision) || save.revision < 1
    || !['local', 'model'].includes(save.mode)
    || !save.memory || typeof save.memory !== 'object' || !save.usage || typeof save.usage !== 'object') {
    throw new Error('无法读取这个版本的存档。');
  }
  const connection = save.mode === 'model' ? validateConnection(save.connection) : null;
  return {
    revision: save.revision, state: restoreState(save.state), mode: save.mode,
    connection, memory: save.memory, usage: save.usage,
  };
}

function validateConnection(connection) {
  if (typeof connection?.baseUrl !== 'string' || typeof connection.model !== 'string' || !connection.model.trim()) {
    throw new Error('存档缺少模型连接信息。');
  }
  const destination = new URL(connection.baseUrl);
  if (!['https:', 'http:'].includes(destination.protocol) || destination.username || destination.password
    || destination.search || destination.hash) throw new Error('存档中的请求地址无效。');
  return { baseUrl: destination.href, model: connection.model };
}

export function writeSave({ state, mode, connection, memory, usage }, expectedRevision, storage = localStorage) {
  const old = storage.getItem(SAVE_KEY);
  if (expectedRevision !== null && JSON.parse(old ?? 'null')?.revision !== expectedRevision) {
    throw new Error('存档已在另一个页面更新。请重新读取存档。');
  }
  let previousRevision = expectedRevision ?? 0;
  if (expectedRevision === null && old !== null) {
    try {
      const oldRevision = JSON.parse(old)?.revision;
      if (Number.isSafeInteger(oldRevision) && oldRevision > 0) previousRevision = oldRevision;
    } catch {
      // A new game can replace an earlier damaged save.
    }
  }
  const revision = previousRevision + 1;
  const savedConnection = mode === 'model' ? validateConnection(connection) : null;
  storage.setItem(SAVE_KEY, JSON.stringify({ version: VERSION, revision, state, mode, connection: savedConnection, memory, usage }));
  return revision;
}

export function clearSave(storage = localStorage) {
  storage.removeItem(SAVE_KEY);
}
