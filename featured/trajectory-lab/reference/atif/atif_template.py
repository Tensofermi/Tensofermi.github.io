"""Official-template context rendering from ATIF; historical inputs remain unverified."""
from __future__ import annotations

import hashlib
import json
import uuid
from functools import lru_cache
from pathlib import Path

from jinja2 import StrictUndefined
from jinja2.sandbox import ImmutableSandboxedEnvironment

REVISION = "2cba9e42aa026125f3ed06c6d98c1db82f7ca027"
TEMPLATE_SHA256 = "d959d804d5101b79a49b6ff1bf3c54cd5affa9a5a78c503d925f3090040b31c3"
TEMPLATE = Path(__file__).resolve().parent / "vendor/deepseek_v41_chat_template.jinja"
SOURCE_URL = f"https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/{REVISION}/chat_template.jinja"
USER_ANCHOR = '{{- "<｜User｜>" -}}'


def _supports_reference(model_name):
    model = str(model_name or "").strip().lower()
    # The public slate uses the API model name in its records and the
    # pinned V4.1 Flash encoder for its local reconstruction.
    return model in {"deepseek-flash", "deepseek-official/deepseek-flash"} or "deepseek-v4.1-flash" in model


def _recorded_tools(data, agent):
    if "tool_definitions" in agent:
        return agent["tool_definitions"]
    # Slate's first ATIF exporter only omitted this field for an empty tool list.
    if (agent.get("name") == "Trajectory Lab" and agent.get("version") == "1.0"
            and (data.get("extra") or {}).get("run_status") in
            {"running", "completed", "stopped", "failed", "iteration_limit", "incomplete"}):
        return []
    return None


def _raise(message):
    raise ValueError(message)


@lru_cache(maxsize=1)
def _templates():
    raw = TEMPLATE.read_bytes()
    if hashlib.sha256(raw).hexdigest() != TEMPLATE_SHA256:
        raise ValueError("官方模板 SHA256 不匹配，已拒绝渲染")
    source = raw.decode("utf-8")
    if source.count(USER_ANCHOR) != 1:
        raise ValueError("官方模板的 User 边界已改变，已拒绝猜测位置")
    env = ImmutableSandboxedEnvironment(undefined=StrictUndefined)
    env.globals["raise_exception"] = _raise
    env.filters["tojson"] = lambda value, **kw: json.dumps(value, ensure_ascii=False, **kw)
    # The diagnostic marker locates a template boundary, not a role-like string
    # in the user's content. Removing it MUST reproduce the original rendering.
    traced = source.replace(USER_ANCHOR, '{{- _atif_prefix_marker -}}' + USER_ANCHOR)
    return env.from_string(source), env.from_string(traced)


