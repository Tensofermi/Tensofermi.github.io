/*
 * Trajectory mode: read an ATIF archive through the S/U/R/M/T/O notation.
 *
 * Deliberate limits, mirrored by the server (atif_view.py):
 *  - the archive sequence is not a request's visible context; the V(k) view
 *    only renders messages captured for that exact request;
 *  - no token counting per block, so no token sums are shown for blocks;
 *  - every capture read on the server is hash-verified, and this page shows the
 *    verification result instead of hiding it.
 */
"use strict";

const $ = (id) => document.getElementById(id);

const SYMBOLS = {
  S: { label: "初始前缀", tag: "prefix", color: "var(--format)" },
  U: { label: "用户侧输入", tag: "input", color: "var(--prompt)" },
  R: { label: "推理", tag: "reason", color: "var(--cot)" },
  M: { label: "assistant 正文", tag: "text", color: "var(--message)" },
  T: { label: "工具调用", tag: "call", color: "var(--call)" },
  O: { label: "工具返回", tag: "return", color: "var(--observation)" },
  C: { label: "压缩操作", tag: "cut", color: "var(--warn)" },
  "?": { label: "未识别的 source", tag: "unknown", color: "var(--danger)" },
};

const STATES = {
  rendered: { label: "渲染文本", note: "模型上下文的可读分段；此视图不判定训练损失掩码", cls: "neutral" },
  condition: { label: "条件", note: "只作为条件，不计损失", cls: "neutral" },
  target: { label: "监督目标", note: "ATIF 声明该步可训练", cls: "target" },
  ignored: { label: "不进入训练", note: "ATIF 声明 trainable=false、失败或未完成", cls: "bad" },
  summary: { label: "摘要", note: "压缩摘要正文，不是训练目标", cls: "summary" },
  unknown: { label: "未声明", note: "ATIF 未提供 call_kind/trainable", cls: "neutral" },
  control: { label: "控制", note: "压缩边界，不是提示词块", cls: "control" },
};

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const STAGE = { policy: "policy", compaction: "compaction", summary: "summary" };
const PREVIEW_LOADING = new Set();

const state = {
  token: null, view: null, sourceKind: null,
  selected: null, mode: "archive", query: "", searchResults: null, symbols: new Set(),
  firstBlock: 0, rendered: 0, batch: 24,
  activeRequest: null, requestPage: 0, requestTab: "messages", requests: new Map(),
  rawHref: null, filename: null, prefixRequest: 0, archiveView: null, modelView: null,
  contextKey: null, contextId: null, contextStart: 0, referenceRequest: 0,
  analysis: null, analysisKinds: new Set(),
};

