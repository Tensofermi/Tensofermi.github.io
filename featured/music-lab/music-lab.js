import { Synth } from './audio.js';
import { checkSong, makeSong, melodyLanes, noteName, STEPS, TRACKS } from './score.js';

const BAR = 16;
const KEYS = ['S', 'D', 'F', 'J', 'K', 'L'];
const WINDOW = .15;
const STORAGE_KEY = 'featured.music.song';
const $$ = id => document.getElementById(id);
const synth = new Synth();
const canvas = $$('notes');
const canvasContext = canvas.getContext('2d');
const cells = TRACKS.map(() => []);
const bars = [];
const stepNumbers = [];
const trackButtons = [];
const laneButtons = [];
const flashTimers = [];
let song = restoreSong();
let bar = 0;
let selection = null;
let mode = 'compose';
let transport = null;
let starting = false;
let runId = 0;
let animation = 0;
let shownStep = -1;
let storageTimer = null;
let canvasWidth = 0;
let canvasHeight = 0;

function announce(text) {
    $$('music-status').textContent = text;
}

function restoreSong() {
    try {
        const saved = checkSong(JSON.parse(localStorage.getItem(STORAGE_KEY)));
        if (saved) return saved;
    } catch { /* Invalid or unavailable local storage. */ }
    return makeSong('day', 8201);
}

function save() {
    window.clearTimeout(storageTimer);
    storageTimer = null;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(song));
    } catch {
        announce('此浏览器无法保存修改，可以导出 MIDI 保留音符。');
    }
}

function queueSave() {
    window.clearTimeout(storageTimer);
    storageTimer = window.setTimeout(save, 200);
}

function button(label, action, cssClass) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (cssClass) element.className = cssClass;
    element.addEventListener('click', action);
    return element;
}

function buildGrid() {
    for (let index = 0; index < 4; index++) {
        const element = button(String(index + 1), () => {
            bar = index;
            selection = null;
            paintGrid();
        });
        element.setAttribute('aria-label', `第 ${index + 1} 小节`);
        bars.push(element);
        $$('bars').append(element);
    }
    const grid = $$('sequence');
    grid.append(document.createElement('div'));
    for (let step = 0; step < BAR; step++) {
        const number = document.createElement('span');
        number.className = 'step-number';
        number.textContent = String(step + 1);
        number.setAttribute('aria-hidden', 'true');
        stepNumbers.push(number);
        grid.append(number);
    }
    for (const [track, { label, color }] of TRACKS.entries()) {
        const mute = button(label, () => {
            song.muted[track] = !song.muted[track];
            paintGrid();
            queueSave();
        }, 'track-button');
        const name = document.createElement('span');
        const state = document.createElement('span');
        name.textContent = label;
        mute.replaceChildren(name, state);
        mute.setAttribute('aria-label', `${label}静音`);
        trackButtons.push({ mute, state });
        grid.append(mute);
        for (let step = 0; step < BAR; step++) {
            const cell = button('', () => editStep(track, BAR * bar + step), 'step');
            cell.style.setProperty('--track-color', color);
            cell.toggleAttribute('data-beat', step % 4 === 0);
            cells[track].push(cell);
            grid.append(cell);
        }
    }

    for (const [index, key] of KEYS.entries()) {
        const element = button(key, event => { if (event.detail === 0) playKey(index); });
        element.addEventListener('pointerdown', event => {
            if (event.button === 0) playKey(index);
        });
        element.setAttribute('aria-label', `演奏 ${key} 轨道`);
        laneButtons.push(element);
        $$('playing-keys').append(element);
    }
}

function editStep(track, step) {
    const row = song.rows[track];
    if (track >= 3) {
        row[step] = row[step] ? null : [TRACKS[track].pitch];
    } else {
        selection = { track, step };
        if (!row[step]) row[step] = track === 1 ? [60, 64, 67] : [TRACKS[track].pitch];
    }
    paintGrid();
    queueSave();
}