def prefix(data, *, thinking=True, effort="max"):
    agent = data.get("agent") or {}
    if not _supports_reference(agent.get("model_name")):
        raise ValueError("当前模板前缀参考只支持 DeepSeek V4.1 Flash")
    if effort not in {"low", "medium", "high", "max"}:
        raise ValueError("无效的参考 reasoning_effort")
    tools = _recorded_tools(data, agent)
    if not isinstance(tools, list):
        raise ValueError("ATIF 未记录 agent.tool_definitions，不能推定空工具集合")
    for tool in tools:
        if (not isinstance(tool, dict) or tool.get("type") != "function"
                or not isinstance(tool.get("function"), dict)
                or not isinstance(tool["function"].get("name"), str)):
            raise ValueError("agent.tool_definitions 需要标准 type/function 包装；托管声明请保留在扩展字段")
    messages, origins = [], []
    first_user = None
    for index, step in enumerate(data.get("steps") or []):
        if not isinstance(step, dict):
            raise ValueError("首个 User 之前含无效步骤，无法确认前缀")
        if ((step.get("extra") or {}).get("context_management") or {}).get("type") == "compaction":
            raise ValueError("首个 User 之前存在压缩控制事件，无法确认普通消息前缀")
        role, content = step.get("source"), step.get("message")
        if role not in {"system", "user"} or not isinstance(content, str):
            raise ValueError("首个 User 之前存在无法映射的消息，已拒绝拼接")
        messages.append({"role": role, "content": content})
        origins.append(f"steps[{index}].message")
        if role == "user":
            first_user = {"step_index": index, "step_id": step.get("step_id"),
                          "source_field": origins[-1], "marker": "<｜User｜>"}
            break
    if first_user is None:
        raise ValueError("ATIF 中没有可确认的首个 User 消息")
    kwargs = {"messages": messages, "tools": tools,
              "thinking_mode": "thinking" if thinking else "chat",
              "reasoning_effort": effort, "drop_thinking": False,
              "add_generation_prompt": False}
    plain, traced = _templates()
    rendered = plain.render(**kwargs)
    marker = "ATIF_PREFIX_BOUNDARY_" + uuid.uuid4().hex
    if marker in rendered:
        raise ValueError("边界标记冲突")
    marked = traced.render(**kwargs, _atif_prefix_marker=marker)
    if marked.count(marker) != 1 or marked.replace(marker, "", 1) != rendered:
        raise ValueError("边界插桩改变了模板文本，已拒绝显示")
    text = marked.split(marker, 1)[0]
    if not rendered.startswith(text + first_user["marker"]):
        raise ValueError("官方 User 边界核对失败")
    provider = (agent.get("extra") or {}).get("provider_tool_declarations") or []
    return {"evidence": "local_official_template_reference",
            "historical_request_verified": False, "server_input_ids_verified": False,
            "prefix": text, "characters": len(text), "first_user": first_user,
            "settings": {k: v for k, v in kwargs.items() if k not in {"messages", "tools"}},
            "settings_source": "用户选择的参考设置，不代表历史请求设置已核对",
            "input_fields": origins, "function_tools": len(tools),
            "unrendered_provider_tools": provider,
            "tool_definitions_provenance": (agent.get("extra") or {}).get("tool_definitions_provenance"),
            "template": {"revision": REVISION, "sha256": TEMPLATE_SHA256, "url": SOURCE_URL},
            "boundary_text_invariance": True,
            "note": "按 ATIF 已记录字段渲染；不合并系统消息、不新增 steps；托管声明未转换为函数工具。"}


# One canonical rendering backs the readable H sequence and paged model context.
def _messages(data, selection):
    import copy
    messages, choices, excluded = [], [], []
    for i, step in enumerate(data.get("steps") or []):
        role, extra = step.get("source"), step.get("extra") or {}
        field = f"steps[{i}]"
        if role == "agent":
            choices.append({"value": "before:" + str(step["step_id"]),
                            "label": "生成前 · step " + str(step["step_id"])})
    valid = {x["value"] for x in choices} | {"all"}
    if selection not in valid:
        raise ValueError("无效的模型上下文生成位置")
    target_step = None
    for i, step in enumerate(data.get("steps") or []):
        role, extra = step.get("source"), step.get("extra") or {}
        field = f"steps[{i}]"
        if role == "agent" and selection == "before:" + str(step["step_id"]):
            target_step = step["step_id"]
            break
        if (extra.get("context_management") or {}).get("type") == "compaction":
            raise ValueError("包含压缩控制事件的归档不是单一上下文，请选择拆分窗口或真实请求快照")
        if role in {"system", "user"}:
            content = step.get("message")
            if not isinstance(content, str):
                raise ValueError("模型上下文当前只支持文本消息")
            messages.append({"role": role, "content": content,
                             "_fields": [field + ".message"], "_step": step.get("step_id"),
                             "_parts": [{"text": content, "field": field + ".message"}]})
        elif role == "agent":
            msg = {"role": "assistant", "content": step.get("message") or "",
                   "reasoning_content": step.get("reasoning_content") or "",
                   "_fields": [field], "_step": step.get("step_id")}
            if not isinstance(msg["content"], str) or not isinstance(msg["reasoning_content"], str):
                raise ValueError("模型上下文当前只支持文本输出")
            calls = []
            for call in step.get("tool_calls") or []:
                args = call.get("arguments")
                if isinstance(args, str):
                    args = json.loads(args)
                if not isinstance(args, dict):
                    raise ValueError("工具参数必须是 JSON 对象")
                calls.append({"id": call["tool_call_id"], "type": "function",
                              "function": {"name": call["function_name"], "arguments": copy.deepcopy(args)}})
            if calls:
                msg["tool_calls"] = calls
            messages.append(msg)
            for j, item in enumerate((step.get("observation") or {}).get("results") or []):
                origin = field + f".observation.results[{j}].content"
                if (item.get("extra") or {}).get("model_visible") is False:
                    excluded.append(origin)
                    continue
                if not isinstance(item.get("content"), str):
                    raise ValueError("工具结果正文缺失，无法构造完整模型上下文")
                messages.append({"role": "tool", "content": item["content"],
                                 "tool_call_id": item.get("source_call_id") or "",
                                 "_fields": [origin], "_step": step.get("step_id")})
        else:
            raise ValueError("无法映射的 ATIF 角色：" + str(role))
    if not messages:
        raise ValueError("模型上下文为空")
    leading = 0
    while leading < len(messages) and messages[leading]["role"] == "system":
        leading += 1
    if leading:
        parts = [part for msg in messages[:leading] for part in msg["_parts"]]
        messages = [{"role": "system", "content": "\n\n".join(p["text"] for p in parts),
                     "_parts": parts, "_fields": [p["field"] for p in parts],
                     "_step": messages[0]["_step"]}] + messages[leading:]
    return messages, choices, excluded, target_step


