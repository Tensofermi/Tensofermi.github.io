"""ATIF archive -> context notation stream (S, U, R, M, T, O, C).

This module is the read-only bridge between an ATIF file and the notation
defined in ``docs/context-notation.md``. It deliberately does only three
things:

1. Map each ``steps[i]`` field to the semantic block it carries. One assistant
   step can produce several blocks (reasoning, body, call group, return group);
   an ATIF step is not treated as one prompt message.
2. Read the per-call sidecars of a request, when the ATIF file ships them, so a
   request's visible context is taken from the captured request instead of being
   guessed by concatenating the archive.
3. Report what cannot be known: text is never tokenized per block (a sum of
   per-block counts is not a request's input length), and a missing sidecar is
   an error message, not a reconstruction.

``prepare()`` keeps full text in memory; ``public()`` caps it for transport and
the caller can request one block's full text again. Both are pure functions of
their arguments so tests can run without a server.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from atif_capture import CaptureError, CaptureStore

ROOT = Path(__file__).resolve().parent
DEFAULT_DIR = ROOT / "run-data" / "atif"
TEXT_CAP = 6000
PREVIEW_CAP = 240
MAX_ITEMS = 64
REQUEST_ID = re.compile(r"request-(\d+)")

SYMBOLS = {
    "S": {"label": "初始前缀"},
    "U": {"label": "用户侧输入"},
    "R": {"label": "推理"},
    "M": {"label": "assistant 正文"},
    "T": {"label": "工具调用"},
    "O": {"label": "工具返回"},
    "C": {"label": "压缩操作"},
    "?": {"label": "未识别的 source"},
}

# Top-level tag -> reading title. Splitting is presentation only: the underlying
# protocol still carries one message, so sub-blocks are marked "narrative".
SUB_TITLES = {
    "skills_instructions": "Skills 目录与规则",
    "permissions": "权限与沙箱",
    "environment_context": "路径与环境",
    "codex_internal_context": "Goal 上下文",
    "user_instructions": "用户指令",
    "developer_instructions": "开发者指令",
    "instructions": "指令",
    "INSTRUCTIONS": "AGENTS.md 指令",
    "personality": "人格设定",
    "collaboration_mode": "协作模式",
    "tool_definitions": "工具定义",
}

OPEN_RE = re.compile(r"<([A-Za-z_][\w\-]*)((?:\s[^<>]*)?)>")
CLOSE_RE = re.compile(r"</([A-Za-z_][\w\-]*)[^<>]*>")

NOTES = {
    "archive": "序列 H 按 ATIF 事件顺序排列；它本身不是任一次请求实际看到的前缀。",
    "request": "请求视图只使用该次调用的捕获快照；没有快照就不重建。",
    "tokens": "块文本不做分词：逐块 token 相加不等于请求输入长度。请求 token 只取自 ATIF metrics 或捕获元数据。",
    "narrative": "S/U 的子块按顶层标签切分，仅供阅读；底层仍是同一条消息。",
    "compaction": "压缩边界是控制元数据，不是追加进提示词的文本。保留与丢弃范围按捕获的消息数组逐条核对。",
}


class TrajectoryError(ValueError):
    """The ATIF file cannot be shown; the message is safe for the UI."""


# ---------------------------------------------------------------- file library

def library_dirs():
    raw = os.environ.get("TRAJ_ATIF_DIR")
    if raw and raw.strip():
        return [Path(part).expanduser() for part in raw.split(os.pathsep) if part.strip()]
    return [DEFAULT_DIR]


def library():
    directories, files, seen = [], [], set()
    for directory in library_dirs():
        entry = {"path": str(directory), "exists": directory.is_dir(), "files": 0}
        if entry["exists"]:
            for path in sorted(directory.glob("*.json")):
                entry["files"] += 1
                if path.name in seen:
                    continue
                seen.add(path.name)
                stat = path.stat()
                files.append({"name": path.name, "directory": str(directory), "bytes": stat.st_size,
                              "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()})
        directories.append(entry)
    files.sort(key=lambda item: item["modified"], reverse=True)
    return {"directories": directories, "files": files, "env": "TRAJ_ATIF_DIR",
            "note": "目录中的 *.json 视为 ATIF 文件；只读取，不改动。"}


def resolve_name(name):
    """Locate a library file by plain file name, refusing any path traversal."""
    if not isinstance(name, str) or not name or Path(name).name != name or not name.endswith(".json"):
        raise TrajectoryError("文件名为空、含路径或以非 .json 结尾")
    for directory in library_dirs():
        if not directory.is_dir():
            continue
        path = (directory / name).resolve()
        if path.is_file() and path.parent == directory.resolve():
            return path, directory
    raise TrajectoryError(f"目录中找不到文件：{name}")


def load_named(name):
    path, directory = resolve_name(name)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise TrajectoryError(f"不是合法 JSON：{exc}") from exc
    return data, path, directory, name


# -------------------------------------------------------------------- helpers

def _notation(symbol, index):
    if symbol == "S":
        return "S" + ("" if index == 0 else str(index).translate(str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉")))
    return symbol + str(index).translate(str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉"))


def _text_of(value):
    """ATIF text field -> string. Non-text payloads are serialized, never dropped."""
    if isinstance(value, str):
        return value
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False, indent=2)


def _flatten_content(value):
    """Chat message content -> comparable text (string or list-of-parts)."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                for key in ("text", "content", "input_text"):
                    if isinstance(item.get(key), str):
                        parts.append(item[key])
                        break
        return "\n".join(parts)
    if value is None:
        return ""
    return json.dumps(value, ensure_ascii=False)


