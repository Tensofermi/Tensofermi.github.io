import { createTokenizer } from "./reference/offsets.mjs";

import { readAsset, binaryAsset, loadPython } from "./reference/python-runtime.mjs";

const asset = (path) => new URL("reference/" + path, import.meta.url);
const sources = [
    "engine.py", "bridge.py", "trajectory_import.py", "vendor/deepseek_v41_encoding.py",
];

let runtime;
async function initialize() {
    const [py, config, contents] = await Promise.all([
        loadPython(),
        binaryAsset(asset("vendor/tokenizer.json.gz")).then((blob) => new Response(
            blob.stream().pipeThrough(new DecompressionStream("gzip"))
        ).json()),
        Promise.all(sources.map((file) => readAsset(asset(file)).then((response) => response.text()))),
    ]);
    const tokenizer = createTokenizer(config);
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
