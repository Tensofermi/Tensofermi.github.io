import { createDecoder, readModel, readTokenizer, selectToken } from './model.js';

let engine;
let active;

async function loadFile(path, signal) {
    const response = await fetch(new URL(path, import.meta.url), { signal });
    if (!response.ok) throw new Error(`模型文件加载失败（HTTP ${response.status}）。可以重新生成或刷新页面。`);
    return response.arrayBuffer();
}

async function loadEngine(signal) {
    if (!engine) {
        const [weights, vocabulary] = await Promise.all([
            loadFile('stories260K.bin', signal),
            loadFile('tok512.bin', signal),
        ]);
        if (signal.aborted) return;
        const model = readModel(weights);
        engine = { context: model.context, decode: createDecoder(model), tokenizer: readTokenizer(vocabulary, model.vocab) };
    }
    return engine;
}

const yieldToWorker = () => new Promise(resolve => setTimeout(resolve, 0));

async function generate(job, { prompt, temperature, limit }) {
    const notify = (type, data = {}) => postMessage({ id: job.id, type, ...data });
    try {
        const context = await loadEngine(job.controller.signal);
        if (job !== active) return;
        const { decode, tokenizer } = context;
        const tokens = tokenizer.encode(prompt);
        if (tokens.length >= context.context) throw new Error('这段开头超过了模型的 512-token 上下文，请缩短后再试。');
        const maxTokens = Math.min(limit, context.context - tokens.length);
        notify('prefill');
        let position = 0;
        let logits;
        let deadline = performance.now() + 16;
        for (const token of tokens) {
            logits = decode(token, position++);
            if (performance.now() >= deadline) {
                await yieldToWorker();
                if (job !== active) return;
                deadline = performance.now() + 16;
            }
        }

        const stream = new TextDecoder();
        let pending = '';
        let count = 0;
        const started = performance.now();
        deadline = started + 16;
        while (count < maxTokens) {
            const token = selectToken(logits, temperature);
            if (token === 1 || token === 2) break;
            pending += tokenizer.decodeToken(token, stream);
            count++;
            if (count === maxTokens) break;
            logits = decode(token, position++);
            if (performance.now() >= deadline) {
                notify('tokens', { text: pending, count });
                pending = '';
                await yieldToWorker();
                if (job !== active) return;
                deadline = performance.now() + 16;
            }
        }
        notify('done', { text: pending + stream.decode(), count, milliseconds: performance.now() - started });
    } catch (error) {
        if (job === active) notify('error', { message: error instanceof Error ? error.message : '生成失败。' });
    } finally {
        if (job === active) {
            job.controller.abort();
            active = undefined;
        }
    }
}

self.addEventListener('message', ({ data }) => {
    if (data.type === 'stop') {
        if (active?.id === data.id) {
            active.controller.abort();
            active = undefined;
        }
        return;
    }
    if (data.type !== 'generate' || active) return;
    active = { id: data.id, controller: new AbortController() };
    void generate(active, data);
});
