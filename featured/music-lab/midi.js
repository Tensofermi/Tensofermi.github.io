import { emptyRows, STEPS, TRACKS } from './score.js';

export const MAX_MIDI_BYTES = 512 * 1024;
const EXPORT_PPQ = 480;
const DRUMS = new Map([[35, 3], [36, 3], [37, 4], [38, 4], [39, 4], [40, 4], [42, 5], [44, 5], [46, 5]]);
const DURATION = [1.5, 6.5, 2.75, 0.75, 0.75, 0.5]; // In sixteenth notes.

class Reader {
    constructor(bytes) {
        this.bytes = bytes;
        this.position = 0;
    }

    take(length) {
        const end = this.position + length;
        if (end > this.bytes.length) throw new Error('MIDI 文件不完整。');
        const part = this.bytes.subarray(this.position, end);
        this.position = end;
        return part;
    }

    number(length) {
        let value = 0;
        for (const byte of this.take(length)) value = value * 256 + byte;
        return value;
    }

    variableLength() {
        let value = 0;
        for (let i = 0; i < 4; i++) {
            const byte = this.number(1);
            value = value * 128 + (byte & 127);
            if (byte < 128) return value;
        }
        throw new Error('MIDI 文件含有无效的时间或事件长度。');
    }

    chunk() {
        const name = String.fromCharCode(...this.take(4));
        return { name, reader: new Reader(this.take(this.number(4))) };
    }

    get done() { return this.position === this.bytes.length; }
}

function readTrack(track) {
    let time = 0;
    let tempo;
    let status;
    let name = '';
    const parts = new Map();
    const programs = Array(16).fill(0);
    while (!track.done) {
        time += track.variableLength();
        const first = track.number(1);
        if (first === 0xff) {
            status = undefined;
            const type = track.number(1);
            const data = track.take(track.variableLength());
            if (type === 0x2f) break;
            if (type === 3) name = new TextDecoder().decode(data);
            if (type === 0x51 && time === 0 && data.length === 3) {
                const usec = data[0] * 65536 + data[1] * 256 + data[2];
                if (usec) tempo = Math.round(60000000 / usec);
            }
            continue;
        }
        if (first === 0xf0 || first === 0xf7) {
            status = undefined;
            track.take(track.variableLength());
            continue;
        }
        if (first >= 0x80) status = first;
        if (status === undefined || status >= 0xf0) throw new Error('MIDI 文件含有无效的通道事件。');
        const channel = status & 15;
        const kind = status >> 4;
        const pitch = first < 128 ? first : track.number(1);
        const value = kind === 0xc || kind === 0xd ? 0 : track.number(1);
        if (pitch > 127 || value > 127) throw new Error('MIDI 事件的数据字节无效。');

        if (kind === 0xc) programs[channel] = pitch;
        if (kind !== 9 || value === 0) continue;

        // The editor represents onsets on a fixed grid, so note-off and sustain are not used here.
        let part = parts.get(channel);
        if (!part) {
            part = { channel, program: programs[channel], notes: [] };
            parts.set(channel, part);
        }
        part.notes.push({ time, pitch });
    }
    return { tempo, parts: Array.from(parts.values(), part => ({ ...part, name })) };
}

function parseFile(buffer) {
    if (buffer.byteLength > MAX_MIDI_BYTES) throw new Error('请选择小于 512 KB 的 MIDI 文件。');
    const file = new Reader(new Uint8Array(buffer));
    const { name, reader: header } = file.chunk();
    if (name !== 'MThd') throw new Error('请选择标准 MIDI 文件（.mid 或 .midi）。');
    const format = header.number(2);
    const trackCount = header.number(2);
    const ppq = header.number(2);
    if (![0, 1].includes(format) || !trackCount || (format === 0 && trackCount !== 1) || !ppq || ppq >= 0x8000) {
        throw new Error('支持使用拍点计时的 0 型或 1 型 MIDI 文件。');
    }
    const parts = [];
    let tempo;
    let read = 0;
    while (read < trackCount) {
        const chunk = file.chunk();
        if (chunk.name !== 'MTrk') continue;
        const track = readTrack(chunk.reader);
        for (const part of track.parts) parts.push(part);
        tempo ??= track.tempo;
        read++;
    }
    return { parts, ppq, bpm: tempo ?? 120 };
}