def _signature(message):
    return json.dumps(message, ensure_ascii=False, sort_keys=True)


def _extra(step):
    return step.get("extra") if isinstance(step.get("extra"), dict) else {}


def _tags(text):
    return {match.group(1) for match in OPEN_RE.finditer(text or "")}


def _first_line(text, limit=42):
    for line in (text or "").splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return line[:limit] + ("…" if len(line) > limit else "")
    return "空文本"


def _split_subblocks(text, limit=MAX_ITEMS):
    """Split top-level ``<tag>...</tag>`` blocks out of a prompt string.

    Ported in spirit from the earlier viewer, but capped and explicitly marked
    as a reading aid. Returns [] when there is nothing worth splitting.
    """
    text = text or ""
    blocks, stack, cursor, pos = [], [], 0, 0
    while pos < len(text) and len(blocks) < limit:
        open_match = OPEN_RE.search(text, pos)
        close_match = CLOSE_RE.search(text, pos)
        if open_match is None and close_match is None:
            break
        if open_match is not None and (close_match is None or open_match.start() <= close_match.start()):
            if not stack:
                if open_match.start() > cursor:
                    blocks.append({"tag": None, "attrs": "", "text": text[cursor:open_match.start()]})
                cursor = open_match.start()
            stack.append(open_match)
            pos = open_match.end()
        else:
            name = close_match.group(1)
            at = next((i for i in range(len(stack) - 1, -1, -1) if stack[i].group(1) == name), None)
            if at is None:
                pos = close_match.end()
                continue
            opener = stack[at]
            del stack[at:]
            pos = close_match.end()
            if not stack:
                blocks.append({"tag": name, "attrs": (opener.group(2) or "").strip(),
                               "text": text[opener.end():close_match.start()], "raw": text[cursor:pos]})
                cursor = pos
    if cursor < len(text):
        blocks.append({"tag": None, "attrs": "", "text": text[cursor:]})

    out = []
    for index, block in enumerate(blocks):
        body = (block.get("text") or "").strip("\n")
        if not body.strip():
            continue
        tag = block.get("tag")
        title = SUB_TITLES.get(tag, tag) if tag else "附加文本"
        attrs = block.get("attrs") or ""
        if tag and "=" in attrs:
            title = f"{title} · {attrs}"
        out.append({"key": f".{index + 1}", "tag": tag, "attrs": attrs, "title": title,
                    "chars": len(body), "text": body, "evidence": "narrative"})
    return out if len(out) > 1 else []


def _training_state(step, symbol):
    """Return (state, note) using only what the ATIF actually declares.

    ``summary`` marks the compaction summary body even though the step also
    carries ``trainable=false``: it is not a training target, but it is the
    source of a later compaction, so the two facts must not collapse.
    """
    extra = _extra(step)
    kind = extra.get("call_kind")
    if kind == "failed_attempt" or extra.get("failed_attempt") or step.get("failed_attempt"):
        return "ignored", "failed_attempt：整步不进入训练"
    if step.get("incomplete") or extra.get("incomplete"):
        return "ignored", "incomplete：这次生成未完成"
    if kind == "summary":
        if symbol == "M":
            return "summary", "call_kind=summary：摘要正文 Σ，不是训练目标"
        return "ignored", "call_kind=summary：摘要调用的推理，不进入后续输入"
    trainable = extra.get("trainable")
    if trainable is True:
        return "target", "ATIF 声明 trainable=true"
    if trainable is False:
        return "ignored", "ATIF 声明 trainable=false"
    if kind == "policy":
        return "target", "call_kind=policy"
    if isinstance(kind, str) and kind:
        return "ignored", f"call_kind={kind}"
    return "unknown", "ATIF 未声明 call_kind/trainable"


def _request_id_for(step):
    capture = _extra(step).get("capture")
    if not isinstance(capture, dict):
        return None
    for key in ("chat_request", "request_meta", "rendered_prompt"):
        reference = capture.get(key)
        if isinstance(reference, dict) and isinstance(reference.get("path"), str):
            found = REQUEST_ID.search(reference["path"])
            if found:
                return f"request-{int(found.group(1)):03d}"
    return None


def _block(key, symbol, index, **fields):
    block = {"key": key, "symbol": symbol, "index": index, "notation": _notation(symbol, index),
             "label": SYMBOLS[symbol]["label"], "title": "", "role": None, "state": "condition",
             "state_note": "", "step_id": None, "order": None, "text": "", "chars": 0,
             "items": [], "provenance": [], "request": None, "call": None, "flags": [],
             "evidence": "atif"}
    block.update(fields)
    block["chars"] = len(block["text"])
    return block