function notation(symbol, index) {
  const digits = String(index).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
  return symbol === "S" ? (index === 0 ? "S" : "S" + digits) : symbol + digits;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function notice(message, kind) {
  const box = $("notice");
  box.textContent = message;
  box.className = "notice" + (kind ? " " + kind : "");
}

async function api(path) {
  return trajectorySource.query(path);
}

function bytes(value) {
  if (!(value >= 0)) return "—";
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
  return (value / 1024 / 1024).toFixed(2) + " MiB";
}

function count(value) {
  return typeof value === "number" ? value.toLocaleString("en-US") : "—";
}

function keyChip(key, options = {}) {
  const block = state.view && state.view.blocks.find((item) => item.key === key);
  if (!block) {
    const chip = el("span", "key", key);
    return chip;
  }
  const chip = el("button", "key" + (options.dropped ? " dropped" : ""), notation(block.symbol, block.index));
  chip.title = block.title + " · " + block.chars + " 字符";
  chip.onclick = (event) => {
    if (event && event.stopPropagation) event.stopPropagation();
    openBlock(key);
  };
  return chip;
}

function appendChecked(list, checks) {
  for (const check of checks || []) {
    const ok = check.ok;
    const row = el("li", ok === true ? "ok" : ok === false ? "bad" : "neutral");
    row.append(el("b", "", ok === true ? "✓" : ok === false ? "✗" : "·"));
    const detail = check.detail ? "（" + check.detail + "）" : "";
    row.append(el("span", "", check.label + detail));
    list.append(row);
  }
}

function textBlock(text, options = {}) {
  const pre = el("pre", "blk-text" + (options.dim ? " dim" : ""));
  if (state.query && text) appendHighlighted(pre, text, state.query);
  else pre.textContent = text || "";
  pre.title = "点击展开 / 收起";
  pre.onclick = () => pre.classList.toggle("open");
  return pre;
}

function appendHighlighted(parent, text, query) {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    if (at > cursor) parent.append(document.createTextNode(text.slice(cursor, at)));
    parent.append(el("mark", "mark", text.slice(at, at + needle.length)));
    cursor = at + needle.length;
    at = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
}

/* ------------------------------------------------------------------ loading */

let inputVersion = 0;
let folderFiles = [];

async function openSource(load, label) {
  const version = ++inputVersion;
  notice(label);
  try {
    const payload = await load();
    if (version === inputVersion) show(payload);
  } catch (error) {
    if (version === inputVersion) notice("载入失败：" + error.message, "error");
  }
}

function openFile(file, files = []) {
  if (file) openSource(() => trajectorySource.open(file, files), "正在读取本机文件 " + file.name + " …");
}

function loadFolder(files) {
  folderFiles = files;
  const select = $("library-select");
  const choices = files.filter((file) => /\.json$/i.test(file.name)
    && !file.webkitRelativePath.split("/").includes("captures"));
  const placeholder = el("option", "", "选择目录中的 ATIF …");
  placeholder.value = "";
  select.replaceChildren(placeholder);
  for (const file of choices) {
    const option = el("option", "", file.webkitRelativePath);
    option.value = String(files.indexOf(file));
    select.append(option);
  }
  $("library-label").hidden = !choices.length;
  if (choices.length === 1) {
    select.value = String(files.indexOf(choices[0]));
    openFile(choices[0], files);
  } else {
    notice(choices.length ? "选择目录中的 ATIF JSON，捕获文件会在打开对应轮次时读取。"
      : "目录中没有可选择的 ATIF JSON。");
  }
}

function loadSample() {
  openSource(() => trajectorySource.sample(), "正在读取合成示例…");
}

/* -------------------------------------------------------------------- render */

function contextChoices(choices, current = "all") {
  const select = $("context-selection");
  select.replaceChildren(...choices.map((choice) => {
    const option = el("option", "", choice.label);
    option.value = choice.value;
    return option;
  }));
  select.value = current;
}

function show(payload) {
  state.token = payload.token;
  state.view = payload;
  state.archiveView = payload;
  state.analysis = payload.analysis || null;
  state.modelView = null;
  state.contextKey = null;
  state.contextId = null;
  state.contextStart = 0;
  contextChoices(payload.context_choices);
  hideReferenceTokens();
  state.sourceKind = payload.source_kind;
  state.selected = null;
  state.rendered = 0;
  state.query = "";
  state.searchResults = null;
  state.symbols = new Set();
  state.activeRequest = null;
  state.requestPage = 0;
  state.requestTab = "messages";
  state.requests = new Map();
  state.prefixRequest += 1;
  $("filter").value = "";
  $("source-kind").textContent = (payload.source_kind === "sample" ? "合成示例：" : "本机文件：") + (payload.meta.source || "");
  $("raw-link").hidden = false;
  state.rawHref = payload.raw_url;
  state.filename = payload.filename;
  $("raw-link").href = state.rawHref;
  $("raw-link").download = state.filename;

  $("requests").replaceChildren();
  $("request-body").replaceChildren(el("p", "empty", "选择左侧一次请求。"));

  const meta = payload.meta;
  const captures = meta.captures || {};
  const parts = [];
  parts.push((meta.agent && meta.agent.model_name) || "未知模型");
  parts.push(meta.steps + " 步");
  parts.push(payload.blocks.length + " 块");
  if (meta.tool_definitions !== null && meta.tool_definitions !== undefined) parts.push(meta.tool_definitions + " 个函数定义");
  if ((meta.provider_tool_declarations || []).length) parts.push(meta.provider_tool_declarations.length + " 个供应商声明");
  if (captures.requests) parts.push(captures.requests + " 次请求捕获");
  if (meta.compactions) parts.push(meta.compactions + " 次压缩");
  $("meta-line").textContent = parts.join(" · ");
  const details = [];
  if (meta.final_metrics && meta.final_metrics.total_prompt_tokens) {
    details.push("累计输入 " + count(meta.final_metrics.total_prompt_tokens) + " tokens（ATIF 汇总）");
  }
  if (meta.warnings && meta.warnings.length) details.push(meta.warnings.length + " 条告警");
  $("meta-line").title = details.join("；");
  $("schema-chip").textContent = (meta.schema || "ATIF") + (payload.source_kind === "sample" ? " · 合成示例" : " · 本机");
  if (!captures.available) {
    notice("已载入 " + (meta.source || "ATIF") + "：没有捕获目录，请求视图只显示 ATIF 元数据。");
  } else if (!captures.requests) {
    notice("已载入 " + (meta.source || "ATIF") + "：有捕获目录，但这条轨迹没有请求快照。", "");
  } else {
    notice("已载入 " + (meta.source || "ATIF") + "：" + captures.requests + " 次请求快照，读取时逐个核对 SHA256。", "good");
  }
  switchMode("archive", true);
}

function renderLegend() {
  const counts = state.view.meta.counts || {};
  const box = $("counts");
  box.replaceChildren();
  for (const symbol of ["S", "U", "R", "M", "T", "O", "C", "?"]) {
    const value = counts[symbol] || 0;
    if (!value) continue;
    const button = el("button");
    button.style.setProperty("--sym", SYMBOLS[symbol].color);
    button.append(el("i"));
    button.append(document.createTextNode(symbol));
    const sup = el("sup", "", String(value));
    button.append(sup);
    button.title = SYMBOLS[symbol].label + "：" + value + " 块；点击只看这一类";
    button.setAttribute("aria-pressed", state.symbols.has(symbol) ? "true" : "false");
    button.onclick = () => {
      if (state.symbols.has(symbol)) state.symbols.delete(symbol);
      else state.symbols.add(symbol);
      button.setAttribute("aria-pressed", state.symbols.has(symbol) ? "true" : "false");
      renderStream();
    };
    box.append(button);
  }
}

function renderToolDefinitions() {
  const panel = $("tools-panel");
  if (!panel) return;
  const meta = state.view.meta;
  const definitions = meta.tool_definitions_detail || [];
  const provider = meta.provider_tool_declarations || [];
  const usage = meta.tool_usage || {};
  const provenance = meta.tool_definitions_provenance || {};
  const rejected = provenance.rejected_undeclared_calls || [];
  panel.hidden = !definitions.length && !provider.length && !rejected.length;
  const list = $("tools-list");
  list.replaceChildren();
  if (panel.hidden) return;
  list.append(el("p", "hintline", provenance.evidence_label ||
    "文件声明的工具定义；不代表已核对历史服务端渲染文本。"));
  for (const tool of definitions.concat(provider)) {
    const definition = tool.function || tool;
    const name = definition.name || tool.type || "tool";
    const details = el("details", "item");
    const calls = usage[name] || (name === "web_search" ? usage.web_search_call : 0) || 0;
    const summary = el("summary", "item-name", name + " · " + calls + " 次调用");
    details.append(el("p", "hintline", tool.type === "function" ? "字段：agent.tool_definitions" : "扩展字段：agent.extra.provider_tool_declarations"));
    details.append(summary);
    if (tool.type === "web_search") details.append(el("p", "hintline", "服务端搜索启用声明；不包含服务端内部工具参数定义。"));
    if (definition.description) details.append(el("p", "hintline", definition.description));
    const pre = textBlock(JSON.stringify(tool, null, 2));
    pre.classList.add("open");
    details.append(pre);
    list.append(details);
  }
  for (const item of rejected) {
    list.append(el("p", "hintline", item.name + " · " + item.calls +
      " 次尝试，返回 unsupported call；保留调用记录，不伪造工具定义。"));
  }
  if (provenance.source_tools_sha256) {
    const details = el("details", "item");
    details.append(el("summary", "item-name", "定义来源与筛选依据"));
    details.append(textBlock(JSON.stringify(provenance, null, 2)));
    list.append(details);
  }
}

function renderBoundary() {
  const view = state.view;
  const notes = view.notes || {};
  const list = $("boundary-list");
  list.replaceChildren();
  for (const key of ["archive", "request", "tokens"]) {
    if (notes[key]) list.append(el("li", "", notes[key]));
  }
  if (view.meta.warnings && view.meta.warnings.length) {
    list.append(el("li", "", view.meta.warnings.length + " 条告警；见「证据边界」。"));
  }
  const detail = $("boundary-detail");
  detail.replaceChildren();
  const intro = el("p", "", "本页提供原始 ATIF 字段、官方模板重建与捕获请求三种证据层次。序列 H 与模型上下文使用同一份渲染文本；重建规则和未核验内容明确标注，不声称历史服务端实收 token 已被还原。");
  detail.append(intro);
  const ul = el("ul");
  for (const key of ["archive", "request", "tokens", "narrative", "compaction"]) {
    if (notes[key]) ul.append(el("li", "", notes[key]));
  }
  ul.append(el("li", "", "块 token 数一律不显示：逐块分词相加不等于一次请求的输入长度，ATIF metrics 只属于请求。"));
  ul.append(el("li", "", "压缩的保留范围、注入消息和摘要正文都来自 sidecar 文件；没有 sidecar 时明确显示「无法核对」。"));
  ul.append(el("li", "", "本地重建的 token ID 序列会核对首尾标记与长度，但计数相同不证明逐 token 相同。"));
  if (view.meta.warnings && view.meta.warnings.length) {
    ul.append(el("li", "", "本次载入告警：" + view.meta.warnings.join("；")));
  }
  detail.append(ul);
  if (view.meta.captures && view.meta.captures.directory) {
    detail.append(el("p", "", "捕获目录：" + view.meta.captures.directory));
  }
}

function color(symbol) {
  return (SYMBOLS[symbol] || SYMBOLS.S).color;
}

function renderRibbon() {
  const ribbon = $("ribbon");
  ribbon.replaceChildren();
  if (!state.view) return;
  const blocks = state.view.blocks;
  const stride = Math.max(1, Math.ceil(blocks.length / 320));
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (i % stride && i !== blocks.length - 1 && block.symbol !== "C" && block.key !== state.selected) continue;
    if (block.symbol === "C") {
      const cut = el("button", "cut");
      cut.title = notation(block.symbol, block.index) + " · " + block.title;
      cut.setAttribute("aria-label", cut.title);
      cut.dataset.key = block.key;
      cut.onclick = () => openBlock(block.key);
      ribbon.append(cut);
      continue;
    }
    const button = el("button");
    button.style.setProperty("--sym", color(block.symbol));
    button.style.flexGrow = String(Math.max(1, Math.sqrt(Math.max(block.chars, 40))));
    button.title = notation(block.symbol, block.index) + " · " + block.title + " · " + block.chars + " 字符";
    button.setAttribute("aria-label", button.title);
    button.dataset.key = block.key;
    button.onclick = () => openBlock(block.key);
    ribbon.append(button);
  }
}

function matches(block) {
  if (state.symbols.size && !state.symbols.has(block.symbol)) return false;
  if (!state.query) return true;
  if (state.searchResults) return state.searchResults.has(block.key);
  const needle = state.query.toLowerCase();
  if ((block.title || "").toLowerCase().includes(needle)) return true;
  if ((block.text || "").toLowerCase().includes(needle)) return true;
  return (block.items || []).some((item) => (item.text || "").toLowerCase().includes(needle)
    || (item.title || "").toLowerCase().includes(needle)
    || (item.name || "").toLowerCase().includes(needle));
}

function visibleBlocks() {
  return (state.view ? state.view.blocks : []).filter(matches);
}

function renderStream(start = 0) {
  const stream = $("stream");
  stream.replaceChildren();
  state.firstBlock = start;
  state.rendered = start;
  if (!state.view) {
    $("stream-more").hidden = true;
    return;
  }
  $("stream-empty").hidden = true;
  const blocks = visibleBlocks();
  // Small archives render in one pass; long ones append in batches.
  state.batch = blocks.length <= 80 ? Math.max(blocks.length, 1) : 24;
  if (!blocks.length) {
    $("stream").append(el("li", "empty-state", "没有匹配的块。清空查找或点击已选中的记号取消筛选。"));
    $("stream-more").hidden = true;
    return;
  }
  appendBlocks();
}

function appendBlocks() {
  const blocks = visibleBlocks();
  const stream = $("stream");
  if (state.rendered - state.firstBlock >= 96) {
    renderStream(state.rendered);
    return;
  }
  const limit = Math.min(blocks.length, state.rendered + state.batch);
  for (let index = state.rendered; index < limit; index += 1) {
    stream.append(blockRow(blocks[index]));
  }
  state.rendered = limit;
  const more = $("stream-more");
  more.hidden = limit >= blocks.length && !state.firstBlock;
  $("prev-batch").hidden = !state.firstBlock;
  $("more").hidden = limit >= blocks.length;
  $("more-count").textContent = "第 " + (state.firstBlock + 1) + "–" + limit + " 块，共 " + blocks.length + " 块";
}