function paintGrid() {
    for (let index = 0; index < bars.length; index++) bars[index].setAttribute('aria-pressed', index === bar);
    for (const [track, item] of TRACKS.entries()) {
        const { mute, state } = trackButtons[track];
        mute.setAttribute('aria-pressed', song.muted[track]);
        mute.toggleAttribute('data-muted', song.muted[track]);
        state.textContent = song.muted[track] ? '静音' : '开';
        for (let step = 0; step < BAR; step++) {
            const index = bar * BAR + step;
            const note = song.rows[track][index];
            const cell = cells[track][step];
            const name = note && track < 3 ? noteName(note[0]) : null;
            cell.textContent = name ?? (note ? '●' : '');
            cell.toggleAttribute('data-on', !!note);
            cell.toggleAttribute('data-muted', song.muted[track]);
            cell.toggleAttribute('data-selected', selection?.track === track && selection.step === index);
            cell.setAttribute('aria-pressed', track < 3 ? selection?.track === track && selection.step === index : !!note);
            cell.setAttribute('aria-label', `${item.label} · 第 ${step + 1} 步 · ${name ?? (note ? '开启' : '空')}`);
        }
    }
    paintEditor();
    paintPlayhead(shownStep, true);
}

function paintEditor() {
    const note = selection && song.rows[selection.track][selection.step];
    $$('note-editor').hidden = !note;
    if (!note) return;
    const { track, step } = selection;
    const pitch = $$('pitch');
    $$('selection').textContent = `${TRACKS[track].label} · 第 ${step % BAR + 1} 步`;
    $$('pitch-label').textContent = note.length > 1 ? '基准音（移调）' : '音高';
    const min = Math.max(0, note[0] - Math.min(...note));
    const max = Math.min(127, note[0] + 127 - Math.max(...note));
    if (pitch.dataset.range !== `${min}-${max}`) {
        const options = document.createDocumentFragment();
        for (let value = min; value <= max; value++) options.append(new Option(noteName(value), String(value)));
        pitch.replaceChildren(options);
        pitch.dataset.range = `${min}-${max}`;
    }
    pitch.value = String(note[0]);
}

function paintPlayhead(step, force = false) {
    if (!force && step === shownStep) return;
    const previous = shownStep;
    shownStep = step;
    const barAt = value => Math.floor(value / BAR);
    const changeColumn = (column, active) => {
        stepNumbers[column].toggleAttribute('data-playing', active);
        for (const row of cells) row[column].toggleAttribute('data-playing', active);
    };
    if (force) {
        bars.forEach(element => element.removeAttribute('data-playing'));
        stepNumbers.forEach((_, column) => changeColumn(column, false));
    } else if (previous >= 0) {
        bars[barAt(previous)].removeAttribute('data-playing');
        if (barAt(previous) === bar) changeColumn(previous % BAR, false);
    }
    if (step >= 0) {
        bars[barAt(step)].setAttribute('data-playing', '');
        if (barAt(step) === bar) changeColumn(step % BAR, true);
    }
}

function refreshControls() {
    const busy = !!transport || starting;
    $$('play').disabled = busy;
    $$('stop').disabled = !busy;
    $$('tempo').disabled = busy;
}

function stop(message = '已停止。') {
    runId++;
    starting = false;
    if (transport) window.clearInterval(transport.timer);
    transport = null;
    cancelAnimationFrame(animation);
    synth.silence();
    paintPlayhead(-1);
    refreshControls();
    drawNotes();
    announce(message);
}

async function start() {
    if (transport || starting) return;
    const lanes = mode === 'perform' ? melodyLanes(song.rows[0]) : null;
    if (lanes && !lanes.some(lane => lane >= 0)) {
        announce('请先为旋律轨添加至少一个音符。');
        return;
    }
    const id = ++runId;
    starting = true;
    refreshControls();
    try {
        const context = await synth.unlock();
        if (id !== runId) return;
        const startAt = context.currentTime + (lanes ? 1.25 : .08);
        transport = {
            startAt, secondsPerStep: 15 / song.bpm, cursor: 0, lanes, hits: 0, misses: 0,
            judgments: new Uint8Array(STEPS), nextMiss: 0, timer: window.setInterval(schedule, 25),
        };
        $$('hits').textContent = '0';
        $$('missed').textContent = '0';
        announce(lanes ? '准备跟弹。' : '正在循环播放。');
        schedule();
        animation = requestAnimationFrame(paintFrame);
    } catch (error) {
        if (id === runId) stop(error.message);
    } finally {
        if (id === runId) {
            starting = false;
            refreshControls();
        }
    }
}