# ------------------------------------------------------------- capture reading

def _read_messages(store, reference, warnings, label):
    if not store or not reference:
        return None
    try:
        value = store.json(reference)
    except CaptureError as exc:
        warnings.append(f"{label}：{exc}")
        return None
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        warnings.append(f"{label}：期望消息数组")
        return None
    return value


def _lookups(blocks):
    text, reasoning, calls, observations, order = {}, {}, {}, {}, {}
    for block in blocks:
        if block.get("order") is not None:
            order[block["key"]] = block["order"]
        symbol = block["symbol"]
        if symbol in ("S", "U", "M") and block["text"]:
            text.setdefault((block["role"], block["text"]), block["key"])
        elif symbol == "R" and block["text"]:
            reasoning.setdefault(block["text"], block["key"])
        elif symbol in ("T", "O"):
            target = calls if symbol == "T" else observations
            for item in block["items"]:
                if item.get("call_id"):
                    target.setdefault(item["call_id"], {"block": block["key"], "item": item["index"],
                                                        "content": item.get("text", "")})
    return {"text": text, "reasoning": reasoning, "calls": calls, "observations": observations,
            "order": order}


def _match_messages(messages, lookups):
    """Pair captured Chat messages with archive blocks by exact text / call id."""
    rows = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            rows.append({"index": index, "role": None, "chars": 0, "parts": [], "matched": False,
                         "content": "", "reasoning": "", "tool_call_ids": []})
            continue
        role = message.get("role")
        content = _flatten_content(message.get("content"))
        reasoning = message.get("reasoning_content") if isinstance(message.get("reasoning_content"), str) else ""
        calls = [call for call in (message.get("tool_calls") or []) if isinstance(call, dict)]
        parts, checks = [], []
        key = lookups["text"].get((role, content)) if content else None
        if key:
            parts.append({"block": key})
        if role == "assistant":
            if reasoning and reasoning in lookups["reasoning"]:
                parts.append({"block": lookups["reasoning"][reasoning]})
            for call in calls:
                found = lookups["calls"].get(call.get("id"))
                if found and all(part["block"] != found["block"] for part in parts):
                    parts.append({"block": found["block"], "item": found["item"]})
        elif role == "tool":
            found = lookups["observations"].get(message.get("tool_call_id"))
            if found:
                parts.append({"block": found["block"], "item": found["item"]})
                checks.append({"label": "工具返回原文与归档一致", "ok": found["content"] == content})
        parts.sort(key=lambda part: lookups["order"].get(part["block"], 0))
        rows.append({"index": index, "role": role, "chars": len(content), "parts": parts,
                     "matched": bool(parts), "content": content, "reasoning": reasoning,
                     "tool_call_ids": [call.get("id") for call in calls], "checks": checks})
    return rows


def _unique_keys(rows):
    seen, keys = set(), []
    for row in rows:
        for part in row["parts"]:
            if part["block"] not in seen:
                seen.add(part["block"])
                keys.append(part["block"])
    return keys


# ------------------------------------------------------------------ compaction