function blockRow(block) {
  if (block.symbol === "C") return compactionRow(block);
  const item = el("li", "blk");
  item.dataset.key = block.key;
  item.dataset.symbol = block.symbol;
  item.style.setProperty("--sym", color(block.symbol));
  if (state.selected === block.key) item.dataset.selected = "true";

  const gutter = el("div", "blk-gutter");
  const badge = el("div", "sym", notation(block.symbol, block.index));
  badge.append(el("small", "", SYMBOLS[block.symbol].tag));
  gutter.append(badge);

  const body = el("div", "blk-body");
  const head = el("div", "blk-head");
  head.append(el("span", "blk-title", block.title || SYMBOLS[block.symbol].label));
  const st = STATES[block.state] || STATES.unknown;
  const stateChip = el("span", "chip " + st.cls, st.label);
  stateChip.title = block.state_note || st.note;
  head.append(stateChip);
  if (block.request) {
    const chip = el("button", "chip", block.request);
    chip.title = "打开这次请求的捕获快照";
    chip.onclick = (event) => {
      event.stopPropagation();
      switchMode("v", true);
      openRequest(block.request);
    };
    head.append(chip);
  }
  for (const flag of block.flags || []) {
    const chip = el("span", "chip warn", flag.includes("model_visible") ? "有未进入训练的返回" : "标记");
    chip.title = flag;
    head.append(chip);
  }
  if (block.compaction) {
    const chip = el("span", "chip summary", "→ " + block.compaction);
    chip.title = "这块正文是压缩操作 " + block.compaction + " 的摘要来源";
    head.append(chip);
  }
  const meta = el("span", "blk-meta");
  const bits = [];
  if (block.step_id !== null && block.step_id !== undefined) bits.push("steps[" + block.step_id + "]");
  bits.push(count(block.chars) + " 字符");
  if (block.call && block.call.prompt_tokens) bits.push("请求 " + count(block.call.prompt_tokens) + " tok");
  meta.textContent = bits.join(" · ");
  head.append(meta);
  body.append(head);

  if ((block.symbol === "T" || block.symbol === "O") && !block.rendered_context) {
    body.append(itemsList(block));
  } else {
    if (block.text) body.append(textBlock(block.text, { dim: block.symbol === "R" }));
    if (block.items && block.items.length) body.append(itemsList(block));
  }

  if (block.text) {
    const actions = el("div", "blk-actions");
    const full = el("button", "mini", "展开 / 收起文本");
    full.onclick = (event) => {
      event.stopPropagation();
      const pre = body.querySelector(".blk-text");
      if (pre) pre.classList.toggle("open");
    };
    actions.append(full);
    if (block.truncated) {
      const need = el("button", "mini", "载入完整文本（" + count(block.chars) + " 字符）");
      need.onclick = (event) => {
        event.stopPropagation();
        loadFullText(block.key);
      };
      actions.append(need);
    }
    body.append(actions);
  }

  item.append(gutter, body);
  item.onclick = () => select(block.key);
  return item;
}

function itemsList(block) {
  const list = el("div", "items");
  for (const item of block.items) {
    const details = el("details", "item");
    const summary = el("summary");
    const name = el("span", "item-name", item.name || item.title || (block.symbol === "O" ? "return" : "args"));
    summary.append(name);
    if (item.call_id) summary.append(el("span", "item-ref", item.call_id));
    if (item.model_visible === false) summary.append(el("span", "chip warn", "未进入训练"));
    if (item.harness_truncated) summary.append(el("span", "chip warn", "已截断"));
    const meta = el("span", "item-meta", count(item.chars) + " 字符"
      + (item.raw_chars ? " · 原文 " + count(item.raw_chars) : ""));
    summary.append(meta);
    details.append(summary);
    if (item.text) details.append(textBlock(item.text));
    list.append(details);
  }
  return list;
}

async function loadFullText(key) {
  const view = state.view;
  const token = state.token;
  const loadKey = [token, view?.meta.model_context || "", key].join(":");
  if (PREVIEW_LOADING.has(loadKey) || !view) return;
  PREVIEW_LOADING.add(loadKey);
  try {
    const contextId = view.meta.model_context;
    const path = contextId ? "/api/atif/context/block?token=" + encodeURIComponent(state.token) + "&context=" + encodeURIComponent(contextId) + "&key=" + encodeURIComponent(key)
      : "/api/atif/text?token=" + encodeURIComponent(state.token) + "&keys=" + encodeURIComponent(key);
    const data = await api(path);
    if (state.token !== token || state.view !== view) return;
    const full = data.blocks && data.blocks[0];
    if (!full) throw new Error("服务端没有返回完整文本");
    const block = state.view.blocks.find((item) => item.key === key);
    if (!block) return;
    block.text = full.text;
    block.truncated = false;
    block.items = full.items && full.items.length ? full.items : block.items;
    const node = blockNode(key);
    if (node) {
      const fresh = blockRow(block);
      node.replaceWith(fresh);
      if (state.selected === key) fresh.dataset.selected = "true";
      fresh.querySelector(".blk-text")?.classList.add("open");
    }
    if (state.selected === key) renderInspector();
    notice("已载入 " + key + " 的完整文本（" + count(full.chars) + " 字符）。", "good");
  } catch (error) {
    if (state.token === token) notice("载入完整文本失败：" + error.message, "error");
  } finally {
    PREVIEW_LOADING.delete(loadKey);
  }
}

function compactionRow(block) {
  const item = el("li", "cut-row");
  item.dataset.key = block.key;
  const card = el("div", "cut-card");
  if (state.selected === block.key) card.dataset.selected = "true";

  const head = el("div", "cut-head");
  head.append(el("span", "cut-badge", notation(block.symbol, block.index)));
  head.append(el("span", "cut-title", block.title));
  head.append(el("span", "chip control", "控制边界"));
  const meta = el("span", "blk-meta");
  meta.textContent = block.step_id !== null && block.step_id !== undefined ? "steps[" + block.step_id + "]" : "";
  head.append(meta);
  card.append(head);

  const notes = [];
  if (block.control_note) notes.push("ATIF 记录的控制说明（不是模型输入）：" + block.control_note);
  if (!block.before || block.before.messages === null) {
    notes.push(state.archiveView.meta.captures.available && block.references
      ? (block.captureChecked ? "压缩所需的捕获文件缺失或核对失败。" : "打开此块读取并校验相关捕获文件。")
      : "当前只有 ATIF 声明的压缩边界。核对保留范围需要捕获文件。");
  }
  for (const note of notes) card.append(el("p", "blk-note", note));

  if (block.before && block.before.messages !== null) {
    const flow = el("div", "cut-flow");
    flow.append(box("压缩前", block.before.messages + " 条"));
    flow.append(el("span", "arrow", "→"));
    flow.append(box("保留", String((block.kept || []).length) + " 条"));
    flow.append(box("丢弃", String((block.dropped || []).length) + " 条"));
    flow.append(box("注入", String((block.injected || []).length) + " 条"));
    if (block.after) flow.append(el("span", "arrow", "→"));
    if (block.after) flow.append(box("压缩后", block.after.messages + " 条"));
    card.append(flow);

    const grid = el("div", "cut-grid");
    grid.append(section("保留原文（按实际顺序）", (block.before.blocks || []).filter((key) => (block.after.blocks || []).includes(key))));
    grid.append(section("不再作为原文", block.dropped_blocks || [], true));
    const injected = block.injected || [];
    grid.append(section("注入的消息", null, false, injected.length
      ? injected.map((entry) => (entry.role || "?") + " · " + count(entry.chars) + " 字符，来自 harness 包装的摘要").join("；")
      : "无"));
    grid.append(summarySection(block));
    card.append(grid);

    const checks = el("ul", "checks");
    appendChecked(checks, block.checks || []);
    if (checks.children.length) card.append(checks);
  }
  if (state.archiveView.meta.captures.available) card.append(referenceRow(block));

  item.append(card);
  item.onclick = () => select(block.key);
  return item;
}

function box(label, value) {
  const node = el("span", "box");
  node.append(document.createTextNode(label + " "));
  node.append(el("b", "", value));
  return node;
}

function section(title, keys, dropped, text) {
  const node = el("section");
  node.append(el("h3", "", title));
  if (keys && keys.length) {
    const row = el("div", "keys");
    for (const key of keys) row.append(keyChip(key, { dropped }));
    node.append(row);
  } else if (keys) {
    node.append(el("p", "", "无"));
  }
  if (text) node.append(el("p", "", text));
  return node;
}

function summarySection(block) {
  const node = el("section");
  node.append(el("h3", "", "摘要 Σ"));
  const row = el("div", "keys");
  if (block.summary_block) row.append(keyChip(block.summary_block));
  if (block.summary_chars) row.append(el("span", "item-meta", count(block.summary_chars) + " 字符"));
  node.append(row);
  if (block.summary_matches === false) node.append(el("p", "", "✗ 摘要正文与 summary.txt 不一致（见下方核对）"));
  else if (block.summary_matches === null || block.summary_matches === undefined) {
    node.append(el("p", "", "未读取 summary.txt，无法核对"));
  }
  return node;
}

