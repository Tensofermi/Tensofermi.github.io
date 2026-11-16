const base = new URL("./pyodide/", import.meta.url).href;
const fetchAsset = self.fetch.bind(self);
export async function readAsset(url, headers) {
    const response = await fetchAsset(new URL(url, import.meta.url), { headers, signal: AbortSignal.timeout(420000) });
    if (!response.ok) throw new Error("参考资源加载失败（HTTP " + response.status + "）");
    return response;
}

export async function binaryAsset(url) {
    const cache = await caches.open("trajectory-reference-0.29.3").catch(() => null);
    const address = new URL(url, import.meta.url);
    const cached = await cache?.match(address);
    if (cached) return cached.blob();
    const blob = await downloadBinary(url);
    await cache?.put(address, new Response(blob)).catch(() => {});
    return blob;
}

async function downloadBinary(url) {
    const chunk = 384 * 1024;
    const first = await readAsset(url, { Range: "bytes=0-" + (chunk - 1) });
    if (first.status === 200) return first.blob();
    const prefix = /^bytes 0-(\d+)\/(\d+)$/.exec(first.headers.get("Content-Range") || "");
    if (!prefix) throw new Error("无法识别参考资源的字节范围。");
    const total = Number(prefix[2]);
    const parts = [first.arrayBuffer()];
    for (let start = Number(prefix[1]) + 1; start < total; start += chunk) {
        const end = Math.min(start + chunk, total) - 1;
        parts.push(readAsset(url, { Range: "bytes=" + start + "-" + end }).then(async (response) => {
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


export async function loadPython() {
    const [{ loadPyodide }, wasm, stdlib] = await Promise.all([
        import(base + "pyodide.mjs"),
        binaryAsset(base + "pyodide.asm.wasm.gz"),
        binaryAsset(base + "python_stdlib.zip"),
    ]);
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
    return py;
}