def _compaction(step, extra, index, position, blocks, summaries, store, warnings):
    capture = extra.get("capture") if isinstance(extra.get("capture"), dict) else {}
    boundary = (extra.get("context_management") or {}).get("boundary") or "replace"
    prior = _read_messages(store, capture.get("prior_messages"), warnings, "压缩前消息")
    after = _read_messages(store, capture.get("effective_messages"), warnings, "压缩后消息")

    rows, kept, dropped, injected = [], [], [], []
    if prior is not None and after is not None:
        signatures = [_signature(message) for message in prior]
        used = set()
        for after_index, message in enumerate(after):
            signature = _signature(message)
            match = next((i for i, value in enumerate(signatures) if value == signature and i not in used), None)
            if match is not None:
                used.add(match)
                kept.append(match)
            else:
                injected.append({"after": after_index, "role": message.get("role"),
                                 "chars": len(_flatten_content(message.get("content"))),
                                 "signature": signature})
            rows.append({"after": after_index, "before": match, "role": message.get("role"),
                         "chars": len(_flatten_content(message.get("content"))), "new": match is None})
        dropped = [i for i in range(len(prior)) if i not in used]

    lookups = _lookups(blocks)
    retained_blocks = _unique_keys(_match_messages(after, lookups)) if after is not None else None
    before_blocks = _unique_keys(_match_messages(prior, lookups)) if prior is not None else None
    dropped_blocks = [key for key in (before_blocks or []) if retained_blocks is not None and key not in retained_blocks]

    checks, native_message = [], None
    if store and capture.get("native_compaction_event"):
        try:
            native = store.json(capture["native_compaction_event"])
        except CaptureError as exc:
            warnings.append(f"原生压缩事件：{exc}")
        else:
            payload = native.get("payload") if isinstance(native, dict) else None
            native_message = payload.get("message") if isinstance(payload, dict) else None
            if isinstance(native_message, str) and injected:
                checks.append({"label": "原生 compacted 事件的 payload.message 与捕获的新消息一致",
                               "ok": native_message == _flatten_content(
                                   after[injected[0]["after"]].get("content") if after else None)})

    after_verified = None
    if store and capture.get("after_request") and after is not None:
        try:
            body = store.json(capture["after_request"])
        except CaptureError as exc:
            warnings.append(f"压缩后请求：{exc}")
        else:
            messages = body.get("messages") if isinstance(body, dict) else None
            after_verified = isinstance(messages, list) and len(messages) == len(after) and all(
                _signature(a) == _signature(b) for a, b in zip(messages, after))
            checks.append({"label": "压缩后首次请求的 messages 与捕获的压缩后数组逐条一致",
                           "ok": after_verified})

    summary_block = summaries[-1] if summaries else None
    summary_matches = None
    if summary_block is not None:
        summary_block["compaction"] = f"C{index}"
        summary_block["title"] = f"压缩摘要 Σ{index}"
        if store and capture.get("summary"):
            try:
                summary_text = store.text(capture["summary"])
            except CaptureError as exc:
                warnings.append(f"压缩摘要：{exc}")
            else:
                summary_matches = summary_block["text"] == summary_text
                checks.append({"label": "摘要调用正文与压缩包的 summary.txt 逐字一致", "ok": summary_matches})

    return {
        "key": f"C{index}", "symbol": "C", "index": index, "notation": _notation("C", index),
        "label": SYMBOLS["C"]["label"], "title": f"自动压缩 · {boundary}", "boundary": boundary,
        "step_id": step.get("step_id"), "position": len([b for b in blocks if b["symbol"] != "C"]),
        "order": None, "role": None, "state": "control", "state_note": NOTES["compaction"],
        "text": "", "chars": 0, "items": [], "evidence": "atif",
        "provenance": [f"steps[{position}].extra.context_management"],
        "control_note": _text_of(step.get("message")),
        "summary_block": summary_block["key"] if summary_block else None,
        "summary_chars": len(summary_block["text"]) if summary_block else None,
        "before": {"messages": len(prior) if prior is not None else None,
                   "blocks": before_blocks},
        "after": {"messages": len(after) if after is not None else None,
                  "blocks": retained_blocks},
        "retained": rows, "kept": kept, "dropped": dropped, "injected": injected,
        "dropped_blocks": dropped_blocks,
        "after_request_verified": after_verified,
        "summary_matches": summary_matches,
        "checks": checks,
        "references": {name: capture.get(name) for name in
                       ("prior_messages", "effective_messages", "summary", "native_compaction_event",
                        "after_request", "native_session_line") if capture.get(name)},
    }


# --------------------------------------------------------------------- prepare

