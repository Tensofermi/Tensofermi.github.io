"use strict";

const TYPES = {
    S: "系统前缀", U: "用户消息", R: "推理", M: "助手正文",
    T: "工具调用", O: "工具返回", C: "上下文压缩",
};
const PAGE_SIZE = 40;
const number = new Intl.NumberFormat("zh-CN");

const sample = {
    schema_version: "ATIF-v1.7",
    session_id: "monte-carlo-demo",
    agent: { name: "Trajectory Lab demo" },
    steps: [
        { step_id: 1, source: "system", message: "用简短的实验解释概率。给出估计值时也报告抽样误差。" },
        { step_id: 2, source: "user", message: "在单位正方形里随机撒点，怎么估算 π？" },
        {
            step_id: 3, source: "agent",
            reasoning_content: "到原点的距离不超过 1 的点落在四分之一圆内。圆内点的比例近似 π/4。",
            tool_calls: [{ tool_call_id: "pi-1000", function_name: "simulate_pi", arguments: { samples: 1000, seed: 42 } }],
            observation: { results: [{ source_call_id: "pi-1000", content: "1000 个点中，785 个落在四分之一圆内。" }] },
            metrics: { prompt_tokens: 128 },
        },
        {
            step_id: 4, source: "agent",
            message: "用 4 × 785 / 1000 得到 π ≈ 3.14。这次结果碰巧接近 π，重复抽样时估计会波动。",
            metrics: { prompt_tokens: 216 },
        },
        { step_id: 5, source: "user", message: "如果点数增加到 10 万，抽样误差大概会缩小多少？" },
        {
            step_id: 6, source: "agent",
            reasoning_content: "独立采样的标准误差与 1/√n 成正比。样本量增加 100 倍，标准误差缩小至 1/10。",
            message: "标准误差约为原来的十分之一。对这个实验，估计值的标准误差从约 0.052 降到约 0.0052。",
            metrics: { prompt_tokens: 308 },
        },
    ],
};
const $ = (id) => document.getElementById(id);
const state = { blocks: [], trend: [], selected: null, symbol: null, query: "", limit: PAGE_SIZE };
let fileRequest = 0;

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(text, click, className) {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", click);
    return node;
}