function referenceRow(block) {
  const row = el("div", "blk-actions");
  const kinds = { prior_messages: "压缩前消息", effective_messages: "压缩后消息", summary: "summary.txt", native_compaction_event: "原生事件" };
  for (const [kind, label] of Object.entries(kinds)) {
    if (!(block.references || {})[kind]) continue;
    row.append(download("下载 " + label, block.key + "." + kind));
  }
  return row;
}

/* ------------------------------------------------------------------ analysis */

const ANALYSIS_PART = {
  S: { label: "系统前缀", color: "var(--format)" },
  U: { label: "用户侧输入", color: "var(--prompt)" },
  R: { label: "推理", color: "var(--cot)" },
  M: { label: "assistant 正文", color: "var(--message)" },
  T: { label: "工具调用", color: "var(--call)" },
  O: { label: "工具返回", color: "var(--observation)" },
  C: { label: "压缩操作", color: "var(--warn)" },
  D: { label: "工具定义", color: "var(--accent)" },
  "?": { label: "未识别", color: "var(--danger)" },
};

function share(part) {
  const value = (part || 0) * 100;
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + "%";
}

function emptyNote(text) {
  return el("p", "empty", text);
}

function metricCard(label, value, note) {
  const card = el("div");
  card.append(el("small", "", label));
  card.append(el("strong", "", value));
  if (note) card.append(el("span", "", note));
  return card;
}

function renderAnalysisKpi(data) {
  const box = $("an-kpi");
  box.replaceChildren();
  const kpi = data.kpi || {};
  box.append(metricCard("生成点", count(kpi.calls || 0), "/ " + (kpi.steps || 0) + " 步"));
  box.append(metricCard("累计输入", count(kpi.prompt_total), "tokens · 各次求和"));
  box.append(metricCard("峰值上下文", count(kpi.prompt_peak), "tokens · 单次"));
  box.append(metricCard("累计输出", count(kpi.completion_total), "tokens"));
  box.append(metricCard("缓存命中", kpi.cache_rate === null || kpi.cache_rate === undefined ? "—" : share(kpi.cache_rate),
    kpi.cached_total ? count(kpi.cached_total) + " cached" : "ATIF 未报告"));
  box.append(metricCard("推理输出", count(kpi.reasoning_total), "tokens · 占输出"));
}

function renderAnalysisComposition(data) {
  const box = $("an-composition");
  const note = $("an-composition-note");
  box.replaceChildren();
  const composition = data.composition || {};
  const parts = composition.parts || [];
  if (note) note.textContent = parts.length ? count(composition.total_chars) + " 字符 · 按块统计，不是 token 分解" : "";
  if (!parts.length) {
    box.append(emptyNote("这条轨迹没有可统计的块。"));
    return;
  }
  const bar = el("div", "an-stack");
  for (const part of parts) {
    const meta = ANALYSIS_PART[part.key] || ANALYSIS_PART["?"];
    const segment = el("span");
    segment.style.flex = String(part.chars) + " 1 0";
    segment.style.background = meta.color;
    segment.title = meta.label + "：" + count(part.chars) + " 字符 · " + share(part.share) + " · " + (part.blocks || 0) + " 块";
    bar.append(segment);
  }
  box.append(bar);
  const legend = el("div", "an-legend");
  for (const part of parts) {
    const meta = ANALYSIS_PART[part.key] || ANALYSIS_PART["?"];
    const row = el("div", "an-legend-row");
    const dot = el("i");
    dot.style.background = meta.color;
    row.append(dot);
    row.append(el("b", "", meta.label));
    row.append(el("span", "an-num", count(part.chars) + " 字符"));
    row.append(el("span", "an-share", share(part.share)));
    row.append(el("span", "an-faint", (part.blocks || 0) + " 块"));
    legend.append(row);
  }
  box.append(legend);
}

function renderAnalysisTrend(data) {
  const box = $("an-trend");
  const note = $("an-trend-note");
  box.replaceChildren();
  const trend = data.trend || {};
  const points = trend.points || [];
  if (!points.length) {
    if (note) note.textContent = "这份 ATIF 没有 metrics.prompt_tokens：不补零，也不按归档文本估算。";
    box.append(emptyNote("没有可供绘制的服务端计数。"));
    return;
  }
  const max = points.reduce((largest, point) => Math.max(largest, point.prompt), 1);
  const cuts = points.reduce((sum, point) => sum + (point.cuts || []).length, 0);
  if (note) {
    note.textContent = points.length + " 次生成 · 峰值 " + count(trend.peak) + " tokens · 最低 " + count(trend.floor)
      + " · 每根柱是该步 ATIF 报告的 prompt_tokens"
      + (cuts ? " · " + cuts + " 个压缩边界" : "");
  }
  const track = el("div", "an-trend-track");
  points.forEach((point) => {
    const value = point.prompt;
    const column = el("button", "an-bar");
    const height = Math.max(2, Math.round((value / max) * 100));
    column.style.height = height + "%";
    column.dataset.step = String(point.step_id);
    const parts = [];
    parts.push("steps[" + point.position + "] · step " + point.step_id);
    parts.push("prompt " + count(point.prompt));
    if (point.stamp) parts.push(point.stamp);
    column.title = parts.join(" · ");
    if (point.blocks && point.blocks.length) {
      column.onclick = () => openBlock(point.blocks[point.blocks.length - 1]);
    }
    track.append(column);
    if ((point.cuts || []).length) {
      const mark = el("button", "an-cut", "✂");
      mark.title = "压缩边界 " + point.cuts.join("、") + "（在这一次生成前）";
      mark.onclick = () => openBlock(point.cuts[0]);
      track.append(mark);
    } else {
      track.append(el("span", "an-gap"));
    }
  });
  box.append(track);
}

function renderAnalysisFiles(data) {
  const box = $("an-files");
  const note = $("an-files-note");
  box.replaceChildren();
  const files = data.files || [];
  if (note) {
    const added = files.reduce((sum, file) => sum + file.added, 0);
    const removed = files.reduce((sum, file) => sum + file.removed, 0);
    note.textContent = files.length ? files.length + " 个文件 · +" + count(added) + " / −" + count(removed) + " 行（从补丁头读出）" : "";
  }
  if (!files.length) {
    box.append(emptyNote("没有可从调用参数读出的文件写入。读取/搜索类命令不计入这里。"));
    return;
  }
  const list = el("div", "an-rows");
  for (const file of files) {
    const row = el("div", "an-row");
    const name = file.path.split("/").pop() || file.path;
    const head = el("div", "an-row-head");
    const button = el("button", "an-path", name);
    button.title = file.path + (file.workdir ? "\nworkdir：" + file.workdir : "");
    head.append(button);
    for (const [op, value] of Object.entries(file.ops || {})) {
      head.append(el("span", "chip", ({
        add: "新增", update: "修改", delete: "删除", touch: "直接路径", move: "移动",
      }[op] || op) + " " + value));
    }
    head.append(el("span", "an-num good", "+" + count(file.added)));
    head.append(el("span", "an-num bad", "−" + count(file.removed)));
    head.append(el("span", "an-faint", "step " + (file.steps || []).join(", ")));
    row.append(head);
    const log = el("div", "an-log");
    log.hidden = true;
    for (const call of file.calls || []) {
      const line = el("div", "an-log-row");
      line.append(el("span", "an-faint", "step " + call.step_id));
      line.append(el("span", "", call.op));
      line.append(el("span", "an-num", "+" + count(call.added) + " / −" + count(call.removed)));
      if (call.move_to) line.append(el("span", "an-faint", "→ " + call.move_to));
      if (call.block) line.append(keyChip(call.block));
      log.append(line);
    }
    row.append(log);
    button.onclick = () => { log.hidden = !log.hidden; };
    list.append(row);
  }
  box.append(list);
}