def prepare(data, directory=None, source=None):
    """Parse an ATIF object into full-text blocks, requests and compaction links."""
    if not isinstance(data, dict):
        raise TrajectoryError("ATIF 顶层必须是对象")
    steps = data.get("steps")
    if not isinstance(steps, list) or not steps:
        raise TrajectoryError("ATIF 需要非空的 steps 数组（messages-only 文件请用石板视图）")

    store = CaptureStore(directory) if directory else None
    blocks, warnings, summaries, compactions = [], [], [], []
    counters, produced, order = {}, {}, 0
    calls = {}
    used_order = {"U": 0, "R": 0, "M": 0, "T": 0, "O": 0}

    def next_index(symbol):
        counters[symbol] = counters.get(symbol, -1) + 1
        return counters[symbol]

    for position, step in enumerate(steps):
        if not isinstance(step, dict):
            warnings.append(f"steps[{position}] 不是对象，已跳过")
            continue
        extra = _extra(step)
        step_id = step.get("step_id", position + 1)
        state, state_note = _training_state(step, "R")
        metrics = step.get("metrics") if isinstance(step.get("metrics"), dict) else {}
        call = {"request": _request_id_for(step)}
        for key, name in (("prompt_tokens", "prompt_tokens"), ("completion_tokens", "completion_tokens")):
            if isinstance(metrics.get(key), (int, float)):
                call[name] = metrics[key]
        if len(call) == 1 and not call["request"]:
            call = None
        if extra.get("call_kind") == "summary" and extra.get("trainable") is True:
            warnings.append(f"steps[{position}] 同时声明 call_kind=summary 与 trainable=true；仍按摘要展示，不当作训练目标")
        context = extra.get("context_management")
        if isinstance(context, dict) and context.get("type") == "compaction":
            compactions.append(_compaction(step, extra, len(compactions), position, blocks, summaries,
                                           store, warnings))
            blocks.append(compactions[-1])
            continue

        role = step.get("source")
        message = _text_of(step.get("message"))
        reasoning = _text_of(step.get("reasoning_content"))
        tool_calls = [item for item in (step.get("tool_calls") or []) if isinstance(item, dict)]
        results = []
        observation = step.get("observation")
        if isinstance(observation, dict) and isinstance(observation.get("results"), list):
            results = [item for item in observation["results"] if isinstance(item, dict)]
        new_blocks = []

        if role == "system":
            index = next_index("S")
            block = _block(f"S{index}", "S", index, title="系统前缀", role="system",
                           state="condition", state_note="前缀只作为条件，不计损失",
                           step_id=step_id, text=message,
                           provenance=[f"steps[{position}].message"], call=call)
            block["items"] = _scoped(_split_subblocks(message), block["key"])
            new_blocks.append(block)
        elif role == "user":
            index = next_index("U")
            subs = _split_subblocks(message)
            tagged = _tags(message)
            if message.startswith("# AGENTS.md"):
                title = "AGENTS.md 与指令"
            elif "codex_internal_context" in tagged:
                title = "Goal 上下文"
            elif "environment_context" in tagged:
                title = "环境与工作区"
            else:
                title = _first_line(message)
            block = _block(f"U{index}", "U", index, title=title, role="user", state="condition",
                           state_note="用户侧输入只作为条件，不计损失", step_id=step_id,
                           text=message, provenance=[f"steps[{position}].message"], call=call)
            block["items"] = _scoped(subs, block["key"])
            new_blocks.append(block)
        elif role == "agent":
            if reasoning:
                index = next_index("R")
                new_blocks.append(_block(f"R{index}", "R", index, title="推理", role="assistant",
                                         state=state, state_note=state_note, step_id=step_id,
                                         text=reasoning, provenance=[f"steps[{position}].reasoning_content"],
                                         call=call))
            if message:
                index = next_index("M")
                message_state, message_note = _training_state(step, "M")
                title = "压缩摘要" if message_state == "summary" else ("调用前说明" if tool_calls else "assistant 正文")
                new_blocks.append(_block(f"M{index}", "M", index, title=title, role="assistant",
                                         state=message_state, state_note=message_note, step_id=step_id,
                                         text=message, provenance=[f"steps[{position}].message"], call=call))
                if message_state == "summary":
                    summaries.append(new_blocks[-1])
            if tool_calls:
                index = next_index("T")
                items = []
                for item_index, call_item in enumerate(tool_calls[:MAX_ITEMS]):
                    call_id = call_item.get("tool_call_id") or call_item.get("id")
                    name = call_item.get("function_name") or (call_item.get("function") or {}).get("name") or "tool"
                    arguments = call_item.get("arguments")
                    if arguments is None:
                        arguments = (call_item.get("function") or {}).get("arguments")
                    items.append({"index": item_index, "call_id": call_id, "name": name,
                                  "chars": len(_text_of(arguments)), "text": _text_of(arguments)})
                    if call_id:
                        calls[call_id] = {"block": f"T{index}", "item": item_index, "result": None,
                                          "name": name}
                names = list(dict.fromkeys(item["name"] for item in items))
                new_blocks.append(_block(f"T{index}", "T", index, title="工具调用 · " + ", ".join(names[:3]),
                                         role="assistant", state=state, state_note=state_note,
                                         step_id=step_id, items=items,
                                         provenance=[f"steps[{position}].tool_calls"], call=call))
            if results:
                index = next_index("O")
                items, flags = [], []
                for item_index, result in enumerate(results[:MAX_ITEMS]):
                    call_id = result.get("source_call_id")
                    content = _text_of(result.get("content"))
                    extra_result = result.get("extra") if isinstance(result.get("extra"), dict) else {}
                    visible = extra_result.get("model_visible", True) is not False
                    linked = calls.get(call_id)
                    items.append({"index": item_index, "call_id": call_id, "chars": len(content),
                                  "text": content, "name": linked and linked.get("name"),
                                  "model_visible": visible,
                                  "harness_truncated": bool(extra_result.get("harness_truncated")),
                                  "raw_chars": extra_result.get("raw_stdout_chars"),
                                  "visible_chars": extra_result.get("model_visible_content_chars")})
                    if linked:
                        linked["result"] = {"block": f"O{index}", "item": item_index}
                    else:
                        warnings.append(f"steps[{position}] 的返回没有可核对的调用引用：{call_id or '缺失'}")
                    if not visible:
                        flags.append(f"O{index}[{item_index}] model_visible=false")
                new_blocks.append(_block(f"O{index}", "O", index, title=f"工具返回 · {len(items)} 项",
                                         role="tool", state="condition",
                                         state_note="工具返回只作为条件；model_visible=false 的条目未进入训练",
                                         step_id=step_id, items=items,
                                         provenance=[f"steps[{position}].observation.results"], flags=flags,
                                         call=None))
        else:
            index = next_index("?")
            block = _block(f"?{index}", "?", index, title=f"未识别的 source：{role}", role=str(role),
                           state="unknown", state_note="ATIF 的 source 不在已知取值内",
                           step_id=step_id, text=message, evidence="atif",
                           provenance=[f"steps[{position}].message"])
            warnings.append(f"steps[{position}] 的 source={role!r} 未识别")
            new_blocks.append(block)

        for block in new_blocks:
            if block["symbol"] in used_order:
                block["order"] = order
                order += 1
            blocks.append(block)
        if new_blocks:
            produced[step_id] = [block["key"] for block in new_blocks]

    for call_id, info in calls.items():
        if info["result"] is None:
            warnings.append(f"调用 {call_id} 没有匹配的返回")

    requests = _requests(data, steps, produced)
    agent = data.get("agent") or {}
    definitions = data.get("tool_definitions")
    if not isinstance(definitions, list):
        definitions = agent.get("tool_definitions") or []
    tool_usage = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        for item in step.get("tool_calls") or []:
            name = item.get("function_name") or (item.get("function") or {}).get("name")
            if name:
                tool_usage[name] = tool_usage.get(name, 0) + 1
    meta = {
        "schema": data.get("schema_version"), "session": data.get("session_id") or data.get("trajectory_id"),
        "trajectory_id": data.get("trajectory_id"), "source": source,
        "agent": _agent(data.get("agent")), "steps": len(steps),
        "tool_definitions": len(data["tool_definitions"]) if isinstance(data.get("tool_definitions"), list)
        else len((data.get("agent") or {}).get("tool_definitions") or []) or None,
        "tool_definitions_detail": definitions,
        "provider_tool_declarations": (agent.get("extra") or {}).get("provider_tool_declarations") or [],
        "tool_usage": tool_usage,
        "tool_definitions_provenance": (agent.get("extra") or {}).get("tool_definitions_provenance"),
        "final_metrics": data.get("final_metrics") if isinstance(data.get("final_metrics"), dict) else None,
        "counts": {symbol: sum(1 for block in blocks if block["symbol"] == symbol)
                   for symbol in ("S", "U", "R", "M", "T", "O", "C", "?")},
        "captures": {"available": bool(store and store.available),
                     "format": ((data.get("extra") or {}).get("capture") or {}).get("format"),
                     "requests": len(requests)},
        "compactions": len(compactions), "warnings": warnings,
    }
    return {"meta": meta, "blocks": blocks, "requests": requests, "compactions": compactions,
            "notes": NOTES, "injected": _injected_index(compactions), "store": store}


