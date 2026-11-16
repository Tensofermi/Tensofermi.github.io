// Browser implementation of the llama2.c v0 checkpoint format. See UPSTREAM-LICENSE.txt.

export function readModel(buffer) {
    const header = new DataView(buffer);
    const fields = Array.from({ length: 7 }, (_, index) => header.getInt32(index * 4, true));
    const [dim, hidden, layers, heads, kvHeads, vocab, context] = fields;
    if (`${fields}` !== '64,172,5,8,4,512,512') {
        throw new Error('模型文件与 TinyStories 260K 的格式不匹配。');
    }

    const kvDim = dim * kvHeads / heads;
    const headSize = dim / heads;
    const weights = new Float32Array(buffer, 28);
    let offset = 0;
    const take = length => {
        const start = offset;
        offset += length;
        return weights.subarray(start, offset);
    };

    const embedding = take(vocab * dim);
    const attentionNorm = take(layers * dim);
    const query = take(layers * dim * dim);
    const key = take(layers * dim * kvDim);
    const value = take(layers * dim * kvDim);
    const attentionOut = take(layers * dim * dim);
    const feedForwardNorm = take(layers * dim);
    const gate = take(layers * hidden * dim);
    const feedForwardOut = take(layers * dim * hidden);
    const up = take(layers * hidden * dim);
    const finalNorm = take(dim);
    offset += context * headSize; // Legacy RoPE cosine and sine tables.
    if (offset !== weights.length) throw new Error('模型权重文件不完整。');

    return {
        dim, hidden, layers, heads, kvHeads, vocab, context, kvDim, headSize, embedding, attentionNorm,
        query, key, value, attentionOut, feedForwardNorm, gate, feedForwardOut, up, finalNorm,
    };
}

export function readTokenizer(buffer, vocabSize) {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const pieces = [];
    const scores = new Float32Array(vocabSize);
    const ids = new Map();
    const maxBytes = view.getInt32(0, true);
    let offset = 4;

    for (let token = 0; token < vocabSize; token++) {
        scores[token] = view.getFloat32(offset, true);
        const length = view.getInt32(offset + 4, true);
        if (length < 0 || length > maxBytes) throw new Error('词表中的 token 长度无效。');
        offset += 8;
        const piece = decoder.decode(new Uint8Array(buffer, offset, length));
        pieces.push(piece);
        ids.set(piece, token);
        offset += length;
    }
    if (offset !== buffer.byteLength || !ids.has(' ')) throw new Error('词表文件不完整。');

    return {
        encode(text) {
            const tokens = [1]; // BOS
            if (text) tokens.push(ids.get(' '));
            for (const char of text) {
                const token = ids.get(char);
                if (token !== undefined) tokens.push(token);
                else for (const byte of encoder.encode(char)) tokens.push(byte + 3);
            }
            for (;;) {
                let bestIndex = -1;
                let bestToken;
                let bestScore = -Infinity;
                for (let index = 0; index + 1 < tokens.length; index++) {
                    const token = ids.get(pieces[tokens[index]] + pieces[tokens[index + 1]]);
                    if (token !== undefined && scores[token] > bestScore) {
                        bestIndex = index;
                        bestToken = token;
                        bestScore = scores[token];
                    }
                }
                if (bestIndex < 0) return tokens;
                tokens.splice(bestIndex, 2, bestToken);
            }
        },
        decodeToken(token, stream) {
            const piece = pieces[token];
            const byte = /^<0x([0-9a-f]{2})>$/i.exec(piece);
            const bytes = byte ? Uint8Array.of(Number.parseInt(byte[1], 16)) : encoder.encode(piece);
            return stream.decode(bytes, { stream: true }).replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
        },
    };
}

function matvec(out, input, weights, offset, columns, rows, outOffset = 0) {
    for (let row = 0; row < rows; row++) {
        let sum = 0;
        const start = offset + row * columns;
        for (let column = 0; column < columns; column++) sum += weights[start + column] * input[column];
        out[outOffset + row] = sum;
    }
}

function rmsNorm(out, input, weights, offset) {
    let squares = 0;
    for (const value of input) squares += value * value;
    const scale = 1 / Math.sqrt(squares / input.length + 1e-5);
    for (let i = 0; i < input.length; i++) out[i] = input[i] * weights[offset + i] * scale;
}

function softmax(values, length) {
    let max = values[0];
    for (let i = 1; i < length; i++) max = Math.max(max, values[i]);
    let sum = 0;
    for (let i = 0; i < length; i++) {
        const value = Math.exp(values[i] - max);
        values[i] = value;
        sum += value;
    }
    for (let i = 0; i < length; i++) values[i] /= sum;
}