def _context_template():
    # Asset hash verification is shared with the prefix renderer.
    _templates()
    source = TEMPLATE.read_text()
    anchors = {
        '{%- set idx = loop.index0 -%}': '{{- _trace("message", idx, m) -}}',
        '{{- content or "" -}}': '{{- _trace("content", idx, m) -}}',
        r'{{- "\n\n" ~ render_tools(m.tools) -}}': '{{- _trace("tools", idx, m) -}}',
        '{{- ((m.reasoning_content if m.get("reasoning_content") is not none else m.get("thinking")) or "") ~ "</think>" -}}': '{{- _trace("reasoning", idx, m) -}}',
        r'{{- "\n\n<" ~ DSML ~ " calls>\n" ~ tcs.lines | join("\n") ~ "\n</" ~ DSML ~ " calls>" -}}': '{{- _trace("calls", idx, m) -}}',
        '{{- "<｜Assistant｜>" ~ ("<think>" if thinking and (not effective_drop or idx >= state.last_user) else "</think>") -}}': '{{- _trace("generation", idx, m) -}}',
    }
    for anchor, marker in anchors.items():
        expected = 2 if anchor == '{{- content or "" -}}' else 1
        if source.count(anchor) != expected:
            raise ValueError("官方模板结构改变，拒绝推测文本分段")
        source = source.replace(anchor, (anchor + marker) if 'set idx' in anchor else (marker + anchor))
    env = ImmutableSandboxedEnvironment(undefined=StrictUndefined)
    env.globals["raise_exception"] = _raise
    env.filters["tojson"] = lambda value, **kw: json.dumps(value, ensure_ascii=False, **kw)
    return env.from_string(source)


_context_template = lru_cache(maxsize=1)(_context_template)