def _scoped(items, prefix):
    return [dict(item, key=prefix + item["key"]) for item in items]


def _injected_index(compactions):
    index = {}
    for compaction in compactions:
        for item in compaction.get("injected") or []:
            if item.get("signature"):
                index[item["signature"]] = {"compaction": compaction["key"], "role": item["role"],
                                            "chars": item["chars"]}
    return index


def _agent(value):
    if not isinstance(value, dict):
        return None
    return {key: value.get(key) for key in ("name", "version", "model_name") if value.get(key)}


def _requests(data, steps, produced):
    capture = (data.get("extra") or {}).get("capture")
    listed = capture.get("requests") if isinstance(capture, dict) else None
    by_step = {}
    for step in steps:
        if not isinstance(step, dict):
            continue
        extra = _extra(step)
        inner = extra.get("capture")
        metrics = step.get("metrics") if isinstance(step.get("metrics"), dict) else {}
        inner_metrics = metrics.get("extra") if isinstance(metrics.get("extra"), dict) else {}
        if isinstance(inner, dict) and (inner.get("chat_request") or inner.get("rendered_prompt")):
            by_step[step.get("step_id")] = {"capture": inner, "metrics": inner_metrics}
    entries = []
    if isinstance(listed, list) and listed:
        for position, item in enumerate(listed):
            if not isinstance(item, dict):
                continue
            request_id = item.get("request") or f"request-{position + 1:03d}"
            entries.append(_request_entry(request_id, position, item, produced, by_step))
    else:
        for position, (step_id, inner) in enumerate(by_step.items()):
            request_id = _request_id_for({"extra": {"capture": inner}}) or f"request-{position + 1:03d}"
            entries.append(_request_entry(request_id, position,
                                          {"step_id": step_id, "chat_request": inner.get("chat_request"),
                                           "chat_response": inner.get("chat_response"),
                                           "rendered_prompt": inner.get("rendered_prompt")},
                                          produced, by_step))
    return entries


def _request_entry(request_id, position, item, produced, by_step):
    step_id = item.get("step_id")
    inner = by_step.get(step_id) or {}
    inner_capture = inner.get("capture") or {}
    inner_metrics = inner.get("metrics") or {}
    files = {}
    for kind in ("chat_request", "chat_response", "codex_request", "codex_response",
                 "rendered_prompt", "request_meta", "message_origins"):
        reference = item.get(kind) or inner_capture.get(kind)
        if isinstance(reference, dict):
            files[kind] = reference
    token_ids = inner_metrics.get("reconstructed_prompt_token_ids")
    if isinstance(token_ids, dict):
        files["token_ids"] = token_ids
    server = item.get("server_prompt_tokens")
    local = item.get("local_prompt_tokens")
    entry = {"id": request_id, "position": position, "step_id": step_id,
             "stage": item.get("stage") or "policy",
             "messages": item.get("messages"), "tools": item.get("tool_definitions"),
             "server_prompt_tokens": server, "local_prompt_tokens": local,
             "server_completion_tokens": item.get("server_completion_tokens"),
             "seconds": item.get("seconds"), "files": files,
             "produced": produced.get(step_id, []) if step_id is not None else []}
    if isinstance(server, (int, float)) and isinstance(local, (int, float)):
        entry["tokens_match"] = server == local
        entry["tokens_delta"] = local - server
    else:
        entry["tokens_match"] = None
        entry["tokens_delta"] = None
    return entry


