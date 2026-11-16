"""Serve original ATIF views against browser-selected files in a virtual directory."""

import json
from collections import OrderedDict
from pathlib import Path

import atif_analysis
import atif_template
import atif_view
from atif_capture import CaptureStore

CAPTURES = Path("/atif-captures")
CAPTURES.mkdir(exist_ok=True)
PREVIEW = 480
archive = None
data = None
contexts = OrderedDict()


def context(args):
    key = (args.get("thinking") != "0", args.get("effort", "max"), args.get("selection", "all"))
    if key not in contexts:
        contexts[key] = atif_template.model_context(data, thinking=key[0], effort=key[1], selection=key[2])
        if len(contexts) > 2:
            contexts.popitem(last=False)
    contexts.move_to_end(key)
    return contexts[key]


def context_by_id(args):
    for item in contexts.values():
        if item["id"] == args.get("context"):
            return item
    raise ValueError("该上下文已从缓存移出，请重新选择生成位置。")


def capture_reference(args):
    return atif_view.file_reference(archive, args.get("ref"))["reference"]


def compaction_block(key):
    result = next((item for item in archive["compactions"] if item["key"] == key), None)
    if result is None:
        raise ValueError("找不到这次压缩。")
    return result


def request_entry(request_id):
    result = next((item for item in archive["requests"] if item["id"] == request_id), None)
    if result is None:
        raise ValueError("找不到这次请求。")
    return result


def related_compactions(entry):
    request_file = (entry["files"].get("chat_request") or {}).get("path")
    if not request_file:
        return []
    return [block for block in archive["compactions"]
            if (block.get("references", {}).get("after_request") or {}).get("path") == request_file]


def verify_compactions(keys):
    if not archive["store"] or not keys:
        return
    verified = atif_view.prepare(data, directory=CAPTURES, source=archive["meta"]["source"])
    updated = {}
    for block in verified["compactions"]:
        if block["key"] not in keys:
            continue
        updated[block["key"]] = block
        archive["injected"].update(atif_view._injected_index([block]))
    archive["compactions"] = [updated.get(block["key"], block) for block in archive["compactions"]]
    archive["blocks"] = [updated.get(block["key"], block) for block in archive["blocks"]]


def load(raw, source, captured):
    global archive, data
    parsed = json.loads(raw)
    view = atif_view.prepare(parsed, source=source)
    summary = atif_view.public(view, text_cap=PREVIEW, budget=90_000)
    summary["analysis"] = atif_analysis.build(parsed, view["blocks"])
    summary["context_choices"] = [{"value": "all", "label": "完整窗口（含生成输出）"}]
    summary["context_choices"].extend(
        {"value": f"before:{step['step_id']}", "label": f"生成前 · step {step['step_id']}"}
        for step in parsed["steps"] if isinstance(step, dict) and step.get("source") == "agent" and "step_id" in step
    )
    if captured:
        view["store"] = CaptureStore(CAPTURES)
        view["meta"]["captures"]["available"] = True
    archive, data = view, parsed
    contexts.clear()
    return json.dumps(summary, ensure_ascii=False, allow_nan=False)


def dispatch(action, payload):
    args = json.loads(payload)
    if archive is None:
        raise ValueError("请先打开 ATIF 文件。")
    if action == "text":
        result = {"blocks": [atif_view.block_text(archive, key) for key in args["keys"].split(",")[:40]]}
    elif action == "context":
        selected = context(args)
        result = atif_template.context_page(selected, int(args.get("start", "0")), int(args.get("limit", "24000")))
        if args.get("view") == "1":
            result["view"] = atif_template.context_view(selected, archive)
            for block in result["view"]["blocks"]:
                block["text"] = block["text"][:PREVIEW]
                block["truncated"] = block["chars"] > PREVIEW
    elif action == "context/block":
        selected = context_by_id(args)
        blocks = [block for block in selected["blocks"] if block["key"] == args["key"]]
        result = {"blocks": blocks}
    elif action == "context/tokens":
        result = context_by_id(args)["text"]
    elif action == "search":
        key = args.get("context")
        blocks = context_by_id(args)["blocks"] if key else archive["blocks"]
        needle = args["q"].casefold()
        def matches(block):
            return any(needle in str(block.get(field) or "").casefold() for field in ("title", "text", "name"))
        result = [block["key"] for block in blocks
                  if matches(block) or any(matches(item) for item in block.get("items", ()))]
    elif action == "request":
        entry = request_entry(args["id"])
        verify_compactions({block["key"] for block in related_compactions(entry)})
        result = atif_view.request_snapshot(archive, args["id"])
    elif action == "compaction":
        block = compaction_block(args["key"])
        verify_compactions({block["key"]})
        result = dict(compaction_block(args["key"]))
        # Match the public stream shape. The internal signatures contain full messages.
        result["injected"] = [{k: v for k, v in row.items() if k != "signature"}
                              for row in result["injected"]]
    elif action == "file":
        result = archive["store"].verify(capture_reference(args))["path"]
    elif action == "references":
        if args["kind"] == "request":
            entry = request_entry(args["id"])
            result = list(entry["files"].values())
            for block in related_compactions(entry):
                result.extend(block["references"].values())
        elif args["kind"] == "compaction":
            result = list(compaction_block(args["key"])["references"].values())
        else:
            result = [capture_reference(args)]
    else:
        raise ValueError("未知的 ATIF 操作。")
    return json.dumps(result, ensure_ascii=False, allow_nan=False)