function place(rows, track, step, pitch) {
    if (track === undefined || step >= STEPS) return;
    const cell = rows[track][step] ?? (rows[track][step] = []);
    if (cell.includes(pitch)) return;
    cell.push(pitch);
    cell.sort(track === 0 ? (a, b) => b - a : (a, b) => a - b);
    if (cell.length > 4) cell.pop();
}

export function midiToSong(buffer) {
    const { parts, ppq, bpm } = parseFile(buffer);
    const rows = emptyRows();
    let foundLead = false;
    for (const part of parts) {
        const isBass = (part.program >= 32 && part.program <= 39) || /bass|贝斯|低音/i.test(part.name);
        const isChord = /chord|pad|和弦/i.test(part.name);
        const role = isBass ? 2 : isChord || foundLead ? 1 : 0;
        for (const note of part.notes) {
            const track = part.channel === 9 ? DRUMS.get(note.pitch) : role;
            const step = Math.round(note.time * 4 / ppq);
            place(rows, track, step, track >= 3 ? TRACKS[track].pitch : note.pitch);
        }
        if (role === 0 && part.channel !== 9 && rows[0].some(Boolean)) foundLead = true;
    }
    if (!rows.some(row => row.some(Boolean))) throw new Error('前四小节里没有可导入的音符。');
    return { version: 1, rows, bpm: Math.min(180, Math.max(60, bpm)), style: 'day', seed: 0, muted: TRACKS.map(() => false) };
}

function variableBytes(value) {
    const result = [value & 127];
    while ((value >>= 7) > 0) result.unshift((value & 127) | 128);
    return result;
}

function makeChunk(id, bytes) {
    const chunk = new Uint8Array(8 + bytes.length);
    chunk.set(new TextEncoder().encode(id));
    new DataView(chunk.buffer).setUint32(4, bytes.length);
    chunk.set(bytes, 8);
    return chunk;
}

function writeTrack(row, track) {
    const isDrum = track >= 3;
    const channel = isDrum ? 9 : track;
    const meta = TRACKS[track];
    const name = new TextEncoder().encode(meta.label);
    const bytes = [0, 0xff, 3, ...variableBytes(name.length), ...name];
    if (!isDrum) bytes.push(0, 0xc0 | channel, meta.program);
    const events = [];
    const lastOff = new Map();
    for (let step = 0; step < STEPS; step++) {
        for (const pitch of new Set(row[step] ?? [])) {
            const at = step * EXPORT_PPQ / 4;
            const end = at + Math.round(DURATION[track] * EXPORT_PPQ / 4);
            const previous = lastOff.get(pitch);
            if (previous && previous.time > at) previous.time = at;
            const off = { time: end, pitch, on: false };
            events.push({ time: at, pitch, on: true }, off);
            lastOff.set(pitch, off);
        }
    }
    events.sort((a, b) => a.time - b.time || Number(a.on) - Number(b.on));
    let time = 0;
    for (const event of events) {
        bytes.push(...variableBytes(event.time - time), (event.on ? 0x90 : 0x80) | channel, event.pitch, event.on ? 92 : 0);
        time = event.time;
    }
    bytes.push(0, 0xff, 0x2f, 0);
    return makeChunk('MTrk', bytes);
}

export function songToMidi(song) {
    const usec = Math.round(60000000 / song.bpm);
    const header = makeChunk('MThd', [0, 1, 0, TRACKS.length + 1, EXPORT_PPQ >> 8, EXPORT_PPQ & 255]);
    const conductor = makeChunk('MTrk', [
        0, 0xff, 0x51, 3, usec >> 16, (usec >> 8) & 255, usec & 255,
        0, 0xff, 0x58, 4, 4, 2, 24, 8,
        0, 0xff, 0x2f, 0,
    ]);
    const chunks = [header, conductor, ...song.rows.map(writeTrack)];
    const file = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        file.set(chunk, offset);
        offset += chunk.length;
    }
    return file;
}