function schedule() {
    const run = transport;
    if (!run) return;
    const now = synth.context.currentTime;
    const earliest = Math.max(0, Math.ceil((now - run.startAt - .018) / run.secondsPerStep));
    run.cursor = Math.max(run.cursor, earliest);
    while (!run.lanes || run.cursor < STEPS) {
        const at = run.startAt + run.cursor * run.secondsPerStep;
        if (at > now + .12) break;
        const step = run.cursor % STEPS;
        for (let track = run.lanes ? 1 : 0; track < TRACKS.length; track++) {
            const note = song.rows[track][step];
            if (!song.muted[track] && note) synth.play(track, note, at, run.secondsPerStep, step % 4 ? .70 : .95);
        }
        run.cursor++;
    }
}

function updateScore(run) {
    $$('hits').textContent = String(run.hits);
    $$('missed').textContent = String(run.misses);
}

function paintFrame() {
    const run = transport;
    if (!run) return;
    const elapsed = synth.heardTime() - run.startAt;
    const step = Math.floor(elapsed / run.secondsPerStep);
    if (run.lanes) {
        const previous = run.misses;
        while (run.nextMiss < STEPS && elapsed > run.nextMiss * run.secondsPerStep + WINDOW) {
            const next = run.nextMiss++;
            if (run.lanes[next] >= 0 && run.judgments[next] === 0) {
                run.judgments[next] = 2;
                run.misses++;
            }
        }
        if (run.misses !== previous) updateScore(run);
        if (elapsed >= STEPS * run.secondsPerStep + WINDOW) {
            stop(`跟弹完成 · 命中 ${run.hits} · 漏拍 ${run.misses}`);
            return;
        }
        drawNotes(elapsed);
    } else if (step >= 0) paintPlayhead(step % STEPS);
    animation = requestAnimationFrame(paintFrame);
}

function playKey(lane) {
    const run = transport;
    if (!run?.lanes) return;
    const position = synth.heardTime() - run.startAt;
    let best = -1;
    let error = WINDOW;
    for (let step = Math.max(0, Math.ceil((position - WINDOW) / run.secondsPerStep)); step < STEPS; step++) {
        const time = step * run.secondsPerStep;
        if (time > position + WINDOW) break;
        const offset = Math.abs(time - position);
        if (run.lanes[step] === lane && run.judgments[step] === 0 && offset <= error) {
            best = step;
            error = offset;
        }
    }
    const key = laneButtons[lane];
    key.toggleAttribute('data-hit', best >= 0);
    key.toggleAttribute('data-miss', best < 0);
    window.clearTimeout(flashTimers[lane]);
    flashTimers[lane] = window.setTimeout(() => {
        key.removeAttribute('data-hit');
        key.removeAttribute('data-miss');
    }, 130);
    if (best >= 0) {
        run.judgments[best] = 1;
        run.hits++;
        const note = song.rows[0][best];
        if (note) synth.play(0, note, synth.context.currentTime + .004, run.secondsPerStep);
        updateScore(run);
    }
}

function resizeCanvas() {
    if (mode !== 'perform' || !canvasContext) return;
    const rectangle = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasWidth = rectangle.width;
    canvasHeight = rectangle.height;
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!transport) drawNotes();
}

function drawNotes(elapsed = NaN) {
    if (mode !== 'perform' || !canvasContext || !canvasWidth) return;
    const laneWidth = canvasWidth / KEYS.length;
    const hitY = canvasHeight - 26;
    const ctx = canvasContext;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    for (const [lane] of KEYS.entries()) {
        ctx.fillStyle = lane % 2 ? '#132035' : '#17263b';
        ctx.fillRect(lane * laneWidth + 1, 0, laneWidth - 2, canvasHeight);
    }
    ctx.fillStyle = '#f6d167';
    ctx.fillRect(0, hitY, canvasWidth, 2);
    const run = transport;
    if (!run?.lanes || !Number.isFinite(elapsed)) return;
    const speed = (hitY - 14) / 1.25;
    const from = Math.max(0, Math.floor((elapsed - WINDOW) / run.secondsPerStep));
    const to = Math.min(STEPS - 1, Math.ceil((elapsed + 1.35) / run.secondsPerStep));
    ctx.fillStyle = TRACKS[0].color;
    for (let step = from; step <= to; step++) {
        const lane = run.lanes[step];
        if (lane < 0 || run.judgments[step]) continue;
        const y = hitY - (step * run.secondsPerStep - elapsed) * speed;
        ctx.fillRect(lane * laneWidth + 7, y - 5, laneWidth - 14, 10);
    }
}