function renderAnalysisCommands(data) {
  const box = $("an-commands");
  const note = $("an-commands-note");
  box.replaceChildren();
  const commands = data.commands || {};
  const runs = commands.runs || [];
  if (note) {
    note.textContent = runs.length
      ? commands.total + " 次调用 · " + (commands.failed || 0) + " 次非零退出"
        + (commands.wall_total !== null && commands.wall_total !== undefined ? " · 累计 " + commands.wall_total + " 秒（返回头报告）" : "")
      : "";
  }
  if (!runs.length) {
    box.append(emptyNote("这条轨迹没有 shell 调用。"));
    return;
  }
  const programs = el("div", "an-programs");
  const top = (commands.programs || [])[0];
  const ceiling = top ? top.count : 1;
  for (const program of commands.programs || []) {
    const row = el("div", "an-program");
    row.append(el("b", "", program.name));
    const bar = el("span", "an-program-bar");
    const fill = el("i");
    fill.style.width = Math.max(3, Math.round((program.count / ceiling) * 100)) + "%";
    bar.append(fill);
    row.append(bar);
    row.append(el("span", "an-num", count(program.count)));
    programs.append(row);
  }
  box.append(programs);
  const list = el("div", "an-rows");
  for (const run of runs.slice(0, 80)) {
    const row = el("div", "an-run");
    const exit = run.exit === null || run.exit === undefined ? null : run.exit;
    const badge = el("span", "chip " + (exit === null ? "" : exit === 0 ? "ok" : "bad"),
      exit === null ? "exit ?" : "exit " + exit);
    row.append(el("span", "an-faint", "step " + run.step_id));
    row.append(el("b", "an-prog", run.program || "（空）"));
    row.append(badge);
    if (run.wall !== null && run.wall !== undefined) row.append(el("span", "an-faint", run.wall + " s"));
    row.append(el("span", "an-cmd", run.cmd));
    if (run.block) row.append(keyChip(run.block));
    list.append(row);
  }
  box.append(list);
  if (runs.length > 80) box.append(el("p", "an-faint", "只列出前 80 次调用；服务端保留 " + runs.length + " 条。"));
}

function renderAnalysisNetwork(data) {
  const box = $("an-network");
  const note = $("an-network-note");
  box.replaceChildren();
  const network = data.network || {};
  const searches = network.searches || [];
  const fetches = network.fetches || [];
  if (note) note.textContent = (network.search_total || 0) + " 次检索 · " + (network.fetch_total || 0) + " 次抓取";
  if (!searches.length && !fetches.length) {
    box.append(emptyNote("这条轨迹没有 web_search / web_fetch 调用。"));
    return;
  }
  const grid = el("div", "an-two");
  const left = el("div");
  left.append(el("p", "sub", "检索词"));
  if (!searches.length) left.append(emptyNote("无"));
  for (const item of searches) {
    const row = el("div", "an-query");
    row.append(el("span", "", item.query));
    row.append(el("span", "an-num", "×" + item.count));
    left.append(row);
  }
  const right = el("div");
  right.append(el("p", "sub", "抓取来源"));
  if (!fetches.length) right.append(emptyNote("无"));
  for (const item of fetches) {
    const row = el("div", "an-query");
    row.append(el("span", "", item.host));
    row.append(el("span", "an-num", "×" + item.count));
    right.append(row);
  }
  grid.append(left);
  grid.append(right);
  box.append(grid);
}

function renderAnalysisEvents(data) {
  const chips = $("an-event-kinds");
  const box = $("an-events");
  chips.replaceChildren();
  box.replaceChildren();
  const events = data.events || {};
  const items = events.items || [];
  for (const kind of events.kinds || []) {
    const button = el("button", "", kind.label + (kind.count ? " " + kind.count : ""));
    button.setAttribute("aria-pressed", state.analysisKinds.has(kind.key) ? "true" : "false");
    button.title = "只看「" + kind.label + "」事件";
    button.onclick = () => {
      if (state.analysisKinds.has(kind.key)) state.analysisKinds.delete(kind.key);
      else state.analysisKinds.add(kind.key);
      renderAnalysisEvents(state.analysis);
    };
    chips.append(button);
  }
  const shown = state.analysisKinds.size ? items.filter((item) => state.analysisKinds.has(item.kind)) : items;
  if (!shown.length) {
    box.append(emptyNote(items.length ? "当前筛选没有匹配的事件。" : "这条轨迹没有 ATIF 声明的事件。"));
    return;
  }
  const list = el("div", "an-rows");
  for (const item of shown) {
    const row = el("div", "an-event");
    row.append(el("span", "an-faint", "step " + item.step_id));
    const label = (events.kinds || []).find((kind) => kind.key === item.kind);
    row.append(el("span", "chip " + (item.kind === "compact" ? "warn" : item.kind === "trunc" ? "bad" : ""), label ? label.label : item.kind));
    row.append(el("b", "", item.title || ""));
    row.append(el("span", "an-cmd", item.detail || ""));
    if (item.block) row.append(keyChip(item.block));
    list.append(row);
  }
  box.append(list);
}

function renderAnalysis() {
  const data = state.analysis;
  if (!data) {
    $("an-kpi").replaceChildren();
    for (const id of ["an-composition", "an-trend", "an-files", "an-commands", "an-network", "an-events"]) $(id).replaceChildren();
    $("an-events").append(emptyNote("还没有载入轨迹。"));
    return;
  }
  renderAnalysisKpi(data);
  renderAnalysisComposition(data);
  renderAnalysisTrend(data);
  renderAnalysisFiles(data);
  renderAnalysisCommands(data);
  renderAnalysisNetwork(data);
  renderAnalysisEvents(data);
}

/* --------------------------------------------------------------- interactions */

function select(key) {
  state.selected = key;
  for (const node of document.querySelectorAll(".blk, .cut-row")) {
    if (node.dataset.key === key) node.dataset.selected = "true";
    else delete node.dataset.selected;
  }
  for (const node of document.querySelectorAll(".ribbon button")) {
    if (node.dataset.key === key) node.setAttribute("aria-current", "true");
    else node.removeAttribute("aria-current");
  }
  renderInspector();
  const block = state.view.blocks.find((item) => item.key === key);
  if (block?.symbol === "C" && state.archiveView.meta.captures.available && block.references) {
    loadCompaction(block);
  } else if (block?.truncated || block?.items?.some((item) => item.truncated)) {
    loadFullText(key);
  }
}

async function loadCompaction(block) {
  if (block.captureLoading || block.captureChecked) return;
  const token = state.token;
  const view = state.view;
  block.captureLoading = true;
  try {
    const checked = await api("/api/atif/compaction?token=" + encodeURIComponent(token) + "&key=" + encodeURIComponent(block.key));
    Object.assign(block, checked, { captureChecked: true });
    if (state.token === token && state.view === view) {
      blockNode(block.key)?.replaceWith(blockRow(block));
      renderInspector();
    }
  } catch (error) {
    if (state.token === token) notice("压缩捕获读取失败：" + error.message, "error");
  } finally {
    block.captureLoading = false;
  }
}

function blockNode(key) {
  return document.querySelector('#stream [data-key="' + key + '"]');
}

function openBlock(key) {
  const mode = state.view && state.view.meta.model_context ? "h" : "archive";
  if (state.mode !== mode) switchMode(mode, true);
  if (!state.view) return;
  const block = state.view.blocks.find((item) => item.key === key);
  if (!block) return;
  if (!matches(block)) {
    state.symbols = new Set();
    state.query = "";
    state.searchResults = null;
    $("filter").value = "";
    renderLegend();
    renderStream();
  }
  const blocks = visibleBlocks();
  const index = blocks.findIndex((item) => item.key === key);
  if (index >= state.rendered || index < state.firstBlock) {
    renderStream(Math.floor(index / state.batch) * state.batch);
  }
  select(key);
  const node = blockNode(key);
  if (node && node.scrollIntoView) node.scrollIntoView({ block: "center", behavior: "smooth" });
}

