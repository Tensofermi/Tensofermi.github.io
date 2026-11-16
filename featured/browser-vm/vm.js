import { localMedia, profiles, runtime } from './vm-profiles.js';

const el = id => document.getElementById('vm-' + id);
const config = el('config'), systems = el('systems'), start = el('start');
const pause = el('pause'), stop = el('stop'), localOptions = el('local-options');
const display = el('display'), terminal = el('console'), line = el('line');
const shortcuts = el('shortcuts'), workspace = el('workspace');

let active;
let cachedRuntime;

function say(message) {
    el('status').hidden = false;
    el('status').textContent = message;
}

function syncControls() {
    const running = active?.phase === 'running';
    const paused = active?.phase === 'paused';
    systems.disabled = !!active;
    systems.hidden = !!active;
    start.hidden = !!active;
    pause.hidden = !running && !paused;
    pause.textContent = paused ? '继续' : '暂停';
    pause.disabled = false;
    stop.hidden = !active;
    stop.disabled = active?.phase === 'closing';
    line.disabled = !running;
    el('send').disabled = !running || !!active?.sending;
    el('interrupt').disabled = !running;
    for (const button of shortcuts.querySelectorAll('button')) button.disabled = !running;
}

async function readFile(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`引导文件读取失败（HTTP ${response.status}）`);
    return response.arrayBuffer();
}

async function compile(signal) {
    try {
        return await WebAssembly.compile(await readFile(runtime.wasm, signal));
    } catch (error) {
        if (!(error instanceof WebAssembly.CompileError)) throw error;
        return WebAssembly.compile(await readFile(runtime.fallback, signal));
    }
}

async function loadRuntime(signal) {
    if (cachedRuntime) return cachedRuntime;
    const [{ V86 }, wasm, bios, vga] = await Promise.all([
        import(runtime.library), compile(signal), readFile(runtime.bios, signal), readFile(runtime.vga, signal),
    ]);
    if (signal.aborted) return;
    cachedRuntime = { V86, wasm, bios, vga };
    return cachedRuntime;
}

function localSettings(type) {
    const image = el('image').files[0];
    const media = localMedia[type];
    if (!image?.size) throw new Error('请选择一个有内容的镜像文件。');
    if (image.size > media.maxSize) throw new Error(`这种镜像最多支持 ${media.maxSize / 1048576} MiB。`);
    return { [type]: { buffer: image, async: type !== 'fda' }, boot_order: media.bootOrder };
}

function flushSerial(state) {
    if (state.frame) cancelAnimationFrame(state.frame);
    state.frame = 0;
    const follow = terminal.scrollHeight - terminal.clientHeight - terminal.scrollTop < 22;
    let text = state.tail + state.decoder.decode(Uint8Array.from(state.bytes), { stream: true });
    state.bytes.length = 0;
    const incomplete = /\x1b(?:\[[0-?]*[ -/]*)?$/.exec(text);
    state.tail = incomplete?.[0] ?? '';
    if (incomplete) text = text.slice(0, incomplete.index);
    text = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b./g, '').replace(/[\x00-\x07\x0B-\x1A\x1C-\x1F\x7F]/g, '');
    state.text += text;
    while (state.text.includes('\b')) state.text = state.text.replace(/[^\n\b]?\x08/g, '');
    state.text = state.text.slice(-48000);
    terminal.textContent = state.text;
    if (follow) terminal.scrollTop = terminal.scrollHeight;
}

function receiveSerial(state, byte) {
    if (active !== state || state.phase === 'closing') return;
    state.bytes.push(byte);
    if (state.bytes.length >= 8192) flushSerial(state);
    else if (!state.frame) state.frame = requestAnimationFrame(() => flushSerial(state));
}

async function release(state, message) {
    try {
        if (state.machine) await state.machine.destroy();
    } finally {
        active = undefined;
        workspace.hidden = true;
        terminal.textContent = '';
        display.replaceChildren();
        line.value = '';
        syncControls();
        say(message);
        start.focus();
    }
}

function close(state, message) {
    if (state !== active || state.phase === 'closing') return;
    state.phase = 'closing';
    state.closeMessage = message;
    state.controller.abort();
    if (state.frame) cancelAnimationFrame(state.frame);
    syncControls();
    if (!state.machine || state.loaded) void release(state, message);
}