function setMode(value) {
    if (mode === value) return;
    if (transport || starting) stop();
    mode = value;
    const performing = mode === 'perform';
    $$('compose').setAttribute('aria-pressed', !performing);
    $$('perform').setAttribute('aria-pressed', performing);
    $$('compose-panel').hidden = performing;
    $$('perform-panel').hidden = !performing;
    $$('play').textContent = performing ? '开始跟弹' : '播放循环';
    if (performing) resizeCanvas();
}

function newSong(next) {
    stop();
    song = next;
    bar = 0;
    selection = null;
    $$('style').value = song.style;
    $$('tempo').value = song.bpm;
    paintGrid();
    queueSave();
}

$$('compose').addEventListener('click', () => setMode('compose'));
$$('perform').addEventListener('click', () => setMode('perform'));
$$('play').addEventListener('click', start);
$$('stop').addEventListener('click', () => {
    stop();
    $$('play').focus();
});
$$('tempo').addEventListener('change', event => {
    const value = event.target.valueAsNumber;
    song.bpm = Number.isFinite(value) ? Math.min(180, Math.max(60, Math.round(value))) : song.bpm;
    event.target.value = song.bpm;
    queueSave();
});
$$('pitch').addEventListener('change', event => {
    const { track, step } = selection;
    const note = song.rows[track][step];
    const change = Number(event.target.value) - note[0];
    song.rows[track][step] = note.map(pitch => pitch + change);
    paintGrid();
    queueSave();
});
$$('remove').addEventListener('click', () => {
    const { track, step } = selection;
    song.rows[track][step] = null;
    selection = null;
    paintGrid();
    cells[track][step % BAR].focus();
    queueSave();
});
$$('preview').addEventListener('click', async () => {
    const { track, step } = selection;
    const note = song.rows[track][step];
    try {
        const context = await synth.unlock();
        synth.play(track, note, context.currentTime + .012, 15 / song.bpm);
    } catch (error) {
        announce(error.message);
    }
});
$$('generate').addEventListener('click', () => {
    newSong(makeSong($$('style').value, Math.floor(Math.random() * 4294967296)));
    announce('已生成新的四小节循环。');
});
$$('import').addEventListener('click', () => $$('midi-file').click());
$$('midi-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
        announce('正在读取 MIDI…');
        const { midiToSong, MAX_MIDI_BYTES } = await import('./midi.js');
        if (file.size > MAX_MIDI_BYTES) throw new Error('请选择 512 KiB 以下的 MIDI 文件。');
        newSong(midiToSong(await file.arrayBuffer()));
        announce('已导入前四小节。音符已对齐到十六分音符，并使用本站音色。');
    } catch (error) {
        announce(`导入失败。${error.message}`);
    }
});
$$('export').addEventListener('click', async () => {
    try {
        const { songToMidi } = await import('./midi.js');
        const url = URL.createObjectURL(new Blob([songToMidi(song)], { type: 'audio/midi' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'music-lab.mid';
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        announce('已导出 MIDI。');
    } catch (error) {
        announce(`导出失败。${error.message}`);
    }
});
window.addEventListener('keydown', event => {
    if (mode !== 'perform' || event.repeat || event.ctrlKey || event.metaKey || event.altKey ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
    const lane = KEYS.indexOf(event.key.toUpperCase());
    if (lane < 0) return;
    event.preventDefault();
    playKey(lane);
});
window.addEventListener('pagehide', () => {
    if (storageTimer !== null) save();
    if (transport || starting) stop();
});
if (canvasContext) new ResizeObserver(resizeCanvas).observe(canvas);
$$('tempo').value = song.bpm;
$$('style').value = song.style;
buildGrid();
paintGrid();
refreshControls();