function rotatePairs(vector, offset, length, headSize, cos, sin) {
    for (let index = 0; index < length; index += 2) {
        const pair = (index % headSize) / 2;
        const i = offset + index;
        const a = vector[i];
        const b = vector[i + 1];
        vector[i] = a * cos[pair] - b * sin[pair];
        vector[i + 1] = a * sin[pair] + b * cos[pair];
    }
}

export function createDecoder(model) {
    const { dim, hidden, layers, heads, kvHeads, kvDim, vocab, context, headSize } = model;
    const state = new Float32Array(dim);
    const mixed = new Float32Array(dim);
    const residual = new Float32Array(dim);
    const query = new Float32Array(dim);
    const gate = new Float32Array(hidden);
    const up = new Float32Array(hidden);
    const scores = new Float32Array(context);
    const logits = new Float32Array(vocab);
    const keys = new Float32Array(layers * context * kvDim);
    const values = new Float32Array(keys.length);
    const cos = new Float32Array(headSize / 2);
    const sin = new Float32Array(cos.length);
    const frequency = Float64Array.from(cos, (_, i) => 10000 ** (-2 * i / headSize));
    const queriesPerKey = heads / kvHeads;
    const attentionScale = 1 / Math.sqrt(headSize);

    return (token, position) => {
        if (position >= context) throw new Error('已超过模型的上下文长度。');
        state.set(model.embedding.subarray(token * dim, (token + 1) * dim));
        for (let i = 0; i < frequency.length; i++) {
            const angle = position * frequency[i];
            cos[i] = Math.cos(angle);
            sin[i] = Math.sin(angle);
        }

        for (let layer = 0; layer < layers; layer++) {
            const cacheBase = layer * context * kvDim;
            const cacheSlot = cacheBase + position * kvDim;
            rmsNorm(mixed, state, model.attentionNorm, layer * dim);
            matvec(query, mixed, model.query, layer * dim * dim, dim, dim);
            matvec(keys, mixed, model.key, layer * kvDim * dim, dim, kvDim, cacheSlot);
            matvec(values, mixed, model.value, layer * kvDim * dim, dim, kvDim, cacheSlot);
            rotatePairs(query, 0, dim, headSize, cos, sin);
            rotatePairs(keys, cacheSlot, kvDim, headSize, cos, sin);

            mixed.fill(0);
            for (let head = 0; head < heads; head++) {
                const queryBase = head * headSize;
                const keyBase = cacheBase + Math.floor(head / queriesPerKey) * headSize;
                for (let time = 0; time <= position; time++) {
                    const entry = keyBase + time * kvDim;
                    let dot = 0;
                    for (let i = 0; i < headSize; i++) dot += query[queryBase + i] * keys[entry + i];
                    scores[time] = dot * attentionScale;
                }
                softmax(scores, position + 1);
                for (let time = 0; time <= position; time++) {
                    const entry = keyBase + time * kvDim;
                    for (let i = 0; i < headSize; i++) mixed[queryBase + i] += scores[time] * values[entry + i];
                }
            }
            matvec(residual, mixed, model.attentionOut, layer * dim * dim, dim, dim);
            for (let i = 0; i < dim; i++) state[i] += residual[i];

            rmsNorm(mixed, state, model.feedForwardNorm, layer * dim);
            matvec(gate, mixed, model.gate, layer * hidden * dim, dim, hidden);
            matvec(up, mixed, model.up, layer * hidden * dim, dim, hidden);
            for (let i = 0; i < hidden; i++) gate[i] = gate[i] * up[i] / (1 + Math.exp(-gate[i]));
            matvec(residual, gate, model.feedForwardOut, layer * dim * hidden, hidden, dim);
            for (let i = 0; i < dim; i++) state[i] += residual[i];
        }
        rmsNorm(mixed, state, model.finalNorm, 0);
        matvec(logits, mixed, model.embedding, 0, dim, vocab);
        return logits;
    };
}

export function selectToken(logits, temperature) {
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    if (temperature === 0) return best;

    const ids = Array.from(logits.keys());
    ids.sort((a, b) => logits[b] - logits[a]);
    const weights = Float64Array.from(ids, i => Math.exp((logits[i] - logits[best]) / temperature));
    const cutoff = weights.reduce((sum, value) => sum + value, 0) * 0.9;
    let cumulative = 0;
    let end = 0;
    while (cumulative < cutoff) cumulative += weights[end++];
    let draw = Math.random() * cumulative;
    for (let i = 0; i < end; i++) {
        draw -= weights[i];
        if (draw < 0) return ids[i];
    }
    return ids[end - 1];
}
