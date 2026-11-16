import { createTokenizer } from "./reference/offsets.mjs";

const base = new URL("./reference/pyodide/", import.meta.url).href;
const fetchAsset = self.fetch.bind(self);
const sources = [
    "engine.py", "bridge.py", "trajectory_import.py", "vendor/deepseek_v41_encoding.py",
];

let runtime;
async function read(url, headers) {
    const response = await fetchAsset(new URL(url, import.meta.url), { headers, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error("参考资源加载失败（HTTP " + response.status + "）");
    return response;
}

async function binary(url) {
    const chunk = 384 * 1024;
    const first = await read(url, { Range: "bytes=0-" + (chunk - 1) });
    if (first.status === 200) return first.blob();
    const prefix = /^bytes 0-(\d+)\/(\d+)$/.exec(first.headers.get("Content-Range") || "");
    if (!prefix) throw new Error("无法识别参考资源的字节范围。");
    const total = Number(prefix[2]);
    const parts = [first.arrayBuffer()];
    for (let start = Number(prefix[1]) + 1; start < total; start += chunk) {
        const end = Math.min(start + chunk, total) - 1;
        parts.push(read(url, { Range: "bytes=" + start + "-" + end }).then(async (response) => {
            if (response.headers.get("Content-Range") !== "bytes " + start + "-" + end + "/" + total) {
                throw new Error("参考资源的字节范围不一致。");
            }
            const bytes = await response.arrayBuffer();
            if (bytes.byteLength !== end - start + 1) throw new Error("参考资源下载不完整。");
            return bytes;
        }));
    }
    const blob = new Blob(await Promise.all(parts));
    if (blob.size !== total) throw new Error("参考资源大小不一致。");
    return blob;
}

async function initialize() {
    const [{ loadPyodide }, config, contents, wasm, stdlib] = await Promise.all([
        import(base + "pyodide.mjs"),
        binary("reference/vendor/tokenizer.json.gz").then((data) => new Response(
            data.stream().pipeThrough(new DecompressionStream("gzip"))
        ).json()),
        Promise.all(sources.map((file) => read("reference/" + file).then((response) => response.text()))),
        binary(base + "pyodide.asm.wasm.gz"),
        binary(base + "python_stdlib.zip"),
    ]);
    const tokenizer = createTokenizer(config);
    const stdLibURL = URL.createObjectURL(stdlib);
    self.fetch = (input, options) => String(input) === base + "pyodide.asm.wasm"
        ? Promise.resolve(new Response(wasm.stream().pipeThrough(new DecompressionStream("gzip")), {
            headers: { "Content-Type": "application/wasm" },
        }))
        : fetchAsset(input, options);
    let py;
    try {
        py = await loadPyodide({ indexURL: base, stdLibURL });
    } finally {
        self.fetch = fetchAsset;
        URL.revokeObjectURL(stdLibURL);
    }
    py.registerJsModule("browser_tokenizer", {
        encode_json: (text) => JSON.stringify(tokenizer.encode(text)),
        token_to_id: tokenizer.tokenToId,
    });
    py.FS.mkdirTree("/reference/vendor");
    sources.forEach((file, index) => py.FS.writeFile("/reference/" + file, contents[index]));
    py.runPython("import sys\nsys.path.insert(0, '/reference')\nfrom bridge import dispatch");
    return py.globals.get("dispatch");
}

self.onmessage = async ({ data }) => {
    try {
        if (!runtime) runtime = initialize().catch((error) => { runtime = null; throw error; });
        const dispatch = await runtime;
        self.postMessage({ id: data.id, result: JSON.parse(dispatch(data.action, JSON.stringify(data.payload))) });
    } catch (error) {
        self.postMessage({ id: data.id, error: String(error.message || error).trim().split("\n").filter(Boolean).at(-1) });
    }
};
