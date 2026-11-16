"""Read-only adapters for external trajectories; never invent an inference prompt."""

from __future__ import annotations

import json
from models import CATALOG

MAX_SEGMENT = 50_000


def _string(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _model_key(name):
    if not isinstance(name, str):
        return None
    model = name.rsplit("/", 1)[-1]
    for key, item in CATALOG.items():
        if item["api_model"] == model:
            return key
    return None


def convert(data, source):
    if not isinstance(data, dict):
        raise ValueError("trajectory.json 顶层必须是对象")
    model_name = (data.get("agent") or {}).get("model_name") or data.get("model")
    model_key = _model_key(model_name)
    segments = []
    offset = data.get("step_offset", 0)
    reference_messages = []
    reference_effort = "high"

    def add(kind, value, origin, title, step=None, call_id=None):
        if value is None:
            return
        value = _string(value)
        if not value:
            return
        for part, start in enumerate(range(0, len(value), MAX_SEGMENT), 1):
            segments.append({"kind": kind, "text": value[start:start + MAX_SEGMENT],
                             "origin": origin, "title": title + (f" · 片段 {part}" if len(value) > MAX_SEGMENT else ""),
                             "step": step, "call_id": call_id,
                             "char_start": start, "char_end": min(start + MAX_SEGMENT, len(value))})

    if isinstance(data.get("steps"), list):
        if offset == 0:
            for index, step in enumerate(data["steps"]):
                if not isinstance(step, dict):
                    continue
                if step.get("source") == "agent":
                    if step.get("reasoning_effort") in ("low", "high", "max"):
                        reference_effort = step["reasoning_effort"]
                    break
                if step.get("source") in ("system", "user") and isinstance(step.get("message"), str):
                    reference_messages.append({"role": step["source"], "content": step["message"],
                                               "_origin": f"steps[{index}].message"})
        if data.get("tool_definitions"):
            add("prompt", data["tool_definitions"], "tool_definitions", "文件级工具定义")
        for local_index, step in enumerate(data["steps"]):
            index = offset + local_index
            if not isinstance(step, dict):
                continue
            number = step.get("step_id", index + 1)
            source_role = step.get("source", "unknown")
            kind = "prompt" if source_role in ("system", "user") else "message"
            add(kind, step.get("message"), f"steps[{index}].message", f"#{number} · {source_role}", number)
            add("cot", step.get("reasoning_content"), f"steps[{index}].reasoning_content", f"#{number} · CoT", number)
            for call_index, call in enumerate(step.get("tool_calls") or []):
                if not isinstance(call, dict):
                    continue
                call_id = call.get("tool_call_id")
                name = call.get("function_name", "tool")
                add("call", call.get("arguments"), f"steps[{index}].tool_calls[{call_index}].arguments",
                    f"#{number} · call {name}", number, call_id)
            for result_index, result in enumerate((step.get("observation") or {}).get("results") or []):
                if not isinstance(result, dict):
                    continue
                add("observation", result.get("content"), f"steps[{index}].observation.results[{result_index}].content",
                    f"#{number} · observation", number, result.get("source_call_id"))
        evidence = "atif_events"
    elif isinstance(data.get("messages"), list):
        if offset == 0:
            for index, message in enumerate(data["messages"]):
                if not isinstance(message, dict) or message.get("role") == "assistant":
                    break
                if message.get("role") in ("system", "user") and isinstance(message.get("content"), str):
                    reference_messages.append({"role": message["role"], "content": message["content"],
                                               "_origin": f"messages[{index}].content"})
        for local_index, message in enumerate(data["messages"]):
            index = offset + local_index
            if not isinstance(message, dict):
                continue
            role = message.get("role", "unknown")
            kind = "observation" if role == "tool" else "message" if role == "assistant" else "prompt"
            add(kind, message.get("content"), f"messages[{index}].content", f"#{index + 1} · {role}", index + 1)
            add("cot", message.get("reasoning_content"), f"messages[{index}].reasoning_content", f"#{index + 1} · CoT", index + 1)
        evidence = "messages_only"
    else:
        raise ValueError("未找到可展示的 steps 或 messages")

    if not segments:
        raise ValueError("轨迹中没有可展示的文本片段")
    total_steps = data.get("total_steps", len(data.get("steps") or data.get("messages") or []))
    next_step = offset + len(data.get("steps") or data.get("messages") or [])
    return {"source": source, "schema": data.get("schema_version") or "messages",
            "trajectory_id": data.get("trajectory_id") or data.get("session_id"),
            "model_name": model_name or "未知", "model_key": model_key,
            "tokenizer_available": bool(model_key and CATALOG[model_key]["adapter"]),
            "evidence": evidence, "prompt_token_ids_available": False,
            "note": "此文件未提供可核对的逐次完整请求 token ID；下面是轨迹中的可见字段。分词只针对各字段原文，不代表模型实际输入。",
            "segments": segments, "segment_count": len(segments),
            "loaded_steps": next_step, "total_steps": total_steps,
            "next_step": next_step if next_step < total_steps else None,
            "reference_messages": reference_messages[:4], "reference_effort": reference_effort}


def tokenize_field(model_key, text):
    if not isinstance(text, str) or len(text) > MAX_SEGMENT:
        raise ValueError(f"单次分词文本不得超过 {MAX_SEGMENT} 字符")
    model = CATALOG.get(model_key)
    if not model or not model["adapter"]:
        raise ValueError("此模型没有可核实的本地 tokenizer")
    adapter = model["adapter"]
    if adapter == "dsv41":
        from engine import TOKENIZER as tokenizer
    elif adapter == "dsv4":
        from reconstruct_dsv4 import tokenizer as get_tokenizer
        tokenizer = get_tokenizer()
    else:
        raise ValueError("未实现此模型的字段分词")
    encoded = tokenizer.encode(text, add_special_tokens=False)
    return [{"id": item, "piece": piece, "text": text[start:end], "start": start, "end": end}
            for item, piece, (start, end) in zip(encoded.ids, encoded.tokens, encoded.offsets)]