async function boot(profile, extra) {
    const state = {
        controller: new AbortController(), phase: 'preparing', profile,
        bytes: [], text: '', tail: '', decoder: new TextDecoder(),
    };
    active = state;
    syncControls();
    say(`正在加载 ${profile.name} 的引导文件…`);
    stop.focus();

    try {
        const signal = state.controller.signal;
        const [engine, kernel] = await Promise.all([
            loadRuntime(signal), profile.startupFile ? readFile(profile.startupFile, signal) : undefined,
        ]);
        if (active !== state || signal.aborted) return;

        const { V86, wasm, bios, vga } = engine;
        terminal.hidden = !profile.serial;
        display.hidden = !!profile.serial;
        shortcuts.hidden = !profile.serial;
        el('line-label').textContent = profile.serial ? '终端命令' : '虚拟键盘输入';
        workspace.hidden = false;
        say(`正在启动 ${profile.name}…`);
        const machine = new V86({
            ...profile.options, ...extra,
            ...(kernel ? { bzimage: { buffer: kernel } } : {}),
            wasm_fn: async imports => (await WebAssembly.instantiate(wasm, imports)).exports,
            bios: { buffer: bios },
            vga_bios: { buffer: vga },
            screen: profile.serial ? {} : { container: display },
            disable_mouse: !!profile.serial,
            disable_keyboard: !!profile.serial,
            disable_speaker: true,
            autostart: false,
        });
        state.machine = machine;
        if (profile.serial) machine.add_listener('serial0-output-byte', byte => receiveSerial(state, byte));
        machine.add_listener('emulator-loaded', () => {
            state.loaded = true;
            if (signal.aborted) {
                void release(state, state.closeMessage);
                return;
            }
            state.phase = 'running';
            void machine.run();
            syncControls();
            say(profile.serial ? `${profile.name} 正在运行。出现提示符后就能输入命令。` : `${profile.name} 正在运行。点按屏幕使用实体键盘，也可以通过下方输入框发送文字。`);
            (profile.serial ? line : display).focus();
        });
    } catch (error) {
        close(state, `启动失败：${error.message}。请检查网络后重试。`);
    }
}

function syncMedia(profile) {
    localOptions.hidden = !profile.localMedia;
    el('elks-help').hidden = profile !== profiles.elks;
    el('image-format').hidden = profile.localMedia !== 'select';
    el('image-label').textContent = profile.localMedia === 'fda' ? '选择软盘镜像' : '镜像文件（最多 512 MiB）';
}

systems.addEventListener('change', event => {
    if (event.target.name === 'system') {
        el('image').value = '';
        syncMedia(profiles[event.target.value]);
    }
});
el('image').addEventListener('change', event => {
    if (event.target.files[0]?.name.toLowerCase().endsWith('.iso')) el('image-type').value = 'cdrom';
});
config.addEventListener('submit', event => {
    event.preventDefault();
    if (active) return;
    const profile = profiles[new FormData(config).get('system')];
    try {
        const type = profile.localMedia === 'select' ? el('image-type').value : profile.localMedia;
        void boot(profile, type ? localSettings(type) : {});
    } catch (error) {
        say(error.message);
        el('image').focus();
    }
});
stop.addEventListener('click', () => { if (active) close(active, '会话已结束，可以重新选择系统。'); });
pause.addEventListener('click', async () => {
    const state = active;
    if (!state?.loaded || state.phase === 'closing') return;
    pause.disabled = true;
    const paused = state.phase === 'paused';
    if (paused) await state.machine.run();
    else await state.machine.stop();
    if (state !== active || state.phase === 'closing') return;
    state.phase = paused ? 'running' : 'paused';
    say(paused ? '虚拟机已继续运行。' : '虚拟机已暂停。');
    syncControls();
});

display.addEventListener('focus', () => active?.machine?.keyboard_set_enabled(true));
display.addEventListener('blur', () => active?.machine?.keyboard_set_enabled(false));

async function sendLine(text) {
    const state = active;
    if (state?.phase !== 'running' || state.sending) return;
    if (state.profile.serial) {
        state.machine.serial_send_bytes(0, new TextEncoder().encode(`${text}\n`));
        return;
    }
    const ascii = text.replace(/[^\x20-\x7e]/g, '');
    if (ascii !== text) say('虚拟键盘支持美式键盘字符。');
    state.sending = true;
    syncControls();
    try {
        await state.machine.keyboard_send_text(`${ascii}\n`, 8);
    } finally {
        state.sending = false;
        if (active === state) syncControls();
    }
}

el('command').addEventListener('submit', event => {
    event.preventDefault();
    void sendLine(line.value);
    line.value = '';
});
shortcuts.addEventListener('click', event => {
    const command = event.target.dataset.command;
    if (command) void sendLine(command);
});
el('interrupt').addEventListener('click', () => {
    if (active?.phase !== 'running') return;
    if (active.profile.serial) active.machine.serial0_send('\x03');
    else active.machine.keyboard_send_scancodes([0x1d, 0x2e, 0xae, 0x9d]);
});

start.disabled = false;
syncControls();
