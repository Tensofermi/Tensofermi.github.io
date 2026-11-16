import { readAsset, binaryAsset, loadPython } from "./reference/python-runtime.mjs";

const asset = (name) => new URL("reference/" + name, import.meta.url);
const modules = ["atif_view.py", "atif_analysis.py", "atif_template.py", "atif_capture.py", "archive_bridge.py"];
const captures = "/atif-captures/";
let runtime;
let current;
let tokenizer;
let tokenWindow;

async function initialize() {
    const sources = modules.map((file) => [file, asset("atif/" + file)]);
    sources.find(([name]) => name === "atif_template.py")[1].searchParams.set("v", "5");
    sources.push(["vendor/deepseek_v41_chat_template.jinja", asset("vendor/deepseek_v41_chat_template.jinja")]);
    const [py, libraries, contents] = await Promise.all([
        loadPython(),
        binaryAsset(asset("atif/jinja-python.json.gz")).then((blob) => new Response(
            blob.stream().pipeThrough(new DecompressionStream("gzip"))
        ).json()),
        Promise.all(sources.map(async ([name, url]) => [name, await readAsset(url).then((response) => response.text())])),
    ]);
    for (const [name, contentsOfFile] of [...Object.entries(libraries), ...contents]) {
        const path = "/archive/" + name;
        py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        py.FS.writeFile(path, contentsOfFile);
    }
    py.runPython("import sys\nsys.path.insert(0, '/archive')\nfrom archive_bridge import dispatch, load");
    const dispatch = py.globals.get("dispatch");
    return { fs: py.FS, load: py.globals.get("load"), run: (action, args) => JSON.parse(dispatch(action, JSON.stringify(args))) };
}

function relative(name) {
    return typeof name === "string" && name.length <= 4096 && !/[\\\0]/.test(name) &&
        name.split("/").every((part) => part && part !== "." && part !== "..");
}

function findFile(path) {
    return relative(path) && current.files.get(current.prefix + path);
}

async function withCaptures(engine, action, args) {
    if (!current.files.size) return engine.run(action, args);
    const references = engine.run("references", { ...args, kind: action });
    const staged = new Set();
    let total = 0;
    try {
        for (const reference of references) {
            if (!/^[0-9a-f]{64}$/.test(reference?.sha256 || "")) continue;
            const file = findFile(reference.path);
            if (!file || file.size > 32 * 1024 * 1024 || staged.has(reference.path)) continue;
            if (total + file.size > 96 * 1024 * 1024) throw new Error("这一轮的捕获文件合计超过 96 MiB。可逐个下载并核对。");
            const target = captures + reference.path;
            engine.fs.mkdirTree(target.slice(0, target.lastIndexOf("/")));
            engine.fs.writeFile(target, new Uint8Array(await file.arrayBuffer()));
            staged.add(reference.path);
            total += file.size;
        }
        const result = engine.run(action, args);
        return action === "file" ? findFile(result) : result;
    } finally {
        for (const name of staged) engine.fs.unlink(captures + name);
    }
}

async function referenceTokens(engine, args) {
    if (!tokenizer) {
        tokenizer = Promise.all([
            import("./reference/offsets.mjs"),
            binaryAsset(asset("vendor/tokenizer.json.gz")).then((blob) => new Response(
                blob.stream().pipeThrough(new DecompressionStream("gzip"))
            ).json()),
        ]).then(([{createTokenizer}, config]) => createTokenizer(config)).catch((error) => {
            tokenizer = null;
            throw error;
        });
    }
    if (tokenWindow?.id !== args.context) {
        const text = engine.run("context/tokens", args);
        if (text.length > 1500000) throw new Error("参考分词窗口过长。可选择较早的生成位置查看。");
        const encoded = (await tokenizer).encode(text);
        tokenWindow = { id: args.context, encoded };
    }
    const { ids, tokens, offsets } = tokenWindow.encoded;
    const start = Math.min(ids.length, Math.max(0, Number(args.start) || 0));
    const end = Math.min(ids.length, start + 200);
    return { total: ids.length, start, end, tokens: ids.slice(start, end).map((id, i) => ({
        id, piece: tokens[start+i], offset: offsets[start+i],
    })) };
}

async function run(action, args) {
    runtime ??= initialize().catch((error) => { runtime = null; throw error; });
    const engine = await runtime;
    if (action === "load") {
        const { file, files, token, source } = args;
        if (file.size > 64 * 1024 * 1024) throw new Error("请选择 64 MiB 以内的 ATIF JSON 文件。");
        const path = args.path || "";
        const prefix = path.slice(0, path.lastIndexOf("/") + 1);
        const indexed = new Map(files.filter(({ path }) => relative(path)).map(({ path, file }) => [path, file]));
        const payload = JSON.parse(engine.load(await file.text(), source, indexed.size > 0));
        current = { token, prefix, files: indexed };
        tokenWindow = null;
        return payload;
    }
    if (args.token !== current?.token) throw new Error("当前轨迹已切换，请再次选择这一步。");
    if (["request", "compaction", "file"].includes(action)) return withCaptures(engine, action, args);
    if (action === "context/tokens") return referenceTokens(engine, args);
    return engine.run(action, args);
}

let queue = Promise.resolve();
self.onmessage = ({ data: job }) => {
    queue = queue.then(async () => {
        try {
            self.postMessage({ id: job.id, result: await run(job.action, job.args) });
        } catch (error) {
            self.postMessage({ id: job.id, error: String(error.message || error).trim().split("\n").filter(Boolean).at(-1) });
        }
    });
};
