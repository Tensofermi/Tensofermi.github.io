import { Tokenizer } from "./tokenizers.mjs";

const utf8 = new TextEncoder();
// GPT-2 byte-level BPE maps every byte to a printable vocabulary character.
const literal = (byte) => (byte >= 33 && byte <= 126) || (byte >= 161 && byte <= 172) || (byte >= 174);
const glyphBytes = new Map();
let extra = 0;
for (let byte = 0; byte <= 255; byte++) {
    glyphBytes.set(String.fromCharCode(literal(byte) ? byte : 256 + extra++), byte);
}

export function createTokenizer(config) {
    const native = new Tokenizer(config, {});
    const added = new Set(config.added_tokens.map(({ id }) => id));

    function encode(text) {
        const encoded = native.encode(text, { add_special_tokens: false });
        const original = utf8.encode(text);
        const byteToChar = new Uint32Array(original.length);
        let byteCursor = 0;
        let index = 0;
        for (const character of text) {
            const size = utf8.encode(character).length;
            byteToChar.fill(index++, byteCursor, byteCursor + size);
            byteCursor += size;
        }
        let offset = 0;
        const offsets = encoded.tokens.map((piece, index) => {
            const bytes = added.has(encoded.ids[index]) ? utf8.encode(piece) : Array.from(piece, (glyph) => glyphBytes.get(glyph));
            const start = offset;
            for (const byte of bytes) {
                if (byte !== original[offset++]) throw new Error("分词结果无法对齐到原文，已停止标注来源。");
            }
            return [byteToChar[start], byteToChar[offset - 1] + 1];
        });
        if (offset !== original.length) throw new Error("分词后字节长度与原文不一致。");
        return { ids: encoded.ids, tokens: encoded.tokens, offsets };
    }

    return { encode, tokenToId: (text) => native.token_to_id(text) ?? null };
}