# -------------------------------------------------------------------- publish

BLOCK_FIELDS = ("key", "symbol", "index", "title", "role", "state", "step_id", "chars",
                "truncated", "text")


def _compact(block, text, allowance, extra=()):
    item = {name: block[name] for name in BLOCK_FIELDS if name not in ("chars", "truncated", "text")}
    item["chars"] = len(text)
    item["truncated"] = len(text) > allowance
    item["text"] = text[:allowance]
    for name in extra:
        value = block.get(name)
        if value not in (None, [], (), ""):
            item[name] = value
    return item


def public(view, text_cap=TEXT_CAP, budget=700_000):
    """Transport shape: capped block text under a total budget.

    Small trajectories ship full text; once ``budget`` characters are spent the
    remaining blocks carry only a short preview and ``truncated: true`` so the
    client can fetch that one block on demand. Labels, notation and state
    explanations are derived by the client from ``symbol``/``state``.
    """
    spent = 0
    blocks = []
    for block in view["blocks"]:
        text = block.get("text") or ""
        allowance = text_cap if spent < budget else PREVIEW_CAP
        item = _compact(block, text, allowance,
                        ("order", "provenance", "request", "call", "flags", "compaction",
                         "summary_block", "summary_chars", "summary_matches", "after_request_verified",
                         "boundary", "control_note", "before", "after", "retained", "injected", "kept",
                         "dropped", "dropped_blocks", "checks", "references", "position"))
        if "injected" in item:
            item["injected"] = [{k: v for k, v in entry.items() if k != "signature"}
                                for entry in item["injected"]]
        if block.get("state") in ("ignored", "summary", "unknown") and block.get("state_note"):
            item["state_note"] = block["state_note"]
        spent += len(item["text"])
        sub = []
        for sub_block in block.get("items") or []:
            sub_text = sub_block.get("text") or ""
            sub_allowance = min(allowance, text_cap)
            sub_item = {"key": sub_block.get("key"), "title": sub_block.get("title"),
                        "chars": len(sub_text), "truncated": len(sub_text) > sub_allowance,
                        "text": sub_text[:sub_allowance]}
            for name in ("tag", "call_id", "name", "model_visible", "harness_truncated", "raw_chars"):
                if sub_block.get(name) not in (None, "", True):
                    sub_item[name] = sub_block[name]
            spent += len(sub_item["text"])
            sub.append(sub_item)
        if sub:
            item["items"] = sub
        blocks.append(item)
    compactions = []
    for compaction in view["compactions"]:
        item = {key: value for key, value in compaction.items() if key != "injected"}
        item["injected"] = [{k: v for k, v in entry.items() if k != "signature"}
                            for entry in compaction.get("injected") or []]
        compactions.append(item)
    return {"meta": view["meta"], "blocks": blocks, "requests": view["requests"],
            "compactions": compactions, "notes": view["notes"], "text_budget": budget}


def block_text(view, key):
    for block in view["blocks"]:
        if block["key"] == key:
            return {"key": key, "symbol": block["symbol"], "chars": len(block["text"]),
                    "text": block["text"], "items": block.get("items") or []}
    raise TrajectoryError(f"没有这个块：{key}")


