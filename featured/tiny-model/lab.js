const form = document.querySelector('#story-form');
const promptField = document.querySelector('#prompt');
const temperature = document.querySelector('#temperature');
const temperatureValue = document.querySelector('#temperature-value');
const length = document.querySelector('#length');
const generateButton = document.querySelector('#generate');
const stopButton = document.querySelector('#stop');
const copyButton = document.querySelector('#copy');
const status = document.querySelector('#status');
const output = document.querySelector('#story-output');
const outputPrompt = document.querySelector('#story-prompt');
const outputText = document.querySelector('#story-text');
const continuation = document.createTextNode('');
outputText.append(continuation);

let worker;
let jobId = 0;
let running;
let tokenCount = 0;

function finish(message) {
    running = undefined;
    generateButton.disabled = false;
    stopButton.disabled = true;
    copyButton.disabled = !continuation.data;
    status.textContent = message;
}

function onMessage({ data }) {
    if (data.id !== running) return;
    if (data.type === 'prefill') status.textContent = '正在读取故事开头…';
    if (data.type === 'error') finish(data.message);
    if (data.type !== 'tokens' && data.type !== 'done') return;

    continuation.appendData(data.text);
    tokenCount = data.count;
    if (data.type === 'tokens') status.textContent = '正在续写…';
    else if (tokenCount) {
        const rate = Math.round(tokenCount * 1000 / Math.max(data.milliseconds, 1));
        finish(`生成完成 · ${tokenCount} tokens · ${rate} tokens/s`);
    } else finish('模型在此处结束了故事。试试换一个开头。');
}

function startWorker() {
    const instance = new Worker(new URL('./generate.worker.js', import.meta.url), { type: 'module' });
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', () => {
        instance.terminate();
        worker = undefined;
        finish('生成器启动失败。请刷新页面或换用较新的浏览器。');
    });
    return instance;
}

form.addEventListener('submit', event => {
    event.preventDefault();
    const prompt = promptField.value.trim();
    if (running !== undefined) return;
    if (!prompt) {
        status.textContent = '请输入一个故事开头。';
        promptField.focus();
        return;
    }
    try {
        worker ??= startWorker();
        running = ++jobId;
        tokenCount = 0;
        generateButton.disabled = true;
        stopButton.disabled = false;
        copyButton.disabled = true;
        outputPrompt.textContent = prompt;
        continuation.data = '';
        status.textContent = '正在准备模型…';
        worker.postMessage({ type: 'generate', id: running, prompt, temperature: Number(temperature.value), limit: Number(length.value) });
    } catch {
        finish('浏览器无法启动后台生成器。');
    }
});

stopButton.addEventListener('click', () => {
    worker?.postMessage({ type: 'stop', id: running });
    finish(`已停止 · ${tokenCount} tokens`);
    generateButton.focus();
});

copyButton.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(output.textContent);
        status.textContent = '已复制故事。';
    } catch {
        const selection = window.getSelection();
        selection?.selectAllChildren(output);
        output.focus();
        status.textContent = '已选中故事，可以手动复制。';
    }
});

temperature.addEventListener('input', () => { temperatureValue.value = Number(temperature.value).toFixed(1); });
for (const button of document.querySelectorAll('[data-prompt]')) {
    button.addEventListener('click', () => { promptField.value = button.dataset.prompt; });
}
