export const STEPS = 64;
export const TRACKS = [
    { id: 'lead', label: '旋律', color: '#e17b61', pitch: 72, program: 80 },
    { id: 'chord', label: '和弦', color: '#9d8ad4', pitch: 60, program: 89 },
    { id: 'bass', label: '贝斯', color: '#4db9aa', pitch: 36, program: 38 },
    { id: 'kick', label: '底鼓', color: '#ecb55f', pitch: 36 },
    { id: 'snare', label: '军鼓', color: '#e28da9', pitch: 38 },
    { id: 'hat', label: '踩镲', color: '#79a9ee', pitch: 42 },
];

export const STYLE_NAMES = { day: '轻快', dusk: '慢拍', night: '夜航' };
const SCALES = {
    day: [0, 2, 4, 7, 9, 12],
    dusk: [0, 2, 3, 7, 10, 12],
    night: [0, 3, 5, 7, 10, 12],
};
const FORMS = {
    day: { roots: [0, 7, 9, 5], minor: [false, false, true, false], tempo: 116 },
    dusk: { roots: [0, 8, 3, 10], minor: [true, false, false, false], tempo: 88 },
    night: { roots: [0, 3, 8, 10], minor: [true, false, false, false], tempo: 124 },
};

function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

export function noteName(pitch) {
    const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    return names[pitch % 12] + (Math.floor(pitch / 12) - 1);
}

export function emptyRows() {
    return TRACKS.map(() => Array(STEPS).fill(null));
}

export function makeSong(style, seed) {
    const next = random(seed);
    const form = FORMS[style];
    const scale = SCALES[style];
    const root = Math.floor(next() * 5);
    const rows = emptyRows();
    const motif = Array.from({ length: 4 }, () => Math.floor(next() * scale.length));
    const notes = [0, 3, 6, 10, 12, 14];
    for (let bar = 0; bar < 4; bar++) {
        const start = bar * 16;
        const chordPitch = 48 + root + form.roots[bar];
        const minor = form.minor[bar];
        const chord = [chordPitch, chordPitch + (minor ? 3 : 4), chordPitch + 7];
        for (const beat of [0, 8]) rows[1][start + beat] = chord;
        for (const beat of [0, 4, 8, 12]) rows[2][start + beat] = [chordPitch - 12 + (beat === 12 ? 7 : 0)];

        for (const [index, beat] of notes.entries()) {
            if (index === 1 && style === 'dusk' || index >= 4 && next() < .28) continue;
            const direction = bar === 1 ? 1 : bar === 2 ? -1 : 0;
            const degree = (motif[index % 4] + direction + scale.length) % scale.length;
            const pitch = 72 + root + scale[degree];
            rows[0][start + beat] = [pitch];
        }
        if (bar === 3) rows[0][start + 14] = [72 + root];

        const kick = style === 'night' ? [0, 4, 8, 12] : [0, 7, 8];
        for (const beat of kick) rows[3][start + beat] = [36];
        for (const beat of [4, 12]) rows[4][start + beat] = [38];
        for (let beat = 0; beat < 16; beat += 2) {
            if (style !== 'dusk' || beat % 4 === 2 || next() > .4) rows[5][start + beat] = [42];
        }
    }
    return { version: 1, rows, bpm: form.tempo + Math.floor(next() * 7), style, seed, muted: TRACKS.map(() => false) };
}

export function checkSong(input) {
    const validPitch = p => Number.isInteger(p) && p >= 0 && p < 128;
    const validCell = cell => cell === null || Array.isArray(cell) && cell.length > 0 && cell.length <= 4 && cell.every(validPitch);
    if (!input || input.version !== 1 || !Object.hasOwn(STYLE_NAMES, input.style) ||
        !Number.isInteger(input.bpm) || input.bpm < 60 || input.bpm > 180 ||
        !Array.isArray(input.rows) || input.rows.length !== TRACKS.length ||
        !input.rows.every(row => Array.isArray(row) && row.length === STEPS && row.every(validCell)) ||
        !Array.isArray(input.muted) || input.muted.length !== TRACKS.length ||
        !input.muted.every(mute => typeof mute === 'boolean')) return null;
    return input;
}

export function melodyLanes(row) {
    const low = Math.min(...row.filter(Boolean).map(cell => cell[0]));
    const high = Math.max(...row.filter(Boolean).map(cell => cell[0]));
    return row.map(cell => {
        if (!cell) return -1;
        return high === low ? 2 : Math.round(5 * (cell[0] - low) / (high - low));
    });
}