def request_snapshot(view, request_id):
    """Decode one request's captured messages and pair them with archive blocks."""
    entry = next((item for item in view["requests"] if item["id"] == request_id), None)
    if entry is None:
        raise TrajectoryError(f"没有这次请求：{request_id}")
    store = view.get("store")
    result = {"request": entry, "captures": {"available": bool(store and store.available)},
              "files": [], "messages": [], "visible": [], "unmatched": [], "checks": [],
              "prompt": None, "chat_request": None, "response": None}
    if not store or not store.available:
        result["note"] = "该轨迹没有可读取的捕获目录，请求视图只能显示 ATIF 中记录的元数据。"
        return result

    reference = entry["files"].get("chat_request")
    if not reference:
        result["note"] = "该请求在 ATIF 中没有 chat_request 捕获引用。"
        return result

    try:
        body = store.json(reference)
    except CaptureError as exc:
        result["note"] = str(exc)
        return result
    if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
        result["note"] = "捕获的 chat 请求缺少 messages 数组"
        return result

    for kind, reference in entry["files"].items():
        try:
            verified = store.verify(reference)
        except CaptureError as exc:
            result["files"].append({"kind": kind, "path": reference.get("path"), "sha256": reference.get("sha256"),
                                    "verified": False, "error": str(exc)})
        else:
            result["files"].append({"kind": kind, "path": reference.get("path"), "sha256": reference.get("sha256"),
                                    "verified": True, "bytes": verified["bytes"]})

    lookups = _lookups(view["blocks"])
    rows = _match_messages(body["messages"], lookups)
    injected = view.get("injected") or {}
    for row in rows:
        message = body["messages"][row["index"]]
        origin = injected.get(_signature(message))
        if origin:
            row["injected_by"] = origin["compaction"]
            row["injected_chars"] = origin["chars"]
    result["messages"] = rows
    result["unmatched"] = [row for row in rows if not row["matched"]]

    seen = set()
    for row in rows:
        for part in row["parts"]:
            if part["block"] not in seen:
                seen.add(part["block"])
                result["visible"].append({"key": part["block"]})
        if not row["matched"] and row.get("injected_by"):
            result["visible"].append({"key": None, "injected_by": row["injected_by"],
                                      "title": f"压缩注入的消息（{row['chars']} 字符）"})

    if isinstance(entry["messages"], int):
        result["checks"].append({"label": "ATIF 声明的消息数与捕获请求一致",
                                 "ok": entry["messages"] == len(body["messages"]),
                                 "detail": f"ATIF {entry['messages']} / 捕获 {len(body['messages'])}"})
    if isinstance(entry["tools"], int):
        tools = body.get("tools") if isinstance(body.get("tools"), list) else []
        result["checks"].append({"label": "ATIF 声明的工具定义数与捕获请求一致",
                                 "ok": entry["tools"] == len(tools),
                                 "detail": f"ATIF {entry['tools']} / 捕获 {len(tools)}"})

    rendered = json.dumps(body, ensure_ascii=False, indent=2)
    result["chat_request"] = {"text": rendered, "chars": len(rendered)}

    reference = entry["files"].get("rendered_prompt")
    if reference:
        try:
            text = store.text(reference)
        except CaptureError as exc:
            result["checks"].append({"label": "本地重建的渲染输入", "ok": False, "detail": str(exc)})
        else:
            result["prompt"] = {"text": text, "chars": len(text),
                                "evidence": "local_reconstruction",
                                "note": "固定模板在本地重建的输入，不是服务端实收字符串。",
                                "tail": text[-160:]}

    reference = entry["files"].get("token_ids")
    if reference:
        try:
            ids = store.json(reference)
        except CaptureError as exc:
            result["checks"].append({"label": "本地重建 token ID", "ok": False, "detail": str(exc)})
        else:
            if isinstance(ids, list) and all(isinstance(item, int) for item in ids):
                result["token_ids"] = {"count": len(ids), "head": ids[:4], "tail": ids[-4:]}
                if isinstance(entry["local_prompt_tokens"], int):
                    result["checks"].append({"label": "本地重建 token 数与 ATIF 记录一致",
                                             "ok": len(ids) == entry["local_prompt_tokens"],
                                             "detail": "ID 序列 %d / ATIF %d" % (len(ids), entry["local_prompt_tokens"])})
                model = ((view["meta"].get("agent") or {}).get("model_name") or "").lower()
                if "v4.1" in model:
                    # Pinned reference format: docs/deepseek-v41-format.md
                    result["checks"].append({"label": "开头 ID = [BOS 0, system 起始 128799]",
                                             "ok": ids[:2] == [0, 128799], "detail": str(ids[:2])})
                    result["checks"].append({"label": "结尾 ID = [assistant 结束 128804, thinking 起始 128821]",
                                             "ok": ids[-2:] == [128804, 128821], "detail": str(ids[-2:])})
                else:
                    result["token_ids"]["note"] = "该模型没有钉定的参考格式；首尾 ID 只是观察值，不做通过/失败判定"
            else:
                result["checks"].append({"label": "本地重建 token ID", "ok": False, "detail": "期望整数数组"})

    reference = entry["files"].get("chat_response")
    if reference:
        try:
            response = store.text(reference)
        except CaptureError as exc:
            result["checks"].append({"label": "捕获的模型返回", "ok": False, "detail": str(exc)})
        else:
            result["response"] = {"text": response, "chars": len(response)}

    # The compaction that produced this request's injected message is the only
    # place where "messages equal the captured after[]" can be checked.
    for compaction in view["compactions"]:
        reference = compaction.get("references", {}).get("after_request")
        if reference and reference.get("path") == (entry["files"].get("chat_request") or {}).get("path"):
            if compaction.get("after_request_verified") is True:
                result["checks"].append({"label": "该请求与压缩后数组逐条一致", "ok": True})
    return result


def file_reference(view, ref_id):
    """Resolve a UI-facing reference id to a hash-checked sidecar reference."""
    if not isinstance(ref_id, str) or "." not in ref_id:
        raise TrajectoryError("引用格式应为 request-001.rendered 或 C0.summary")
    owner, kind = ref_id.split(".", 1)
    entry = next((item for item in view["requests"] if item["id"] == owner), None)
    if entry is not None and kind in entry["files"]:
        reference = entry["files"][kind]
        return {"reference": reference, "label": f"{owner} · {kind}"}
    compaction = next((item for item in view["compactions"] if item["key"] == owner), None)
    if compaction is not None and kind in (compaction.get("references") or {}):
        reference = compaction["references"][kind]
        if isinstance(reference, dict) and reference.get("path") and reference.get("sha256"):
            return {"reference": reference, "label": f"{owner} · {kind}"}
    raise TrajectoryError(f"没有这个捕获文件：{ref_id}")
