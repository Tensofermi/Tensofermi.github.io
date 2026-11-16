/* Local ATIF sessions. Only the bundled demonstration is fetched over HTTP. */
(() => {
  "use strict";

  const base = new URL(".", document.currentScript.src);
  let worker;
  let workerToken;
  let workerLoad;
  let sourceVersion = 0;
  let active;
  let serial = 0;
  const jobs = new Map();

  function call(action, args) {
    if (!worker) {
      worker = new Worker(new URL("archive-worker.mjs", base), { type: "module" });
      worker.onmessage = ({ data }) => {
        const job = jobs.get(data.id);
        if (!job) return;
        jobs.delete(data.id);
        if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
      };
      worker.onerror = () => {
        for (const job of jobs.values()) job.reject(new Error("浏览器轨迹解析器加载失败。"));
        jobs.clear();
        worker.terminate();
        worker = null;
        workerToken = null;
      };
    }
    return new Promise((resolve, reject) => {
      const id = ++serial;
      jobs.set(id, { resolve, reject });
      worker.postMessage({ id, action, args });
    });
  }

  function activate(entry, payload) {
    if (active?.raw) URL.revokeObjectURL(active.raw);
    active = { ...entry, raw: URL.createObjectURL(entry.file) };
    return { ...payload, token: entry.token, raw_url: active.raw,
      filename: entry.file.name, source_kind: entry.source_kind };
  }

  async function get(name) {
    const response = await fetch(new URL(name, base));
    if (!response.ok) throw new Error("示例加载失败（HTTP " + response.status + "）");
    return response;
  }

  window.trajectorySource = {
    async sample() {
      const version = ++sourceVersion;
      const [payload, blob] = await Promise.all([
        get("trajectory-sample-index.json").then((response) => response.json()),
        get("trajectory-sample.json").then((response) => response.blob()),
      ]);
      const file = new File([blob], "monte-carlo.atif.json", { type: "application/json" });
      if (version !== sourceVersion) throw new Error("轨迹来源已切换。");
      return activate({ token: "sample", file, files: [], path: "", source: "用蒙特卡洛估算 π", source_kind: "sample" }, payload);
    },

    async open(file, files) {
      const version = ++sourceVersion;
      const entry = {
        token: crypto.randomUUID(), file,
        files: files.map((file) => ({ path: file.webkitRelativePath, file })),
        path: file.webkitRelativePath, source: file.name,
        source_kind: files.length ? "directory" : "upload",
      };
      const payload = await call("load", entry);
      workerToken = entry.token;
      if (version !== sourceVersion) throw new Error("轨迹来源已切换。");
      return activate(entry, payload);
    },

    async query(path) {
      const url = new URL(path, base);
      const action = url.pathname.split("/api/atif/")[1];
      const args = Object.fromEntries(url.searchParams);
      const entry = active;
      if (!entry || entry.token !== args.token) throw new Error("请重新选择当前轨迹的步骤。");
      if (workerToken !== entry.token) {
        if (workerLoad?.token !== entry.token) {
          const promise = call("load", entry).then(() => { workerToken = entry.token; });
          workerLoad = { token: entry.token, promise };
          promise.finally(() => {
            if (workerLoad?.promise === promise) workerLoad = null;
          }).catch(() => {});
        }
        await workerLoad.promise;
      }
      return call(action, args);
    },

    async download(path) {
      const file = await this.query(path);
      const href = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = href;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    },
  };
})();
