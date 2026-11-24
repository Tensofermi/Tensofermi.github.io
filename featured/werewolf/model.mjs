export const DEFAULT_MODEL_SETTINGS = Object.freeze({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });

export function completionEndpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl.trim()); } catch { throw new Error('请输入完整的模型服务地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('模型服务需要 HTTPS，本机服务可以使用 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址请勿包含凭据、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname = `${url.pathname === '/' ? '' : url.pathname}/chat/completions`;
  return url.href;
}

function modelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function statusError(status) {
  if (status === 401 || status === 403) return modelError('authorization', '模型服务拒绝授权。请检查 Key 和模型权限。');
  if (status === 429) return modelError('rate_limit', '模型服务限流。可以稍后重试。');
  if (status === 404) return modelError('endpoint', '找不到模型或接口。请检查服务地址与模型名。');
  if (status === 400 || status === 422) return modelError('parameters', '模型服务不接受这个请求格式。请检查接口类型与模型设置。');
  return modelError('http', `模型服务返回 HTTP ${status}。`);
}

function tokenUsage(raw) {
  const usage = {};
  for (const [reportedKey, usageKey] of [['prompt_tokens', 'inputTokens'], ['completion_tokens', 'outputTokens'], ['total_tokens', 'totalTokens']]) {
    if (Number.isSafeInteger(raw?.[reportedKey]) && raw[reportedKey] >= 0) usage[usageKey] = raw[reportedKey];
  }
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.keys(usage).length ? usage : null;
}

export function createModelAdapter({ baseUrl, model, key, timeoutMs = 18000, fetchImpl = globalThis.fetch, tokenParameter = 'max_tokens' }) {
  const destination = completionEndpoint(baseUrl);
  const modelName = model.trim();
  const apiKey = key.trim();
  if (!modelName || modelName.length > 160) throw new Error('请填写有效的模型名。');
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请输入有效的 API Key。');
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter)) throw new Error('输出限制参数无效。');
  const deepseek = new URL(destination).hostname === 'api.deepseek.com';

  async function generate(messages, { signal, maxTokens = 480 } = {}) {
    if (signal?.aborted) throw modelError('cancelled', '请求已取消。');
    const controller = new AbortController();
    let timeout;
    let listener;
    const interrupted = new Promise((_, reject) => {
      listener = () => {
        reject(modelError('cancelled', '请求已取消。'));
        controller.abort();
      };
      signal?.addEventListener('abort', listener, { once: true });
      timeout = setTimeout(() => {
        reject(modelError('timeout', '模型响应超时。'));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([interrupted, (async () => {
        let response;
        try {
          response = await fetchImpl(destination, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
            body: JSON.stringify({
              model: modelName, messages, stream: false, [tokenParameter]: maxTokens,
              ...(deepseek ? { thinking: { type: 'disabled' } } : {}),
            }),
          });
        } catch {
          throw modelError('network', '浏览器无法连接模型服务。请检查网络、HTTPS 和服务的跨域设置。');
        }
        if (!response.ok) throw statusError(response.status);
        let json;
        try { json = await response.json(); } catch { throw modelError('invalid_response', '模型服务返回了无法读取的 JSON。'); }
        const text = json?.choices?.[0]?.message?.content;
        return { text: typeof text === 'string' ? text : '', usage: tokenUsage(json?.usage) };
      })()]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', listener);
    }
  }

  async function test({ signal } = {}) {
    const reply = await generate([
      { role: 'system', content: 'This is a connectivity test. Reply with a short JSON object.' },
      { role: 'user', content: 'Reply with {"ok":true}.' },
    ], { signal, maxTokens: 96 });
    if (!reply.text.trim()) throw modelError('invalid_response', '服务已应答，但未返回可读的聊天内容。');
    return { ok: true, destination, model: modelName, usage: reply.usage };
  }

  return Object.freeze({ destination, model: modelName, generate, test });
}