function renderInspector() {
  const panel = $("inspector");
  panel.replaceChildren();
  panel.append(el("h2", "", "选中块"));
  panel.append(el("p", "sub", "PROVENANCE"));
  if (!state.view) {
    panel.append(el("p", "empty", "还没有载入轨迹。"));
    return;
  }
  const block = state.view.blocks.find((item) => item.key === state.selected);
  if (!block) {
    panel.append(el("p", "empty", "点击序列中的任意块：这里显示它的字段来源、ATIF 声明与关联请求。用 j / k 移动，Enter 展开或收起。"));
    return;
  }
  const dl = el("dl");
  const row = (name, value) => {
    dl.append(el("dt", "", name));
    const dd = el("dd");
    if (value && value.nodeType) dd.append(value);
    else dd.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
    dl.append(dd);
  };
  row("记号", notation(block.symbol, block.index) + " · " + SYMBOLS[block.symbol].label);
  row("标题", block.title);
  const st = STATES[block.state] || STATES.unknown;
  row("状态", st.label + "（" + (block.state_note || st.note) + "）");
  if (block.role) row(block.rendered_context ? "语义角色" : "原始角色", block.role);
  if (block.step_id !== null && block.step_id !== undefined) row("step_id", String(block.step_id));
  if (block.order !== null && block.order !== undefined) row("位置 E", "#" + block.order + "（初始前缀之后第 " + (block.order + 1) + " 个文本块）");
  if (block.symbol !== "C") row("长度", count(block.chars) + " 字符" + (block.truncated ? "（当前为预览）" : ""));
  if (block.call) {
    const bits = [];
    if (block.call.request) bits.push(block.call.request);
    if (block.call.prompt_tokens) bits.push("输入 " + count(block.call.prompt_tokens) + " tok（服务端报告）");
    if (block.call.completion_tokens) bits.push("输出 " + count(block.call.completion_tokens) + " tok");
    row("该次调用", bits.join(" · "));
  }
  if (block.provenance && block.provenance.length) row("字段来源", block.provenance.join(" · "));
  if (block.flags && block.flags.length) row("标记", block.flags.join(" · "));
  if (block.symbol === "C") {
    row("边界", block.boundary);
    row("压缩前 / 后", (block.before && block.before.messages !== null ? block.before.messages : "?") + " / "
      + (block.after && block.after.messages !== null ? block.after.messages : "?") + " 条消息");
    if (block.checks && block.checks.length) {
      const list = el("ul", "checks");
      appendChecked(list, block.checks);
      row("核对", list);
    }
  }
  panel.append(dl);
  const actions = el("div", "blk-actions");
  if (block.symbol !== "C" && block.truncated) {
    const load = el("button", "mini", "载入完整文本");
    load.onclick = () => loadFullText(block.key);
    actions.append(load);
  }
  if (block.request) {
    const open = el("button", "mini", "在请求视图查看 " + block.request);
    open.onclick = () => {
      switchMode("v", true);
      openRequest(block.request);
    };
    actions.append(open);
  }
  if (state.rawHref) {
    const raw = el("a", "mini", "原始 ATIF");
    raw.href = state.rawHref;
    raw.download = state.filename;
    actions.append(raw);
  }
  panel.append(actions);
}

/* -------------------------------------------------------------- request view */

function hideReferenceTokens() {
  state.referenceRequest++;
  $("reference-tokens").hidden = true;
  $("reference-token-panel").replaceChildren();
  $("reference-token-panel").hidden = true;
}

async function showReferenceTokens(start = 0) {
  if (!state.contextId) return;
  const panel = $("reference-token-panel");
  const request = ++state.referenceRequest;
  const token = state.token;
  const context = state.contextId;
  panel.hidden = false;
  panel.replaceChildren(el("p", "hintline", "正在为当前窗口载入 tokenizer 并分词…"));
  try {
    const page = await api("/api/atif/context/tokens?token=" + encodeURIComponent(token) +
      "&context=" + encodeURIComponent(context) + "&start=" + start);
    if (request !== state.referenceRequest) return;
    panel.replaceChildren(el("h2", "", "当前窗口的参考分词"),
      el("p", "hintline", "DeepSeek V4.1 Flash tokenizer 对同一份重建文本分词。共 " + count(page.total) + " 个参考 token。"));
    const grid = el("div", "token-grid");
    const detail = el("p", "hintline", "点一个 token 查看索引、ID 和字符范围。");
    for (const [i, item] of page.tokens.entries()) {
      const chip = el("button", "token format", item.piece.replaceAll("\n", "↵"));
      const label = "#" + (page.start + i) + " · ID " + item.id + " · 字符 " + item.offset.join("–");
      chip.title = label;
      chip.onclick = () => { detail.textContent = label; };
      grid.append(chip);
    }
    const buttons = el("div", "source-bar");
    const previous = el("button", "btn secondary", "上一批");
    previous.disabled = page.start === 0;
    previous.onclick = () => showReferenceTokens(page.start - 200);
    const next = el("button", "btn secondary", "下一批");
    next.disabled = page.end >= page.total;
    next.onclick = () => showReferenceTokens(page.end);
    buttons.append(previous, el("span", "hint", page.start + "–" + page.end + " / " + count(page.total)), next);
    panel.append(grid, detail, buttons);
  } catch (error) {
    if (request === state.referenceRequest) panel.replaceChildren(el("p", "empty", "参考分词失败：" + error.message));
  }
}

async function loadTemplatePrefix(start = 0) {
  if (!state.archiveView || !state.token) return;
  const token = state.token;
  const thinking = $("prefix-thinking").checked ? "1" : "0";
  const effort = $("prefix-effort").value || "max";
  const selection = $("context-selection").value || "all";
  const key = [token, thinking, effort, selection].join(":");
  const request = ++state.prefixRequest;
  hideReferenceTokens();
  const body = $("prefix-body");
  body.replaceChildren(el("p", "hintline", "正在渲染模型上下文…"));
  try {
    const data = await api("/api/atif/context?token=" + encodeURIComponent(token) +
      "&thinking=" + thinking + "&effort=" + encodeURIComponent(effort) +
      "&selection=" + encodeURIComponent(selection) + "&start=" + start + "&limit=24000&view=" + (state.contextKey === key ? "0" : "1"));
    if (state.token !== token || request !== state.prefixRequest) return;
    if (data.view) state.modelView = data.view;
    state.contextId = data.id;
    state.contextKey = key; state.contextStart = data.start;
    contextChoices(data.choices, data.selection);
    $("reference-tokens").hidden = false;
    body.replaceChildren(el("p", "hintline", "按所选规则重建，历史输入未逐条核验。合并初始 System；Schema 顺序 name → description → parameters → strict。"));
    if (data.selection === "all") body.append(el("p", "hintline", "完整窗口包含模型已生成的输出，并非同一次推理请求的输入。可选择某个「生成前」位置。"));
    if ((data.unrendered_provider_tools || []).length) {
      body.append(el("p", "hintline", "上下文不完整：保留了未解析的供应商声明，尚未补入其服务端工具说明。"));
      const unresolved = el("details", "item"); unresolved.append(el("summary", "item-name", "未解析的供应商声明"));
      unresolved.append(textBlock(JSON.stringify(data.unrendered_provider_tools, null, 2))); body.append(unresolved);
    }
    const pre = textBlock(data.text); pre.classList.add("open"); body.append(pre);
    const evidence = el("details", "item"); evidence.append(el("summary", "item-name", "文本校验与渲染依据"));
    evidence.append(textBlock(JSON.stringify({ sha256: data.id, h_text_sha256: data.h_text_sha256,
      trace_text_invariance: data.trace_text_invariance, profile: data.profile, template: data.template,
      settings: data.settings, excluded_model_invisible_fields: data.excluded_model_invisible_fields }, null, 2))); body.append(evidence);
    $("context-pages").textContent = "第 " + (Math.floor(data.start / data.page_size) + 1) + " / " + data.pages + " 页 · 字符 " + data.start + "–" + data.end + " / " + data.total_characters;
    $("context-prev").disabled = data.start === 0; $("context-next").disabled = data.end >= data.total_characters;
    $("context-prev").onclick = () => loadTemplatePrefix(Math.max(0, data.start - data.page_size));
    $("context-next").onclick = () => loadTemplatePrefix(data.end);
    if (state.mode === "h" && state.modelView) {
      state.view = state.modelView;
      renderLegend(); renderBoundary(); renderToolDefinitions(); renderRibbon(); renderStream(); renderInspector();
      notice("序列 H：与模型上下文全文逐字一致的可读分段。历史输入未逐条核验；未解析托管声明仍单独标注。");
    }
  } catch (error) {
    if (state.token === token && request === state.prefixRequest) {
      body.replaceChildren(el("p", "empty", "无法构造模型上下文：" + error.message));
      if (state.mode === "h") $("stream").replaceChildren(el("li", "empty-state", "模型上下文不可用：" + error.message + "。请切换 ATIF 记录查看原始字段。"));
    }
  }
}

function switchMode(mode, silent) {
  const previous = state.mode;
  state.mode = mode;
  if (mode !== previous && ["h", "archive"].includes(mode)) {
    state.query = "";
    state.searchResults = null;
    $("filter").value = "";
  }
  $("view-h").hidden = !["h", "archive"].includes(mode);
  $("view-v").hidden = mode !== "v";
  $("view-analysis").hidden = mode !== "analysis";
  $("view-prefix").hidden = mode !== "prefix";
  for (const [id, value] of [["tab-h", "h"], ["tab-v", "v"], ["tab-analysis", "analysis"], ["tab-prefix", "prefix"], ["tab-archive", "archive"]]) {
    if ($(id)) $(id).setAttribute("aria-selected", mode === value ? "true" : "false");
  }
  $("ribbon").hidden = !["h", "archive"].includes(mode);
  $("filter").hidden = !["h", "archive"].includes(mode);
  $("counts").hidden = !["h", "archive"].includes(mode);
  if (mode === "analysis") {
    state.view = state.archiveView;
    renderAnalysis();
    notice("分析：组成、趋势、事件与活动都直接读自这份 ATIF；趋势只画 metrics 报告的服务端计数。");
  }
  if (mode === "archive" || mode === "v") {
    state.view = state.archiveView;
    if (state.view && mode === "archive") { renderLegend(); renderBoundary(); renderToolDefinitions(); renderRibbon(); renderStream(); renderInspector(); }
    if (mode === "v") renderRequestList();
    if (mode === "archive") notice("ATIF 记录：原始字段映射，不冒充模型渲染上下文。");
  }
  if (mode === "h") {
    if (state.modelView) { state.view = state.modelView; renderLegend(); renderBoundary(); renderRibbon(); renderStream(); renderInspector(); }
    else $("stream").replaceChildren(el("li", "empty-state", "正在构造模型上下文…"));
  }
  if (["h", "prefix"].includes(mode) && !silent) loadTemplatePrefix(state.contextStart || 0);
}

