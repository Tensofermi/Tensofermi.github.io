"""Local DeepSeek V4.1 prompt reconstruction with per-token provenance.

The cloud API does not return its serialized prompt or prompt token IDs.  This
module uses the released reference encoder and tokenizer and labels the result
as a reconstruction throughout the application.
"""

from __future__ import annotations

import copy
import json
import re
from collections import Counter
from pathlib import Path

from tokenizers import Tokenizer

from vendor import deepseek_v41_encoding as protocol

ROOT = Path(__file__).resolve().parent
TOKENIZER = Tokenizer.from_file(str(ROOT / "vendor" / "tokenizer.json"))
CONTEXT_WINDOW = 1_048_576
CONTROL = re.compile(
    r"<｜[^<>]+｜>|<think>|</think>|</?tool_result>|"
    r"</?｜DSML｜(?: calls| invoke| parameter)(?:\s[^<>]*)?>"
)
SPECIAL_IDS = {
    TOKENIZER.token_to_id(value)
    for value in (
        protocol.bos_token, protocol.eos_token, protocol.USER_SP_TOKEN,
        protocol.ASSISTANT_SP_TOKEN, protocol.SYSTEM_SP_TOKEN,
        protocol.thinking_start_token, protocol.thinking_end_token,
        protocol.LATEST_REMINDER_SP_TOKEN, protocol.dsml_token,
    )
}


def api_messages(messages: list[dict]) -> list[dict]:
    """Remove only local provenance fields before forwarding to the provider."""
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages 必须是非空数组")
    clean = []
    for index, item in enumerate(messages):
        if not isinstance(item, dict) or item.get("role") not in {"system", "user", "assistant", "tool"}:
            raise ValueError(f"messages[{index}] 的角色无效")
        if item["role"] in {"system", "user", "tool"} and not isinstance(item.get("content"), str):
            raise ValueError(f"messages[{index}].content 目前仅支持文本")
        if item["role"] == "assistant" and item.get("content") is not None and not isinstance(item["content"], str):
            raise ValueError(f"messages[{index}].content 目前仅支持文本")
        clean.append({k: copy.deepcopy(v) for k, v in item.items() if not k.startswith("_")})
    return clean


def _source(index: int | None, field: str, origin: str = "request") -> str:
    return f"messages[{index}].{field} · {origin}" if index is not None else f"template.{field}"