function color(symbol) {
    return "var(--" + symbol.toLowerCase() + ")";
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function parseTrace(data) {
    if (!Array.isArray(data?.steps) || !data.steps.length) {
        throw new Error("请选择含有 steps 的 ATIF JSON。");
    }
    if (data.steps.length > 5000) throw new Error("这条轨迹超过 5,000 步。请先截取需要查看的部分。");
    const counters = Object.fromEntries(Object.keys(TYPES).map((symbol) => [symbol, 0]));
    const blocks = [];
    const trend = [];

    function add(symbol, value, field, step, callId) {
        if (value === undefined || value === null || value === "") return;
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        let chars = 0;
        for (const _ of text) chars++;
        blocks.push({
            id: blocks.length, symbol, label: symbol + counters[symbol]++,
            field, step, text, chars, callId,
        });
    }

    data.steps.forEach((step, index) => {
        if (!step || typeof step !== "object") return;
        const field = "steps[" + index + "]";
        const id = typeof step.step_id === "number" || typeof step.step_id === "string" ? step.step_id : index + 1;
        const management = step.extra?.context_management;
        const firstBlock = blocks.length;
        if (management?.type === "compaction") add("C", management, field + ".extra.context_management", id);
        if (step.source === "system") add("S", step.message, field + ".message", id);
        if (step.source === "user") add("U", step.message, field + ".message", id);
        if (step.source === "agent" || step.source === "assistant") {
            add("R", step.reasoning_content, field + ".reasoning_content", id);
            add("M", step.message, field + ".message", id);
            array(step.tool_calls).forEach((call, i) => {
                add("T", call, field + ".tool_calls[" + i + "]", id, call?.tool_call_id);
            });
        }
        array(step.observation?.results).forEach((result, i) => {
            add("O", result?.content, field + ".observation.results[" + i + "].content", id, result?.source_call_id);
        });
        const tokens = step.metrics?.prompt_tokens;
        if (Number.isSafeInteger(tokens) && tokens >= 0) {
            trend.push({ step: id, tokens, block: blocks[firstBlock]?.id });
        }
    });

    if (!blocks.length) throw new Error("这份 ATIF 中没有可显示的消息、调用或返回。");
    return { blocks, trend, steps: data.steps.length, schema: typeof data.schema_version === "string" ? data.schema_version : "ATIF" };
}

function visibleBlocks() {
    return state.blocks.filter((block) => (!state.symbol || block.symbol === state.symbol)
        && (!state.query || block.text.toLowerCase().includes(state.query)));
}

function renderLegend() {
    const counts = Object.fromEntries(Object.keys(TYPES).map((symbol) => [symbol, 0]));
    for (const block of state.blocks) counts[block.symbol]++;
    const filters = Object.entries(TYPES).filter(([symbol]) => counts[symbol]).map(([symbol, name]) => {
        const filter = button(symbol + " " + name + " " + counts[symbol], () => {
            state.symbol = state.symbol === symbol ? null : symbol;
            state.limit = PAGE_SIZE;
            for (const control of $("legend").children) {
                control.setAttribute("aria-pressed", String(control.dataset.symbol === state.symbol));
            }
            renderSequence();
        });
        filter.style.setProperty("--symbol", color(symbol));
        filter.dataset.symbol = symbol;
        filter.setAttribute("aria-pressed", String(symbol === state.symbol));
        return filter;
    });
    $("legend").replaceChildren(...filters);
}

function renderRibbon(blocks) {
    const stride = Math.max(1, Math.ceil(blocks.length / 120));
    const segments = blocks.filter((block, pos) => pos % stride === 0 || pos === blocks.length - 1 || block.id === state.selected)
        .map((block) => {
            const segment = button(block.label, () => jump(block.id), "notation");
            segment.style.setProperty("--symbol", color(block.symbol));
            segment.title = block.label + " " + TYPES[block.symbol] + " · step " + block.step;
            segment.setAttribute("aria-label", segment.title);
            segment.setAttribute("aria-current", String(block.id === state.selected));
            return segment;
        });
    $("ribbon").replaceChildren(...segments);
    $("ribbon").hidden = !segments.length;
}

function renderBlock(block) {
    const row = element("li", undefined, "block");
    row.id = "block-" + block.id;
    row.style.setProperty("--symbol", color(block.symbol));
    row.dataset.selected = String(block.id === state.selected);

    const select = button(block.label, () => selectBlock(block.id), "notation");
    select.setAttribute("aria-label", "查看 " + block.label + " " + TYPES[block.symbol] + " 的字段");
    select.setAttribute("aria-current", String(block.id === state.selected));

    const panel = element("div", undefined, "panel");
    const heading = element("div", undefined, "block-heading");
    heading.append(element("strong", TYPES[block.symbol]), element("small", "step " + block.step));
    const preview = block.text.length > 480 ? block.text.slice(0, 480) + "…" : block.text;
    panel.append(heading, element("pre", preview));
    if (block.id === state.selected) renderBlockSource(panel, block);
    row.append(select, panel);
    return row;
}

function renderBlockSource(panel, block) {
    const source = element("details", undefined, "block-source muted");
    source.append(element("summary", "ATIF 字段"), element("code", block.field));
    if (typeof block.callId === "string") source.append(element("p", "调用 ID " + block.callId));
    if (block.text.length > 480) source.append(element("pre", block.text));
    panel.append(source);
}

function renderSequence() {
    const blocks = visibleBlocks();
    if (!blocks.some((block) => block.id === state.selected)) state.selected = blocks[0]?.id ?? null;
    renderRibbon(blocks);
    $("stream").replaceChildren(...blocks.slice(0, state.limit).map(renderBlock));
    $("empty").hidden = blocks.length > 0;
    $("empty").textContent = "没有符合筛选条件的块。";
    $("more").hidden = blocks.length <= state.limit;
    renderInspector();
}

function renderInspector() {
    const block = state.blocks[state.selected];
    const inspector = $("inspector");
    if (!block) {
        inspector.replaceChildren(element("p", "选择序列中的一块。"));
        return;
    }
    const title = element("strong", block.label + " · " + TYPES[block.symbol], "notation");
    title.style.setProperty("--symbol", color(block.symbol));
    const metadata = element("dl");
    metadata.append(element("dt", "ATIF 字段"), element("dd", block.field),
        element("dt", "步骤"), element("dd", block.step),
        element("dt", "文本字符数"), element("dd", number.format(block.chars)));
    if (typeof block.callId === "string") metadata.append(element("dt", "调用 ID"), element("dd", block.callId));
    inspector.replaceChildren(title, metadata, element("pre", block.text));
}

function selectBlock(id) {
    const previous = $("block-" + state.selected);
    if (previous) {
        previous.dataset.selected = "false";
        previous.firstElementChild.setAttribute("aria-current", "false");
        previous.querySelector(".block-source")?.remove();
    }
    state.selected = id;
    const row = $("block-" + id);
    row.dataset.selected = "true";
    row.firstElementChild.setAttribute("aria-current", "true");
    renderBlockSource(row.lastElementChild, state.blocks[id]);
    renderRibbon(visibleBlocks());
    renderInspector();
}

function jump(id) {
    if (!$("analysis").hidden) setView("sequence");
    let blocks = visibleBlocks();
    let index = blocks.findIndex((block) => block.id === id);
    if (index === -1) {
        state.symbol = null;
        state.query = "";
        $("search").value = "";
        renderLegend();
        blocks = visibleBlocks();
        index = blocks.findIndex((block) => block.id === id);
    }
    state.limit = Math.max(state.limit, index + 1);
    state.selected = id;
    renderSequence();
    const row = $("block-" + id);
    row.scrollIntoView({ block: "nearest" });
    row.firstElementChild.focus({ preventScroll: true });
}

function barRow(label, value, unit, maximum, symbol, target) {
    const row = element("div", undefined, "bar-row");
    const name = target === undefined ? element("span", label) : button(label, () => jump(target));
    const bar = element("span", undefined, "bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = element("span");
    fill.style.width = (maximum ? 100 * value / maximum : 0) + "%";
    if (symbol) fill.style.setProperty("--symbol", color(symbol));
    bar.append(fill);
    row.append(name, bar, element("strong", number.format(value) + " " + unit));
    return row;
}

function renderAnalysis() {
    const chars = Object.fromEntries(Object.keys(TYPES).map((symbol) => [symbol, 0]));
    for (const block of state.blocks) chars[block.symbol] += block.chars;
    const total = Object.values(chars).reduce((sum, value) => sum + value, 0);
    $("composition").replaceChildren(...Object.entries(chars)
        .filter(([, value]) => value)
        .map(([symbol, value]) => barRow(symbol + " " + TYPES[symbol], value, "字符", total, symbol)));

    const maximum = state.trend.reduce((max, point) => Math.max(max, point.tokens), 0);
    const rows = state.trend.map((point) => barRow("step " + point.step, point.tokens, "tokens",
        maximum, null, point.block));
    $("trend").replaceChildren(...(rows.length ? rows : [element("p", "这份 ATIF 没有记录输入 token 数。", "muted")]));
}

function setView(view) {
    $("sequence").hidden = view !== "sequence";
    $("analysis").hidden = view !== "analysis";
    $("search").hidden = view !== "sequence";
    for (const control of document.querySelectorAll("[data-view]")) {
        control.setAttribute("aria-pressed", String(control.dataset.view === view));
    }
}

function load(data, name, isSample) {
    const trace = parseTrace(data);
    Object.assign(state, trace, { selected: 0, symbol: null, query: "", limit: PAGE_SIZE });
    $("search").value = "";
    $("source-name").textContent = name;
    $("source-note").textContent = isSample
        ? "合成 ATIF 示例，包含模拟的工具返回和 token 计数。"
        : "文件在当前浏览器中解析。";
    $("sample").hidden = isSample;
    $("status").hidden = true;
    $("meta").textContent = [trace.schema, trace.steps + " 步", trace.blocks.length + " 块"].join(" · ");
    setView("sequence");
    renderLegend();
    renderSequence();
    renderAnalysis();
}

function loadSample() {
    fileRequest++;
    load(sample, "用蒙特卡洛估算 π", true);
}

$("sample").addEventListener("click", loadSample);
$("pick").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
    const file = $("file").files[0];
    $("file").value = "";
    if (!file) return;
    const request = ++fileRequest;
    try {
        if (file.size > 12 * 1024 * 1024) throw new Error("文件超过 12 MB。请先截取需要查看的部分。");
        const text = await file.text();
        if (request !== fileRequest) return;
        load(JSON.parse(text), file.name, false);
    } catch (error) {
        if (request !== fileRequest) return;
        $("status").textContent = error instanceof SyntaxError ? "JSON 格式有误，请检查文件后重试。" : error.message;
        $("status").hidden = false;
    }
});
$("search").addEventListener("input", () => {
    state.query = $("search").value.trim().toLowerCase();
    state.limit = PAGE_SIZE;
    renderSequence();
});
$("more").addEventListener("click", () => {
    const blocks = visibleBlocks();
    const next = blocks[state.limit];
    for (const block of blocks.slice(state.limit, state.limit + PAGE_SIZE)) $("stream").append(renderBlock(block));
    state.limit += PAGE_SIZE;
    $("more").hidden = blocks.length <= state.limit;
    if (next) $("block-" + next.id).firstElementChild.focus();
});
for (const control of document.querySelectorAll("[data-view]")) {
    control.addEventListener("click", () => setView(control.dataset.view));
}
document.documentElement.dataset.theme = localStorage.getItem("trajectory-theme") === "light" ? "light" : "dark";
$("theme").textContent = document.documentElement.dataset.theme === "light" ? "深色" : "浅色";
$("theme").addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    localStorage.setItem("trajectory-theme", document.documentElement.dataset.theme);
    $("theme").textContent = light ? "深色" : "浅色";
});

loadSample();
