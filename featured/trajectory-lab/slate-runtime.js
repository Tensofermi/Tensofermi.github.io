(() => {
    "use strict";

    const model = {
        id: "deepseek-official/deepseek-flash", api_model: "deepseek-flash",
        label: "deepseek-flash", provider: "deepseek-official", configured: true,
        reconstruction: true, context_window: 1048576, thinking_control: "deepseek",
        format: "DeepSeek V4.1 Flash 官方参考编码", 
        format_source: "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/tree/main/encoding",
    };
    const base = new URL(".", document.currentScript.src);
    const toolLibrary = import(new URL("agent-tools.mjs?v=2", base));
    window.slateTools = toolLibrary;
    const live = "https://api.deepseek.com";
    let key = "";
    let worker;
    let sequence = 0;
    const pending = new Map();
    let database;
    let sample;
    const memory = new Map();

    function reference(action, payload) {
        if (!worker) {
            worker = new Worker(new URL("slate-worker.mjs?v=3", base), { type: "module" });
            worker.onmessage = ({ data }) => {
                const job = pending.get(data.id);
                if (!job) return;
                pending.delete(data.id);
                if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
            };
            worker.onerror = () => {
                for (const job of pending.values()) job.reject(new Error("无法加载浏览器参考编码器。"));
                pending.clear();
                worker.terminate();
                worker = null;
            };
        }
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, action, payload });
        });
    }

    function openDatabase() {
        if (!database) {
            database = new Promise((resolve, reject) => {
                const request = indexedDB.open("trajectory-lab-public", 1);
                request.onupgradeneeded = () => request.result.createObjectStore("records", { keyPath: "id" });
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return database;
    }

    async function records(method, value) {
        try {
            const db = await openDatabase();
            const transaction = db.transaction("records", method === "put" ? "readwrite" : "readonly");
            const query = transaction.objectStore("records")[method](value);
            return await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve(query.result);
                transaction.onabort = () => reject(transaction.error);
                transaction.onerror = () => reject(transaction.error);
            });
        } catch (error) {
            if (method === "put") return value.id;
            if (method === "get") return memory.get(value);
            return [...memory.values()];
        }
    }

    async function save(record) {
        memory.set(record.id, record);
        await records("put", record);
        return record;
    }

    async function savedRecords() {
        const stored = await records("getAll");
        const all = new Map(stored.map((record) => [record.id, record]));
        for (const [id, record] of memory) all.set(id, record);
        return [...all.values()];
    }

    async function exportableRuns() {
        const all = await savedRecords();
        return [...all.filter((record) => record.type === "agent_run" && record.turns.length),
            ...slateAtif.recoveredRuns(all)].sort((a, b) => b.created_at.localeCompare(a.created_at));
    }

    function draft(body) {
        const { messages, tools, thinking, effort, max_tokens } = body;
        if (!Array.isArray(messages) || !messages.length ||
            messages.some((item) => !item || !["system", "user", "assistant", "tool"].includes(item.role))) {
            throw new Error("messages 必须包含有效的消息角色。");
        }
        if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 8192) {
            throw new Error("输出上限应为 1–8192 的整数。");
        }
        if (messages.some((item, index) => item.prefix && (index !== messages.length - 1 || item.role !== "assistant"))) {
            throw new Error("prefix=true 只允许用于最后一条 assistant 消息。");
        }
        const request = {
            model: model.api_model,
            messages: messages.map((item) => Object.fromEntries(Object.entries(item).filter(([field]) => !field.startsWith("_")))),
            max_tokens,
            thinking: { type: thinking ? "enabled" : "disabled" },
            reasoning_effort: effort,
        };
        if (tools?.length) request.tools = tools;
        if (max_tokens === 1) Object.assign(request, { logprobs: true, top_logprobs: 10 });
        return request;
    }

    async function preview(body) {
        const request = draft(body);
        if (body.thinking && body.effort === "high" && !body.tools?.length &&
            body.messages.length === 2 && body.messages[1].content === "17×23 等于多少？") {
            sample ??= fetch(new URL("slate-sample.json", base)).then((response) =>
                response.ok ? response.json() : null
            ).catch(() => null);
            const snapshot = await sample;
            if (snapshot && JSON.stringify(snapshot.messages) === JSON.stringify(body.messages)) {
                return { ...snapshot.preview, api_request: request };
            }
        }
        return { ...await reference("preview", body), api_request: request };
    }

    function requireConnection() {
        if (key) return;
        const dialog = document.getElementById("connection-dialog");
        if (!dialog.open) dialog.showModal();
        throw new Error("填入 DeepSeek API Key 后，重新点击生成。");
    }

    async function upstream(request, signal) {
        requireConnection();
        const endpoint = live + (request.messages.at(-1).prefix ? "/beta" : "") + "/chat/completions";
        const response = await fetch(endpoint, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify(request), signal,
        });
        if (!response.ok) {
            const body = await response.json().catch(() => null);
            throw new Error(body?.error?.message || "DeepSeek HTTP " + response.status);
        }
        return { response, endpoint };
    }

    async function readStream(response, emit) {
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        const message = { role: "assistant", content: "", reasoning_content: "" };
        const tools = new Map();
        let buffer = "";
        let finish_reason = null;
        let usage = null;
        let complete = false;
        let metadata = {};
        try {
            while (!complete) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += value;
                let newline;
                while ((newline = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith("data:")) continue;
                    const text = line.slice(5).trim();
                    if (text === "[DONE]") { complete = true; break; }
                    const chunk = JSON.parse(text);
                    if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
                    metadata = { id: chunk.id ?? metadata.id, model: chunk.model ?? metadata.model };
                    usage = chunk.usage || usage;
                    for (const choice of chunk.choices || []) {
                        const delta = choice.delta || {};
                        message.content += delta.content || "";
                        message.reasoning_content += delta.reasoning_content || "";
                        finish_reason = choice.finish_reason || finish_reason;
                        for (const part of delta.tool_calls || []) {
                            const call = tools.get(part.index) || { type: "function", function: { name: "", arguments: "" } };
                            if (part.id) call.id = part.id;
                            call.function.name += part.function?.name || "";
                            call.function.arguments += part.function?.arguments || "";
                            tools.set(part.index, call);
                        }
                    }
                    emit({ type: "chunk", chunk });
                }
            }
        } finally {
            await reader.cancel().catch(() => {});
        }
        if (!complete && !finish_reason) throw new Error("流式连接提前结束。");
        if (tools.size) message.tool_calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
        return { ...metadata, choices: [{ index: 0, message, finish_reason }], usage };
    }

    async function generate(body, { stream = false, signal, emit = () => {}, agent = null } = {}) {
        requireConnection();
        signal?.throwIfAborted();
        const started = performance.now();
        const input = await preview(body);
        const request = { ...input.api_request, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
        const { response, endpoint } = await upstream(request, signal);
        if (stream) emit({ type: "start", input });
        const result = stream ? await readStream(response, emit) : await response.json();
        const choice = result.choices?.[0];
        const generated = await reference("generated", choice?.message || {}).catch(() => null);
        const record = await save({
            id: crypto.randomUUID(), type: "inference", created_at: new Date().toISOString(),
            model: result.model || model.api_model, model_key: model.id, provider: model.provider, agent,
            endpoint_url: endpoint, api_request: request, input, response: result, generated,
            input_with_local_origins: body.messages, usage: result.usage, finish_reason: choice?.finish_reason,
            compaction_draft_id: body.compaction_draft_id, elapsed_ms: performance.now() - started,
            evidence: stream ? "浏览器直连 DeepSeek；response 由流式返回聚合" : "浏览器直连 DeepSeek",
        });
        if (body.compaction_draft_id) {
            const comparison = await records("get", body.compaction_draft_id);
            if (comparison?.type === "compaction_draft") await save({ ...comparison, submitted_call_id: record.id });
        }
        return record;
    }

    async function runAgent(body, signal, emit) {
        requireConnection();
        const tools = await toolLibrary;
        const mode = body.tool_mode === "manual" ? "manual" : "automatic";
        const enabled = new Set((body.tools || []).map((tool) => tool?.function?.name).filter(Boolean));
        signal ??= new AbortController().signal;
        const messages = structuredClone(body.messages);
        const run = slateAtif.makeRun(body, new Date().toISOString(), crypto.randomUUID());
        let record;
        let iterations = 0;
        const max = 4;
        try {
            for (let iteration = 1; iteration <= max; iteration++) {
                signal?.throwIfAborted();
                emit({ type: "iteration_start", iteration, max_iterations: max });
                record = await generate({ ...body, messages: structuredClone(messages) }, {
                    signal, agent: { run_id: run.id, iteration, max_iterations: max },
                });
                iterations = iteration;
                const turn = slateAtif.makeTurn(record);
                run.turns.push(turn);
                await save(run);
                emit({ type: "model_done", iteration, record_id: record.id });
                const message = record.response?.choices?.[0]?.message;
                if (message) messages.push({ ...message, role: "assistant" });
                const calls = message?.tool_calls || [];
                if (!calls.length || iteration === max) {
                    run.status = calls.length ? "iteration_limit" : "completed";
                    break;
                }
                emit({ type: "tools_selected", count: calls.length });
                for (const call of calls) {
                    signal?.throwIfAborted();
                    const name = call.function?.name || "未知工具";
                    emit({ type: "tool_pending", name, mode });
                    const { content, success, execution } = await tools.resolveToolCall(call, mode, enabled, signal);
                    messages.push({ role: "tool", tool_call_id: call.id, content,
                        _origin: execution === "manual" ? "人类回填的工具返回" : "浏览器自动执行的工具返回" });
                    turn.observations.push({ call_id: call.id, content, success, execution });
                    await save(run);
                    emit({ type: "tool_result", name, success, execution, characters: content.length });
                }
            }
        } catch (error) {
            run.status = signal?.aborted || error.name === "AbortError" ? "stopped" : "failed";
            throw error;
        } finally {
            if (run.turns.length) {
                run.ended_at = new Date().toISOString();
                await save(run);
            }
        }
        emit({ type: "done", record, messages, tools: body.tools, iterations });
    }

    function streamResponse(run, signal) {
        const encoder = new TextEncoder();
        const body = new ReadableStream({
            start(controller) {
                const emit = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
                run(emit).then(() => controller.close()).catch((error) => {
                    if (signal?.aborted) controller.error(signal.reason);
                    else {
                        emit({ type: "error", error: error.message, cancelled: error.name === "AbortError" });
                        controller.close();
                    }
                });
            },
        });
        return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    }

    async function comparison(body) {
        const before = await records("get", body.before_record_id);
        if (before?.type !== "inference") throw new Error("请先选择一条推理记录。");
        const after = await preview({ ...body, max_tokens: 1, messages: body.after });
        return save({
            id: crypto.randomUUID(), type: "compaction_draft", created_at: new Date().toISOString(),
            before: before.input, after, after_messages: body.after, after_tools: body.tools,
            after_model: model.id, after_thinking: body.thinking, after_effort: body.effort,
        });
    }

    window.slateFetch = async function (route, options = {}) {
        const body = options.body ? JSON.parse(options.body) : null;
        try {
            if (route === "/api/generate") {
                return streamResponse(async (emit) => emit({
                    type: "done", record: await generate(body, { stream: true, signal: options.signal, emit }),
                }), options.signal);
            }
            if (route === "/api/agent") return streamResponse((emit) => runAgent(body, options.signal, emit), options.signal);
            if (route === "/api/models") return Response.json({ models: [model], default: model.id });
            if (route === "/api/preview") return Response.json(await preview(body));
            if (route === "/api/call") return Response.json(await generate(body));
            if (route === "/api/import-trajectory") return Response.json(await reference("import", body));
            if (route === "/api/tokenize-field") return Response.json(await reference("field", body));
            if (route === "/api/compaction") return Response.json(await comparison(body));
            if (route === "/api/agent/exports") {
                const runs = await exportableRuns();
                return Response.json({ runs: runs.map((run) => ({
                    id: run.id, status: run.status, created_at: run.created_at, turns: run.turns.length,
                    title: typeof run.messages.findLast((message) => message.role === "user")?.content === "string"
                        ? run.messages.findLast((message) => message.role === "user").content.slice(0, 84) : "",
                })) });
            }
            if (route === "/api/agent/export") {
                const run = (await exportableRuns()).find((item) => item.id === body?.id);
                if (!run) throw new Error("没有可导出的 Agent 运行。");
                return Response.json(slateAtif.build(run));
            }
            if (route === "/api/history") {
                const all = (await savedRecords()).filter((record) => record.type !== "agent_run");
                return Response.json({ records: all.sort((a, b) => b.created_at.localeCompare(a.created_at)).map((record) => ({
                    id: record.id, type: record.type, model: record.model, agent: record.agent,
                    created_at: record.created_at, prompt_tokens: record.usage?.prompt_tokens,
                    local_tokens: record.input?.count,
                })) });
            }
            if (route.startsWith("/api/record/")) {
                const id = route.slice("/api/record/".length);
                const record = memory.get(id) || await records("get", id);
                if (record) return Response.json(record);
            }
            return Response.json({ error: "此浏览器版本没有该接口。" }, { status: 404 });
        } catch (error) {
            return Response.json({ error: error.message }, { status: 400 });
        }
    };

    const connection = document.getElementById("connection");
    const dialog = document.getElementById("connection-dialog");
    const input = document.getElementById("deepseek-key");
    connection.onclick = () => dialog.showModal();
    document.getElementById("save-connection").onclick = () => {
        key = input.value.trim();
        input.value = "";
        connection.textContent = key ? "已填 API Key" : "连接 DeepSeek";
        connection.classList.toggle("online", Boolean(key));
        dialog.close();
    };
    document.getElementById("clear-connection").onclick = () => {
        key = "";
        input.value = "";
        connection.textContent = "连接 DeepSeek";
        connection.classList.remove("online");
        dialog.close();
    };
})();
