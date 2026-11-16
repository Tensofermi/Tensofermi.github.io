import { createTokenizer } from "./reference/offsets.mjs";

const base = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";
const sources = [
    "engine.py", "bridge.py", "trajectory_import.py", "vendor/deepseek_v41_encoding.py",
];

let runtime;
async function read(url) {
    const response = await fetch(new URL(url, import.meta.url));
    if (!response.ok) throw new Error("参考资源加载失败（HTTP " + response.status + "）");
    return response;
}

async function initialize() {
    const [{ loadPyodide }, config, contents] = await Promise.all([
        import(base + "pyodide.mjs"),
        read("reference/vendor/tokenizer.json.gz").then((response) => new Response(
            response.body.pipeThrough(new DecompressionStream("gzip"))
        ).json()),
        Promise.all(sources.map((file) => read("reference/" + file).then((response) => response.text()))),
    ]);
    const tokenizer = createTokenizer(config);
    const py = await loadPyodide({ indexURL: base });
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