function renderRequestList() {
  const list = $("requests");
  list.replaceChildren();
  if (!state.view) return;
  if (!state.view.requests.length) {
    list.append(el("li", "empty-state", "这条轨迹没有捕获请求。ATIF 事件仍可在「ATIF 记录」中阅读，但不能声称任何一次请求实际看到的前缀。"));
    $("request-body").replaceChildren(el("p", "empty", "没有可展开的请求快照。"));
    return;
  }
  const start = state.requestPage * 40;
  for (const request of state.view.requests.slice(start, start + 40)) {
    const item = el("li");
    const button = el("button");
    if (state.activeRequest === request.id) button.setAttribute("aria-current", "true");
    button.append(el("span", "q", "Q" + subscript(request.position)));
    button.append(el("span", "rid", request.id));
    const row = el("span", "row");
    const stage = el("span", "chip " + (request.stage === "summary" || request.stage === "compaction" ? "warn" : ""), STAGE[request.stage] || request.stage || "policy");
    row.append(stage);
    if (request.tokens_match === false) row.append(el("span", "chip bad", "计数不一致"));
    else if (request.server_prompt_tokens) row.append(el("span", "chip ok", count(request.server_prompt_tokens) + " tok"));
    button.append(row);
    button.onclick = () => openRequest(request.id);
    item.append(button);
    list.append(item);
  }
  if (state.view.requests.length > 40) {
    const controls = el("li", "source-bar");
    const previous = el("button", "btn secondary", "前一批");
    previous.disabled = !state.requestPage;
    previous.onclick = () => { state.requestPage--; renderRequestList(); };
    const next = el("button", "btn secondary", "后一批");
    next.disabled = start + 40 >= state.view.requests.length;
    next.onclick = () => { state.requestPage++; renderRequestList(); };
    controls.append(previous, next);
    list.append(controls);
  }
}

function subscript(value) {
  return String(value).split("").map((d) => SUBSCRIPT[Number(d)] || d).join("");
}

async function openRequest(id) {
  const token = state.token;
  const index = state.archiveView.requests.findIndex((request) => request.id === id);
  if (index < 0) return;
  state.requestPage = Math.floor(index / 40);
  state.activeRequest = id;
  renderRequestList();
  const panel = $("request-body");
  const cached = state.requests.get(id);
  panel.replaceChildren(el("p", "empty", "正在读取 " + id + " 的捕获快照…"));
  if (cached) {
    renderRequestPanel(cached);
    return;
  }
  try {
    const snapshot = await api("/api/atif/request?token=" + encodeURIComponent(state.token) + "&id=" + encodeURIComponent(id));
    if (token !== state.token) return;
    state.requests.set(id, snapshot);
    if (state.requests.size > 3) state.requests.delete(state.requests.keys().next().value);
    if (state.activeRequest === id) renderRequestPanel(snapshot);
  } catch (error) {
    if (token === state.token && state.activeRequest === id) panel.replaceChildren(el("p", "empty", "读取失败：" + error.message));
  }
}

function renderRequestPanel(snapshot) {
  const panel = $("request-body");
  panel.replaceChildren();
  const request = snapshot.request;
  const title = el("h2", "", "Q" + subscript(request.position) + " · " + request.id);
  panel.append(title);
  panel.append(el("p", "rid", "stage " + (request.stage || "policy") + (request.step_id !== null ? " · steps[" + request.step_id + "]" : "")));

  if (!snapshot.captures.available) {
    panel.append(el("p", "blk-note", snapshot.note || "该轨迹没有可读取的捕获目录。"));
    const stats = el("div", "stat-row");
    stats.append(stat("消息", request.messages, ""));
    stats.append(stat("工具定义", request.tools, ""));
    stats.append(stat("服务端输入", request.server_prompt_tokens, "tok"));
    panel.append(stats);
    panel.append(el("p", "blk-note", "不能仅凭 ATIF 声明恢复这次请求的消息或渲染输入。"));
    return;
  }

  const stats = el("div", "stat-row");
  stats.append(stat("消息", snapshot.messages.length, "条"));
  stats.append(stat("工具定义", request.tools, "个"));
  stats.append(stat("服务端输入", request.server_prompt_tokens, "tok"));
  stats.append(stat("本地重建", request.local_prompt_tokens, "tok", request.tokens_match === false));
  if (request.tokens_match === false) stats.append(stat("差值", (request.tokens_delta > 0 ? "+" : "") + request.tokens_delta, "tok", true));
  panel.append(stats);

  if (snapshot.note && !snapshot.messages.length) panel.append(el("p", "blk-note", snapshot.note));
  if (request.tokens_match === false) {
    const warn = el("p", "blk-note", "本地重建 " + count(request.local_prompt_tokens) + " ≠ 服务端 " + count(request.server_prompt_tokens)
      + "（" + (request.tokens_delta > 0 ? "+" : "") + count(request.tokens_delta) + "）。计数不同时，本地序列不能当作服务端实收。");
    warn.style.setProperty("color", "var(--warn)");
    panel.append(warn);
  }

  const visible = el("div", "visible");
  visible.append(el("h3", "", "可见上下文 V(" + request.position + ")"));
  const row = el("div", "row");
  for (const entry of snapshot.visible) {
    if (entry.key) row.append(keyChip(entry.key));
    else {
      const chip = el("span", "key injected", (entry.injected_by || "C") + " 注入");
      chip.title = entry.title || "由压缩操作注入的消息";
      row.append(chip);
    }
  }
  visible.append(row);
  if (snapshot.unmatched.length) {
    visible.append(el("p", "note", snapshot.unmatched.length + " 条消息在归档序列中没有对应块"
      + (snapshot.unmatched.some((item) => item.injected_by) ? "；其中带 C 记号的由压缩操作注入" : "；它们可能是本次请求新增的指令") + "。"));
  }
  panel.append(visible);

  if (snapshot.checks && snapshot.checks.length) {
    const checks = el("ul", "checks");
    appendChecked(checks, snapshot.checks);
    panel.append(checks);
  }

  const tabs = el("div", "inline-tabs");
  const options = [["messages", "消息"], ["prompt", "渲染输入 P̂"]];
  if (snapshot.chat_request) options.push(["chat", "Chat 请求"]);
  if (snapshot.response) options.push(["response", "响应"]);
  options.push(["files", "捕获文件"]);
  if (!options.some(([key]) => key === state.requestTab)) state.requestTab = "messages";
  for (const [key, label] of options) {
    const button = el("button", "", label);
    button.setAttribute("aria-selected", state.requestTab === key ? "true" : "false");
    button.onclick = () => {
      state.requestTab = key;
      renderRequestPanel(snapshot);
    };
    tabs.append(button);
  }
  tabs.append(el("span", "grow"));
  if (snapshot.prompt) tabs.append(download("下载渲染输入", request.id + ".rendered_prompt"));
  if (snapshot.chat_request) tabs.append(download("下载 Chat 请求", request.id + ".chat_request"));
  panel.append(tabs);

  if (state.requestTab === "messages") panel.append(messagesView(snapshot, request));
  if (state.requestTab === "prompt") panel.append(promptView(snapshot));
  if (state.requestTab === "chat") panel.append(preView(snapshot.chat_request.text, "捕获的 Chat 请求 JSON"));
  if (state.requestTab === "response") panel.append(responseView(snapshot));
  if (state.requestTab === "files") panel.append(filesView(snapshot));
}

function stat(label, value, unit, bad) {
  const node = el("div", "stat" + (bad ? " bad" : ""));
  node.append(el("small", "", label));
  const strong = el("b", "", (typeof value === "number" ? count(value) : value === null || value === undefined ? "—" : String(value)));
  node.append(strong);
  if (unit) node.append(document.createTextNode(" " + unit));
  return node;
}

function download(label, ref) {
  const link = el("button", "mini", label);
  link.onclick = async (event) => {
    event.stopPropagation();
    const path = "/api/atif/file?token=" + encodeURIComponent(state.token) + "&ref=" + encodeURIComponent(ref);
    try { await trajectorySource.download(path); }
    catch (error) { notice("捕获文件读取失败：" + error.message, "error"); }
  };
  return link;
}