def model_context(data, *, thinking=True, effort="max", selection="all"):
    import copy
    import re
    agent = data.get("agent") or {}
    if not _supports_reference(agent.get("model_name")):
        raise ValueError("模型上下文当前只支持 DeepSeek V4.1 Flash")
    if effort not in {"low", "medium", "high", "max"}:
        raise ValueError("无效的 reasoning_effort")
    tools = copy.deepcopy(_recorded_tools(data, agent))
    if not isinstance(tools, list):
        raise ValueError("ATIF 未记录工具定义，不能推定空工具集合")
    for tool in tools:
        if not isinstance(tool, dict) or tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
            raise ValueError("工具定义不是标准 type/function 格式")
        fn = tool["function"]
        if not isinstance(fn.get("name"), str) or not fn["name"]:
            raise ValueError("工具定义缺少函数名称")
        ordered = {key: fn[key] for key in ["name", "description", "parameters", "strict"] if key in fn}
        ordered.update({key: value for key, value in fn.items() if key not in ordered})
        tool["function"] = ordered
    messages, choices, excluded, target = _messages(data, selection)
    plain_messages = [{k: v for k, v in msg.items() if not k.startswith("_")} for msg in messages]
    add_prompt = selection != "all" and messages[-1]["role"] in {"user", "tool"}
    kwargs = dict(messages=plain_messages, tools=tools, thinking_mode="thinking" if thinking else "chat",
                  reasoning_effort=effort, drop_thinking=False, add_generation_prompt=add_prompt)
    rendered = _templates()[0].render(**kwargs)
    annotated = copy.deepcopy(messages)
    for msg in annotated:
        if msg["role"] == "user":
            msg["content"] = [{"type": "text", "text": msg["content"], "_fields": msg["_fields"]}]
    records = []
    nonce = "ATIFCTX_" + uuid.uuid4().hex + "_"
    if nonce in rendered:
        raise ValueError("渲染边界标记冲突")
    def trace(kind, index, message):
        marker = nonce + str(len(records)) + "_"
        records.append({"marker": marker, "kind": kind, "index": index, "message": message})
        return marker
    marked = _context_template().render(**{**kwargs, "messages": annotated}, _trace=trace)
    pattern = re.compile(re.escape(nonce) + r"\d+_")
    matches = list(pattern.finditer(marked))
    if len(matches) != len(records) or pattern.sub("", marked) != rendered:
        raise ValueError("分段插桩改变了模型文本，已拒绝展示")
    removed = 0
    for record, match in zip(records, matches):
        if record["marker"] != match.group():
            raise ValueError("模板边界顺序不一致")
        record["offset"] = match.start() - removed
        removed += len(match.group())
    result_messages = {r["index"]: r["message"] for r in records if r["kind"] == "message"}
    tool_origins = {m.get("tool_call_id"): m for m in messages if m["role"] == "tool"}
    pieces = []
    def add(symbol, title, text, fields=(), step=None, header=False):
        if text:
            pieces.append({"symbol": symbol, "title": title, "text": text,
                           "provenance": list(fields), "step_id": step, "header": header})
    first = records[0]["offset"] if records else len(rendered)
    add("S", "协议与系统前缀", rendered[:first], ["template.BOS"], header=True)
    for n, record in enumerate(records):
        end = records[n + 1]["offset"] if n + 1 < len(records) else len(rendered)
        text = rendered[record["offset"]:end]
        msg, kind = record["message"], record["kind"]
        fields, step = msg.get("_fields", []), msg.get("_step")
        role = msg["role"]
        if kind == "content" and role == "system":
            parts = msg.get("_parts") or [{"text": msg.get("content") or "", "field": "template.empty_system"}]
            merged = "\n\n".join(p["text"] for p in parts)
            if not text.startswith(merged):
                raise ValueError("系统正文边界不一致")
            offset = 0
            for j, part in enumerate(parts):
                part_text = ("\n\n" if j else "") + part["text"]
                add("S", "基础系统指令" if j == 0 else "Skills 与系统说明", part_text, [part["field"]], step)
                offset += len(part_text)
            add("S", "系统格式", text[offset:], ["template.system"], step)
        elif kind == "tools":
            add("S", "工具定义 · 官方模板渲染", text, ["agent.tool_definitions", "template.render_tools"])
        elif kind == "generation":
            next_msg = result_messages.get(record["index"] + 1, {})
            add("R" if thinking else "M", "推理" if thinking else "assistant 正文", text,
                ["template.assistant_generation_prefix"], next_msg.get("_step", target))
        elif kind == "reasoning":
            add("R", "推理", text, [x + ".reasoning_content" for x in fields], step)
        elif kind == "calls":
            add("T", "工具调用 · DSML", text, [x + ".tool_calls" for x in fields], step)
        elif kind == "content" and role == "assistant":
            add("M", "assistant 正文", text, [x + ".message" for x in fields], step)
        elif kind == "message" and role == "user":
            blocks = msg.get("content_blocks") or []
            sources = []
            for block in blocks:
                sources += block.get("_fields") or tool_origins.get(block.get("tool_use_id"), {}).get("_fields", [])
            is_tools = bool(blocks) and all(b["type"] == "tool_result" for b in blocks)
            add("O" if is_tools else "U", "工具返回" if is_tools else "用户侧输入", text, sources)
        elif role == "system":
            add("S", "协议与系统前缀", text, ["template.system_header"], step, header=True)
        else:
            add("M", "模型格式", text, ["template.transition"], step)
    folded = []
    for piece in pieces:
        if folded and folded[-1]["header"] and piece["symbol"] == "S":
            previous = folded.pop()
            piece = {**piece, "text": previous["text"] + piece["text"],
                     "provenance": previous["provenance"] + piece["provenance"]}
        elif folded and piece["symbol"] in {"R", "M"} and folded[-1]["symbol"] == piece["symbol"] and folded[-1]["step_id"] == piece["step_id"]:
            previous = folded.pop()
            piece = {**piece, "text": previous["text"] + piece["text"],
                     "provenance": previous["provenance"] + piece["provenance"]}
        folded.append(piece)
    if "".join(p["text"] for p in folded) != rendered:
        raise ValueError("序列 H 与模型上下文不一致")
    digest = hashlib.sha256(rendered.encode()).hexdigest()
    counts, offset, blocks = {}, 0, []
    for piece in folded:
        symbol = piece["symbol"]; index = counts.get(symbol, 0); counts[symbol] = index + 1
        blocks.append({"key": "CTX_" + digest[:10] + "_" + symbol + str(index), "symbol": symbol,
                       "index": index, "title": piece["title"], "role": "system" if symbol == "S" else "tool" if symbol == "O" else "user" if symbol == "U" else "assistant",
                       "state": "rendered", "step_id": piece["step_id"], "text": piece["text"],
                       "chars": len(piece["text"]), "provenance": piece["provenance"], "items": [],
                       "notation": ("S" if symbol == "S" and index == 0 else symbol + str(index).translate(str.maketrans("0123456789", "₀₁₂₃₄₅₆₇₈₉"))),
                       "rendered_context": True, "context_start": offset, "context_end": offset + len(piece["text"]),
                       "evidence": "rendered_from_atif_not_historical_request"})
        offset += len(piece["text"])
    return {"id": digest, "text": rendered, "blocks": blocks, "counts": counts,
            "choices": [{"value": "all", "label": "完整窗口（含生成输出）"}] + choices,
            "selection": selection, "settings": {"thinking": thinking, "effort": effort},
            "profile": {"merge_initial_systems": "join with two newlines in original order",
                        "function_field_order": ["name", "description", "parameters", "strict"],
                        "historical_inputs_verified": False, "reference_only": True},
            "template": {"revision": REVISION, "sha256": TEMPLATE_SHA256, "url": SOURCE_URL},
            "unrendered_provider_tools": (agent.get("extra") or {}).get("provider_tool_declarations") or [],
            "excluded_model_invisible_fields": excluded, "trace_text_invariance": True,
            "h_text_sha256": digest}