def analyze(messages: list[dict], tools: list[dict] | None = None,
            thinking: bool = True, effort: str = "high") -> dict:
    clean = api_messages(messages)
    if tools is None:
        tools = []
    if not isinstance(tools, list):
        raise ValueError("tools 必须是数组")
    if effort not in {"low", "high", "max"}:
        raise ValueError("reasoning_effort 仅支持 low / high / max")
    render_input = copy.deepcopy(clean)
    # Sidecar provenance survives the reference encoder's user/tool merging and
    # tool-result sorting. It never leaves the local reconstruction path.
    for original_index, item in enumerate(render_input):
        item["_source_index"] = original_index
        if item["role"] == "user":
            item["content_blocks"] = [{"type": "text", "text": item["content"], "_source_index": original_index}]
        elif item["role"] == "tool":
            render_input[original_index] = {
                "role": "user", "_source_index": original_index,
                "content_blocks": [{"type": "tool_result", "content": item["content"],
                                    "tool_use_id": item.get("tool_call_id", ""),
                                    "_source_index": original_index}],
            }
    if clean[-1].get("prefix"):
        if clean[-1]["role"] != "assistant":
            raise ValueError("prefix=true 只允许用于最后一条 assistant 消息")
        render_input[-1]["wo_eos"] = True
    origins = [str(m.get("_origin", "用户编辑")) for m in messages]
    if tools:
        if render_input[0]["role"] != "system":
            render_input.insert(0, {"role": "system", "content": ""})
        render_input[0]["tools"] = copy.deepcopy(tools)
    mode = "thinking" if thinking else "chat"
    try:
        prompt = protocol.encode_messages(render_input, thinking_mode=mode, reasoning_effort=effort)
        merged = protocol.merge_tool_messages(render_input)
        merged = protocol.sort_tool_results_by_call_order(merged)
        drop_thinking = not bool(tools)
        if thinking and drop_thinking:
            # Pinned assets expose this helper privately; fail loudly instead of
            # silently changing provenance if a future revision renames it.
            drop = getattr(protocol, "_drop_thinking_messages", None)
            if drop is None:
                raise ValueError("当前 vendor 编码器缺少 _drop_thinking_messages；请核对资产版本")
            merged = drop(merged)
        chunks = [protocol.render_message(i, merged, mode, drop_thinking, effort) for i in range(len(merged))]
    except (AssertionError, KeyError, TypeError, ValueError, NotImplementedError) as exc:
        raise ValueError(f"官方编码器无法重建这组消息：{exc}") from exc
    if protocol.bos_token + "".join(chunks) != prompt:
        raise ValueError("官方编码器的分段与完整序列不一致；已拒绝归属推测")

    # Each character gets one kind and one traceable owner. Tokenizer offsets
    # are then mapped onto these exact ranges; a cross-boundary token retains
    # every contributor instead of being forced into one category.
    kind = ["format"] * len(prompt)
    owner = ["template.BOS"] * len(prompt)

    def mark(start: int, end: int, label: str, source: str):
        if end > start:
            kind[start:end] = [label] * (end - start)
            owner[start:end] = [source] * (end - start)

    base = len(protocol.bos_token)
    for mi, (msg, chunk) in enumerate(zip(merged, chunks)):
        role = msg["role"]
        src_idx = msg.get("_source_index")
        origin = origins[src_idx] if src_idx is not None else "template"
        default_src = _source(src_idx, "boundary", origin)
        mark(base, base + len(chunk), "format", default_src)

        if mi == 0 and thinking:
            effort_text = protocol.render_reasoning_effort(0, mode, effort)
            at = chunk.find(effort_text)
            if at >= 0 and effort_text:
                mark(base + at, base + at + len(effort_text), "prompt", "settings.reasoning_effort")

        if role == "system":
            content = msg.get("content") or ""
            at = chunk.find(content, len(protocol.SYSTEM_SP_TOKEN)) if content else -1
            if at >= 0 and content:
                mark(base + at, base + at + len(content), "prompt", _source(src_idx, "content", origin))
            if msg.get("tools"):
                at = chunk.find("## Tools")
                if at >= 0:
                    end = chunk.find("\n<｜", at)
                    if end < 0:
                        end = len(chunk)
                    mark(base + at, base + end, "prompt", "request.tools → 官方工具定义模板")
        elif role == "user":
            blocks = msg.get("content_blocks") or [{"type": "text", "text": msg.get("content", "")}]
            cursor = 0
            for block in blocks:
                if block.get("type") == "tool_result":
                    value = block.get("content") or ""
                    if not isinstance(value, str):
                        value = json.dumps(value, ensure_ascii=False)
                    field = "tool_result"
                    label = "observation"
                    call_id = block.get("tool_use_id")
                    matching = block.get("_source_index")
                    source = _source(matching, f"content (tool_call_id={call_id})", origins[matching] if matching is not None else "外部结果")
                else:
                    value = block.get("text") or ""
                    field = "content"
                    label = "prompt"
                    matching = block.get("_source_index", src_idx)
                    source = _source(matching, field, origins[matching] if matching is not None else origin)
                if value:
                    at = chunk.find(value, cursor)
                    if at >= 0:
                        mark(base + at, base + at + len(value), label, source)
                        cursor = at + len(value)
        elif role == "assistant":
            reasoning = msg.get("reasoning_content") or ""
            content = msg.get("content") or ""
            if reasoning:
                at = chunk.find(reasoning)
                if at >= 0:
                    mark(base + at, base + at + len(reasoning), "cot", _source(src_idx, "reasoning_content", origin))
            if content:
                at = chunk.find(content, chunk.find(reasoning) + len(reasoning) if reasoning else 0)
                if at >= 0:
                    mark(base + at, base + at + len(content), "message", _source(src_idx, "content", origin))
            at = chunk.find("<｜DSML｜ calls>")
            if at >= 0:
                end = chunk.find("</｜DSML｜ calls>", at)
                end = end + len("</｜DSML｜ calls>") if end >= 0 else len(chunk)
                mark(base + at, base + end, "call", _source(src_idx, "tool_calls", origin))

        # Structural tags are ordinary tokenizer pieces in some cases. Their
        # characters are still format/control, including DSML delimiters.
        for match in CONTROL.finditer(chunk):
            start, end = base + match.start(), base + match.end()
            previous = owner[start] if start < len(owner) else default_src
            mark(start, end, "format", previous)
        base += len(chunk)

    encoding = TOKENIZER.encode(prompt, add_special_tokens=False)
    tokens = []
    counts = Counter()
    for position, (tid, piece, (start, end)) in enumerate(zip(encoding.ids, encoding.tokens, encoding.offsets)):
        kinds = list(dict.fromkeys(kind[start:end])) if end > start else ["format"]
        sources = list(dict.fromkeys(owner[start:end])) if end > start else ["template.unknown"]
        category = kinds[0] if len(kinds) == 1 else "mixed"
        if tid in SPECIAL_IDS:
            category = "format"
        counts[category] += 1
        tokens.append({"index": position, "id": tid, "piece": piece,
                       "text": prompt[start:end], "start": start, "end": end,
                       "kind": category, "contributors": kinds,
                       "sources": sources})
    return {"evidence": "local_reconstruction", "model_format": "DeepSeek-V4.1-Flash reference encoder",
            "prompt": prompt, "tokens": tokens, "counts": dict(counts),
            "count": len(tokens), "context_window": CONTEXT_WINDOW,
            "next_position": len(tokens), "next_char": len(prompt),
            "warning": "DeepSeek API 没有返回实际序列化 prompt/token IDs；以上为官方参考编码器在本机重建，不能冒充服务端实收序列。"}


def generated_tokens(message: dict) -> dict:
    """Retokenize exposed response fields; never call them provider token IDs."""
    parts = []
    if message.get("reasoning_content"):
        parts.append(("cot", "response.reasoning_content", message["reasoning_content"]))
    if message.get("content"):
        parts.append(("message", "response.content", message["content"]))
    for index, call in enumerate(message.get("tool_calls") or []):
        parts.append(("call", f"response.tool_calls[{index}]", json.dumps(call, ensure_ascii=False)))
    result = []
    for category, source, content in parts:
        encoding = TOKENIZER.encode(content, add_special_tokens=False)
        for tid, piece, (start, end) in zip(encoding.ids, encoding.tokens, encoding.offsets):
            result.append({"index": len(result), "id": tid, "piece": piece,
                           "text": content[start:end], "kind": category,
                           "sources": [source], "contributors": [category]})
    return {"evidence": "response_fields_retokenized", "tokens": result, "count": len(result),
            "warning": "响应只提供字段文本；这些 ID 是本机重新分词，字段边界与服务端生成时的 token 边界、隐藏控制 token 均未获证实。"}