function messagesView(snapshot, request) {
  const box = el("div");
  box.append(el("h3", "", "Chat 消息（按捕获原文）"));
  if (!snapshot.messages.length) {
    box.append(el("p", "blk-note", snapshot.note || "这次请求没有可解码的消息。"));
    return box;
  }
  const list = el("ul", "msg-list");
  for (const message of snapshot.messages) {
    const row = el("li", "msg" + (message.matched ? "" : " unmatched"));
    const role = message.role || "?";
    const sym = role === "user" ? "U" : role === "system" ? "S" : role === "tool" ? "O" : "M";
    row.style.setProperty("--sym", color(sym));
    const head = el("div", "msg-head");
    head.append(el("span", "role " + role, role));
    for (const part of message.parts) head.append(keyChip(part.block));
    if (message.injected_by) {
      const chip = el("span", "chip warn", "由 " + message.injected_by + " 注入");
      chip.title = "这条消息由压缩操作包装摘要后写入，不是归档中的 U 步";
      head.append(chip);
    }
    const meta = el("span", "meta", "#" + message.index + " · " + count(message.chars) + " 字符");
    head.append(meta);
    row.append(head);
    const pre = el("pre");
    const body = message.content || "";
    pre.textContent = body.length > 1600 ? body.slice(0, 1600) + "\n…（点击展开全部）" : (body || "（空 content）");
    pre.onclick = () => {
      pre.classList.toggle("open");
      pre.textContent = pre.classList.contains("open") ? (body || "（空 content）") : (body.length > 1600 ? body.slice(0, 1600) + "\n…（点击展开全部）" : (body || "（空 content）"));
    };
    row.append(pre);
    if (message.reasoning) {
      const details = el("details", "item");
      const summary = el("summary");
      summary.append(el("span", "item-name", "reasoning_content"));
      summary.append(el("span", "item-meta", count(message.reasoning.length) + " 字符"));
      details.append(summary);
      details.append(textBlock(message.reasoning, { dim: true }));
      row.append(details);
    }
    if (!message.matched) {
      row.append(el("p", "why", message.injected_by
        ? "归档里没有对应的 U 步：该消息由 " + message.injected_by + " 的摘要包装后注入。"
        : "归档里没有对应块：可能是本次请求新增的指令，ATIF 不为它记录步骤。"));
    }
    list.append(row);
  }
  box.append(list);
  if (request.messages !== snapshot.messages.length) {
    box.append(el("p", "blk-note", "ATIF 声明 " + request.messages + " 条消息，捕获请求为 " + snapshot.messages.length + " 条。"));
  }
  return box;
}

function promptView(snapshot) {
  const box = el("div");
  if (!snapshot.prompt) {
    box.append(el("p", "empty", "这次请求没有 captured 渲染输入。"));
    return box;
  }
  box.append(el("h3", "", "本地重建的渲染输入 P̂"));
  box.append(el("p", "blk-note", snapshot.prompt.note + " 末尾：" + (snapshot.prompt.tail || "").slice(-40)));
  if (snapshot.token_ids) {
    box.append(el("p", "blk-note", "本地重建 " + count(snapshot.token_ids.count) + " tokens；开头 ID " + JSON.stringify(snapshot.token_ids.head)
      + "，结尾 ID " + JSON.stringify(snapshot.token_ids.tail) + "。"));
    if (snapshot.token_ids.note) box.append(el("p", "blk-note", snapshot.token_ids.note));
  }
  box.append(preView(snapshot.prompt.text, null, 60));
  return box;
}

function responseView(snapshot) {
  const box = el("div");
  box.append(el("h3", "", "捕获的模型返回"));
  box.append(el("p", "blk-note", "API 返回字段，不含服务端原始输出 token ID；界面不补造特殊标记。"));
  box.append(preView(snapshot.response.text, null, 40));
  return box;
}

function preView(text, label, rows) {
  const box = el("div");
  if (label) box.append(el("h3", "", label));
  const pre = el("pre", "pre-box");
  pre.textContent = text;
  if (rows) pre.style.maxHeight = rows + "vh";
  box.append(pre);
  return box;
}

function filesView(snapshot) {
  const box = el("div");
  box.append(el("h3", "", "该请求的捕获文件"));
  const table = el("table", "file-table");
  const head = el("tr");
  for (const label of ["文件", "SHA256 核对", "大小", ""]) head.append(el("th", "", label));
  table.append(head);
  for (const file of snapshot.files) {
    const row = el("tr");
    row.append(el("td", "path", file.kind + " · " + file.path));
    const ok = el("td");
    ok.append(el("span", "chip " + (file.verified ? "ok" : "bad"), file.verified ? "✓ 已核对" : "✗ " + (file.error || "失败")));
    row.append(ok);
    row.append(el("td", "", bytes(file.bytes)));
    const action = el("td");
    if (file.verified) {
      action.append(download("下载", snapshot.request.id + "." + file.kind));
    }
    row.append(action);
    table.append(row);
  }
  box.append(table);
  box.append(el("p", "blk-note", "每个文件都按 ATIF 记录的 SHA256 校验；缺失或不匹配时页面直接报错，不做替代重建。"));
  return box;
}

/* --------------------------------------------------------------------- init */


let searchTimer;
function searchBlocks() {
  clearTimeout(searchTimer);
  state.query = $("filter").value.trim();
  state.searchResults = null;
  renderStream();
  const { token, query, view } = state;
  if (!query || !view?.blocks.some((block) => block.truncated || block.items?.some((item) => item.truncated))) return;
  searchTimer = setTimeout(async () => {
    try {
      const context = view.meta.model_context;
      const hits = await api("/api/atif/search?token=" + encodeURIComponent(token) + "&q=" + encodeURIComponent(query) +
        (context ? "&context=" + encodeURIComponent(context) : ""));
      if (state.query !== query || state.token !== token || state.view !== view) return;
      state.searchResults = new Set(hits);
      renderStream();
    } catch (error) {
      if (state.query === query && state.view === view) notice("查找完整文本失败：" + error.message, "error");
    }
  }, 180);
}

function init() {
  state.mode = "archive";
  $("tab-h").onclick = () => switchMode("h");
  $("tab-v").onclick = () => switchMode("v");
  if ($("tab-analysis")) $("tab-analysis").onclick = () => switchMode("analysis");
  if ($("tab-prefix")) $("tab-prefix").onclick = () => switchMode("prefix");
  if ($("tab-archive")) $("tab-archive").onclick = () => switchMode("archive");
  for (const id of ["prefix-thinking", "prefix-effort", "context-selection"]) {
    if ($(id)) $(id).onchange = () => { state.contextKey = null; state.modelView = null; state.contextStart = 0; if (["h", "prefix"].includes(state.mode)) loadTemplatePrefix(); };
  }
  if ($("prefix-reload")) $("prefix-reload").onclick = () => { state.contextKey = null; state.modelView = null; loadTemplatePrefix(); };
  $("reference-tokens").onclick = () => showReferenceTokens();
  $("sample").onclick = loadSample;
  $("file").onchange = () => {
    openFile($("file").files[0]);
    $("file").value = "";
  };
  $("folder").onchange = () => {
    if ($("folder").files.length) loadFolder(Array.from($("folder").files));
    $("folder").value = "";
  };
  $("library-select").onchange = () => {
    if ($("library-select").value) openFile(folderFiles[Number($("library-select").value)], folderFiles);
  };
  $("more").onclick = () => appendBlocks();
  $("prev-batch").onclick = () => renderStream(Math.max(0, state.firstBlock - state.batch));
  $("filter").oninput = searchBlocks;
  $("boundary-open").onclick = () => $("boundary-dialog").showModal();

  document.addEventListener("keydown", (event) => {
    const tag = (event.target && event.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
      if (event.key === "Escape" && event.target === $("filter")) {
        $("filter").value = "";
        searchBlocks();
        $("filter").blur();
      }
      return;
    }
    if (event.key === "/") {
      event.preventDefault();
      $("filter").focus();
      return;
    }
    if (!state.view || !["h", "archive"].includes(state.mode)) return;
    const blocks = visibleBlocks();
    if (!blocks.length) return;
    const at = blocks.findIndex((block) => block.key === state.selected);
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      openBlock(blocks[Math.min(blocks.length - 1, at + 1 < 0 ? 0 : at + 1)].key);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      openBlock(blocks[Math.max(0, at - 1 < 0 ? 0 : at - 1)].key);
    } else if (event.key === "Enter" && state.selected) {
      const node = blockNode(state.selected);
      const pre = node && node.querySelector(".blk-text");
      if (pre) pre.classList.toggle("open");
    } else if (event.key === "Escape") {
      state.query = "";
      state.searchResults = null;
      $("filter").value = "";
      state.symbols = new Set();
      renderLegend();
      renderStream();
    }
  });

  loadSample();
}

init();