def context_page(context, start=0, limit=24000):
    total = len(context["text"])
    if start < 0 or start > total or not 1 <= limit <= 32000:
        raise ValueError("无效的上下文分页范围")
    end = min(total, start + limit)
    return {"id": context["id"], "text": context["text"][start:end], "start": start, "end": end,
            "total_characters": total, "page_size": limit, "pages": max(1, (total + limit - 1) // limit),
            "choices": context["choices"], "selection": context["selection"],
            "settings": context["settings"], "profile": context["profile"], "template": context["template"],
            "unrendered_provider_tools": context["unrendered_provider_tools"],
            "excluded_model_invisible_fields": context["excluded_model_invisible_fields"],
            "trace_text_invariance": True, "h_text_sha256": context["h_text_sha256"]}


def context_view(context, archive):
    meta = dict(archive["meta"])
    meta.update(model_context=context["id"], counts=context["counts"],
                compactions=0, warnings=["按所选规则重建，历史请求未逐条核验"],
                rendering_profile=context["profile"])
    blocks = []
    for block in context["blocks"]:
        item = dict(block);item["text"] = block["text"][:6000];item["truncated"] = block["chars"] > 6000
        blocks.append(item)
    return {"meta": meta, "blocks": blocks, "requests": [], "compactions": [],
            "notes": {"archive": "序列 H 是同一份模型上下文文本的可读分段；拼接全文与模型上下文 SHA256 相同。",
                      "request": "所选请求适配规则和官方模板重建，不冒充历史实际请求。",
                      "tokens": "显示字符范围，不把字符数或分块计数当作 token 数。",
                      "narrative": "分段只为阅读，工具位置和控制标记由官方模板决定。"}}
