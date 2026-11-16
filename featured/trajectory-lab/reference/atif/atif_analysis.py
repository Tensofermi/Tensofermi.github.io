"""ATIF-only summaries: composition, per-call trend, events, agent activity.

The trajectory page already renders one archive as an ordered S/U/R/M/T/O
sequence. That sequence answers "what is in here, in order"; it does not answer
"how did the window grow", "which files did the agent touch", "what did it
run". This module answers those four questions from fields the ATIF file
already carries, and it adds no evidence of its own:

* **composition** counts *characters* per block symbol. It is not a token
  breakdown; nothing here tokenizes text.
* **trend** plots ``steps[i].metrics.prompt_tokens``, the count the serving
  side reported for that step. No value is derived, scaled or reconstructed.
  A point exists only where ATIF reports a number.
* **activity** reads tool-call arguments (``exec_command.cmd``, ``apply_patch``
  patch headers, ``web_search.query``, ``web_fetch.url``) and the observed
  result envelope (``Process exited with code N`` / ``Wall time: ...``).
  Every row keeps the step id and the block it came from.
* **events** lists only declarations ATIF makes: compaction boundaries, model
  renames, trainable/incomplete flags, truncated returns, goal updates.

Anything absent is absent. When a trajectory ships no ``metrics``, the trend is
empty and says so rather than showing zeros.
"""

from __future__ import annotations

import json
from collections import Counter, OrderedDict

EXIT_CODE = "Process exited with code "
WALL_TIME = "Wall time: "
PATCH_FILE = ("*** Add File: ", "*** Update File: ", "*** Delete File: ")
PATCH_MOVE = "*** Move to: "

SHELL_TOOLS = {"exec_command", "execute_command", "shell", "bash", "run_command"}
SEARCH_TOOLS = {"web_search", "search", "web_search_preview"}
FETCH_TOOLS = {"web_fetch", "mcp__web_fetch", "mcp__web_fetch::web_fetch", "fetch", "web_open"}
PATCH_TOOLS = {"apply_patch"}
PATCH_MARKER = "*** Begin Patch"
SKIP_WORDS = {"cd", "export", "set", "source", ".", "sudo", "env", "pushd"}
GOAL_TOOLS = {"update_goal", "update_plan"}

MAX_FILES = 120
MAX_FILE_OPS = 12
MAX_RUNS = 400
MAX_EVENTS = 300
MAX_QUERIES = 60
CMD_HEAD = 160

PART_ORDER = ("S", "U", "R", "M", "T", "O", "C", "?")

EVENT_KINDS = OrderedDict((
    ("compact", "压缩"),
    ("model", "模型切换"),
    ("status", "训练状态"),
    ("trunc", "截断返回"),
    ("goal", "目标更新"),
))


# --------------------------------------------------------------------- helpers

def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _text(value):
    return value if isinstance(value, str) else ""


def _head(text, limit=CMD_HEAD):
    flat = " ".join(_text(text).split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _program(cmd):
    """First executable word of a shell line — a reading, not a shell parse.

    Segments are split on ``&&``, ``||``, ``;``, ``|`` and newlines, then leading
    no-ops (``cd dir``, ``export X=1``, ``set -e``) are dropped so the chart names
    the program the agent invoked rather than the navigation before it. When no
    segment yields a program the row is left without one instead of guessing.
    """
    text = _text(cmd).strip()
    if not text:
        return None
    for segment in text.replace("||", "&&").replace(";", "&&").replace("|", "&&").split("&&"):
        words = segment.split()
        while words:
            head = words[0].strip("\"'`(")
            if head in SKIP_WORDS:
                words = words[1:]
                if head in ("cd", "pushd") and words:
                    words = words[1:]
                continue
            if "=" in head and not head.startswith("-"):
                words = words[1:]
                continue
            break
        if not words:
            continue
        head = words[0].strip("\"'`()")
        if head.startswith("./"):
            head = head[2:]
        name = head.rsplit("/", 1)[-1]
        if name and not name.startswith("$"):
            return name
    return None


def _envelope(text):
    """Read the exec result envelope: exit code and wall time, when present."""
    lines = _text(text).splitlines()[:12]
    code = wall = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(EXIT_CODE):
            tail = stripped[len(EXIT_CODE):].split()[0] if stripped[len(EXIT_CODE):].split() else ""
            if tail.lstrip("-").isdigit():
                code = int(tail)
        elif stripped.startswith(WALL_TIME):
            tail = stripped[len(WALL_TIME):].split()[0] if stripped[len(WALL_TIME):].split() else ""
            try:
                wall = float(tail)
            except ValueError:
                wall = None
    return code, wall


def _call_index(blocks):
    """call_id -> {block, item} using the T blocks the archive already built."""
    index = {}
    for block in blocks:
        if block.get("symbol") != "T":
            continue
        for item in block.get("items") or []:
            call_id = item.get("call_id")
            if call_id:
                index.setdefault(call_id, {"block": block["key"], "item": item.get("index"),
                                           "name": item.get("name")})
    return index


def _step_blocks(blocks):
    """step_id -> block keys, in archive order."""
    result = {}
    for block in blocks:
        step_id = block.get("step_id")
        if step_id is None:
            continue
        result.setdefault(step_id, []).append(block["key"])
    return result


def _result_content(steps):
    """call_id -> observed result text, straight from observation.results[]."""
    content = {}
    for step in steps:
        observation = step.get("observation") if isinstance(step, dict) else None
        if not isinstance(observation, dict):
            continue
        for item in observation.get("results") or []:
            if not isinstance(item, dict):
                continue
            call_id = item.get("source_call_id")
            if call_id and call_id not in content:
                content[call_id] = _text(item.get("content"))
    return content


# ------------------------------------------------------------------ composition

def _composition(blocks, data):
    totals = Counter()
    for block in blocks:
        symbol = block.get("symbol")
        if symbol in totals or symbol in PART_ORDER:
            totals[symbol] += len(_text(block.get("text"))) + sum(
                len(_text(item.get("text"))) for item in block.get("items") or [])
    parts = []
    for symbol in PART_ORDER:
        chars = totals.get(symbol, 0)
        if not chars:
            continue
        parts.append({"key": symbol, "chars": chars,
                      "blocks": sum(1 for block in blocks if block.get("symbol") == symbol),
                      "evidence": "atif"})
    definitions = _tool_definition_chars(data)
    if definitions:
        parts.append({"key": "D", "chars": definitions,
                      "blocks": _tool_definition_count(data), "evidence": "atif"})
    total = sum(part["chars"] for part in parts)
    for part in parts:
        part["share"] = round(part["chars"] / total, 4) if total else 0
    return {"total_chars": total, "parts": parts}


def _definitions(data):
    definitions = data.get("tool_definitions")
    if not isinstance(definitions, list):
        agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
        definitions = agent.get("tool_definitions")
    return definitions if isinstance(definitions, list) else []


def _tool_definition_chars(data):
    definitions = _definitions(data)
    if not definitions:
        return 0
    return len(json.dumps(definitions, ensure_ascii=False, separators=(",", ":")))


def _tool_definition_count(data):
    return len(_definitions(data))


# ------------------------------------------------------------------------ trend

def _points(steps, step_blocks):
    points, previous = [], None
    for position, step in enumerate(steps):
        if not isinstance(step, dict) or step.get("source") != "agent":
            continue
        metrics = step.get("metrics") if isinstance(step.get("metrics"), dict) else {}
        prompt = _number(metrics.get("prompt_tokens"))
        if prompt is None:
            continue
        inner = metrics.get("extra") if isinstance(metrics.get("extra"), dict) else {}
        cached = _number(metrics.get("cached_tokens"))
        point = {
            "step_id": step.get("step_id", position + 1),
            "position": position,
            "prompt": prompt,
            "completion": _number(metrics.get("completion_tokens")),
            "cached": cached,
            "reasoning": _number(inner.get("reasoning_output_tokens")),
            "stamp": step.get("timestamp") if isinstance(step.get("timestamp"), str) else None,
            "blocks": step_blocks.get(step.get("step_id", position + 1), []),
            "delta": prompt - previous if previous is not None else None,
            "cuts": [],
        }
        points.append(point)
        previous = prompt
    return points


def _attach_cuts(blocks, points):
    """A C block sits between two agent steps; mark the step that follows it."""
    by_step = {}
    for point in points:
        by_step.setdefault(point["step_id"], point)
    pending, seen = [], set()
    for block in blocks:
        step_id = block.get("step_id")
        if block.get("symbol") == "C":
            pending.append(block["key"])
            continue
        if step_id in by_step and step_id not in seen and pending:
            by_step[step_id]["cuts"] = list(pending)
            pending = []
        if step_id in by_step:
            seen.add(step_id)
    return points


def _trend(points, steps):
    prompts = [point["prompt"] for point in points]
    return {
        "unit": "step",
        "series": "prompt_tokens",
        "points": points,
        "peak": max(prompts) if prompts else None,
        "floor": min(prompts) if prompts else None,
        "agent_steps": sum(1 for step in steps if isinstance(step, dict) and step.get("source") == "agent"),
    }


def _kpi(points, steps, compactions):
    prompt = [point["prompt"] for point in points]
    cached = [point["cached"] for point in points if point["cached"] is not None]
    reasoning = [point["reasoning"] for point in points if point["reasoning"] is not None]
    completion = [point["completion"] for point in points if point["completion"] is not None]
    total_prompt = sum(prompt)
    return {
        "calls": len(points),
        "steps": len(steps),
        "prompt_total": total_prompt or None,
        "prompt_peak": max(prompt) if prompt else None,
        "prompt_last": prompt[-1] if prompt else None,
        "completion_total": sum(completion) if completion else None,
        "cached_total": sum(cached) if cached else None,
        "cached_known": len(cached),
        "cache_rate": round(sum(cached) / total_prompt, 4) if cached and total_prompt else None,
        "reasoning_total": sum(reasoning) if reasoning else None,
        "compactions": compactions,
    }


# --------------------------------------------------------------------- activity

def _patch_ops(patch_text):
    """Read apply_patch sections: file, operation, added/removed line counts."""
    operations, current = [], None
    for line in _text(patch_text).splitlines():
        matched = next((prefix for prefix in PATCH_FILE if line.startswith(prefix)), None)
        if matched:
            verb = matched.split()[1].lower()
            current = {"path": line[len(matched):].strip(), "op": verb, "added": 0, "removed": 0}
            operations.append(current)
            continue
        if line.startswith(PATCH_MOVE) and current:
            current["move_to"] = line[len(PATCH_MOVE):].strip()
            continue
        if current is None:
            continue
        if line.startswith("+"):
            current["added"] += 1
        elif line.startswith("-"):
            current["removed"] += 1
    return operations


def _collect_files(steps, calls, results, warnings):
    files = OrderedDict()
    for position, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            name = call.get("function_name") or (call.get("function") or {}).get("name") or ""
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                continue
            call_id = call.get("tool_call_id") or call.get("id")
            block = (calls.get(call_id) or {}).get("block")
            operations = []
            if name in PATCH_TOOLS:
                operations = _patch_ops(arguments.get("input") or arguments.get("patch") or "")
            elif name in SHELL_TOOLS:
                # `apply_patch <<'PATCH'` reaches us as a shell call, so the patch
                # body is read from the command text when the marker is present.
                cmd = arguments.get("cmd") or arguments.get("command") or ""
                if PATCH_MARKER in _text(cmd):
                    operations = _patch_ops(cmd)
            for verb in ("file_path", "path"):
                if isinstance(arguments.get(verb), str) and arguments[verb]:
                    operations.append({"path": arguments[verb], "op": "touch", "added": 0, "removed": 0})
            for operation in operations:
                path = operation["path"]
                if not path:
                    continue
                entry = files.setdefault(path, {"path": path, "ops": Counter(), "added": 0, "removed": 0,
                                                "steps": [], "calls": [],
                                                "workdir": _text(arguments.get("workdir")) or None})
                entry["ops"][operation["op"]] += 1
                entry["added"] += operation["added"]
                entry["removed"] += operation["removed"]
                if step.get("step_id") not in entry["steps"]:
                    entry["steps"].append(step.get("step_id"))
                if len(entry["calls"]) < MAX_FILE_OPS:
                    entry["calls"].append({"step_id": step.get("step_id"), "block": block,
                                           "op": operation["op"], "added": operation["added"],
                                           "removed": operation["removed"],
                                           "move_to": operation.get("move_to")})
    rows = []
    for entry in files.values():
        rows.append({"path": entry["path"], "ops": dict(entry["ops"]), "added": entry["added"],
                     "removed": entry["removed"], "steps": entry["steps"], "calls": entry["calls"],
                     "workdir": entry["workdir"]})
    rows.sort(key=lambda row: (-(row["added"] + row["removed"]), row["path"]))
    if len(rows) > MAX_FILES:
        warnings.append(f"文件活动超过 {MAX_FILES} 个文件，只保留写入行数最多的 {MAX_FILES} 个")
        rows = rows[:MAX_FILES]
    return rows


def _collect_commands(steps, calls, results, warnings):
    runs, programs = [], Counter()
    for position, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            name = call.get("function_name") or (call.get("function") or {}).get("name") or ""
            if name not in SHELL_TOOLS:
                continue
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                continue
            cmd = arguments.get("cmd") or arguments.get("command") or ""
            program = _program(cmd)
            call_id = call.get("tool_call_id") or call.get("id")
            linked = calls.get(call_id) or {}
            code, wall = _envelope(results.get(call_id))
            programs[program or "（空命令）"] += 1
            if len(runs) < MAX_RUNS:
                runs.append({"step_id": step.get("step_id"), "program": program,
                             "cmd": _head(cmd), "exit": code, "wall": wall,
                             "block": linked.get("block"), "workdir": _text(arguments.get("workdir")) or None})
    if len(runs) >= MAX_RUNS:
        warnings.append(f"命令执行超过 {MAX_RUNS} 条，只保留前 {MAX_RUNS} 条")
    failed = sum(1 for run in runs if run["exit"] not in (None, 0))
    timed = [run["wall"] for run in runs if run["wall"] is not None]
    return {"runs": runs, "total": sum(programs.values()),
            "programs": [{"name": name, "count": value} for name, value in programs.most_common(14)],
            "failed": failed, "wall_total": round(sum(timed), 3) if timed else None,
            "wall_known": len(timed)}


def _collect_network(steps, calls):
    queries, fetches = Counter(), Counter()
    for step in steps:
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            name = call.get("function_name") or (call.get("function") or {}).get("name") or ""
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                continue
            if name in SEARCH_TOOLS and isinstance(arguments.get("query"), str):
                queries[arguments["query"]] += 1
            elif name in FETCH_TOOLS and isinstance(arguments.get("url"), str):
                url = arguments["url"]
                host = url.split("//", 1)[-1].split("/", 1)[0] if "//" in url else url.split("/", 1)[0]
                fetches[host or url] += 1
    return {"searches": [{"query": query, "count": value}
                         for query, value in queries.most_common(MAX_QUERIES)],
            "search_total": sum(queries.values()),
            "fetches": [{"host": host, "count": value} for host, value in fetches.most_common(MAX_QUERIES)],
            "fetch_total": sum(fetches.values())}


def _timestamp(value):
    """ISO stamp -> sortable seconds; keeps the archive honest about missing time."""
    if not isinstance(value, str) or len(value) < 19:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _collect_timing(points):
    stamps = [point["stamp"] for point in points if point["stamp"]]
    seconds = None
    if len(stamps) == len(points) and len(points) > 1:
        first, last = _timestamp(stamps[0]), _timestamp(stamps[-1])
        if first and last and last >= first:
            seconds = round(last - first, 1)
    gaps, previous = [], None
    for point in points:
        current = _timestamp(point["stamp"])
        if current is not None and previous is not None:
            gaps.append(round(current - previous, 1))
        previous = current if current is not None else previous
    return {"wall_seconds": seconds, "step_gaps": gaps[:400],
            "median_gap": sorted(gaps)[len(gaps) // 2] if gaps else None}


# ----------------------------------------------------------------------- events

def _collect_events(steps, blocks, points):
    events, warnings = [], []
    for block in blocks:
        if block.get("symbol") != "C":
            continue
        events.append({"kind": "compact", "step_id": block.get("step_id"), "block": block["key"],
                       "title": block.get("title") or "压缩",
                       "detail": block.get("control_note") or block.get("boundary") or ""})
    previous_model = None
    for position, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        model = step.get("model_name")
        if isinstance(model, str) and model and previous_model and model != previous_model:
            events.append({"kind": "model", "step_id": step.get("step_id"), "block": None,
                           "title": "模型切换", "detail": f"{previous_model} → {model}"})
        if isinstance(model, str) and model:
            previous_model = model
        extra = step.get("extra") if isinstance(step.get("extra"), dict) else {}
        reasons = []
        if extra.get("failed_attempt") is True or extra.get("call_kind") == "failed_attempt":
            reasons.append("failed_attempt")
        if extra.get("incomplete") is True:
            reasons.append("incomplete")
        if reasons:
            events.append({"kind": "status", "step_id": step.get("step_id"), "block": None,
                           "title": "不计入训练", "detail": "、".join(reasons)})
    for block in blocks:
        if block.get("symbol") != "O":
            continue
        for item in block.get("items") or []:
            if item.get("harness_truncated") or item.get("model_visible") is False:
                detail = []
                if item.get("harness_truncated"):
                    detail.append("harness 截断")
                if item.get("raw_chars") is not None:
                    detail.append(f"原始 {item['raw_chars']} 字符")
                if item.get("visible_chars") is not None:
                    detail.append(f"可见 {item['visible_chars']} 字符")
                if item.get("model_visible") is False:
                    detail.append("未进入训练")
                events.append({"kind": "trunc", "step_id": block.get("step_id"), "block": block["key"],
                               "title": item.get("name") or "工具返回",
                               "detail": " · ".join(detail)})
    for step in steps:
        if not isinstance(step, dict):
            continue
        for call in step.get("tool_calls") or []:
            if not isinstance(call, dict):
                continue
            name = call.get("function_name") or (call.get("function") or {}).get("name") or ""
            if name not in GOAL_TOOLS:
                continue
            arguments = call.get("arguments")
            if not isinstance(arguments, dict):
                continue
            status = arguments.get("status")
            if isinstance(status, str) and status:
                events.append({"kind": "goal", "step_id": step.get("step_id"), "block": None,
                               "title": name, "detail": status})
    if len(events) > MAX_EVENTS:
        warnings.append(f"事件超过 {MAX_EVENTS} 条，只保留前 {MAX_EVENTS} 条")
        events = events[:MAX_EVENTS]
    counts = Counter(event["kind"] for event in events)
    return {"items": events, "counts": dict(counts),
            "kinds": [{"key": key, "label": label, "count": counts.get(key, 0)}
                      for key, label in EVENT_KINDS.items()]}


# ------------------------------------------------------------------------ build

def build(data, blocks):
    """Summarise one ATIF object. Pure: same input, same output, no I/O."""
    steps = [step for step in (data.get("steps") or []) if isinstance(step, dict)]
    warnings = []
    step_blocks = _step_blocks(blocks)
    calls = _call_index(blocks)
    results = _result_content(steps)
    points = _attach_cuts(blocks, _points(steps, step_blocks))
    compactions = sum(1 for block in blocks if block.get("symbol") == "C")
    composition = _composition(blocks, data)
    files = _collect_files(steps, calls, results, warnings)
    commands = _collect_commands(steps, calls, results, warnings)
    network = _collect_network(steps, calls)
    events = _collect_events(steps, blocks, points)
    trend = _trend(points, steps)
    return {
        "kpi": _kpi(points, steps, compactions),
        "composition": composition,
        "trend": trend,
        "timing": _collect_timing(points),
        "files": files,
        "commands": commands,
        "network": network,
        "events": events,
        "warnings": warnings,
        "notes": {
            "composition": "组成按块字符统计，不是 token 分解；工具定义取 ATIF 声明序列化后的字符数。",
            "trend": "趋势只画 ATIF metrics 报告的服务端 prompt_tokens；没有指标就没有点，不补零。",
            "activity": "文件与命令从调用参数和返回文本读出，保留 step 与块坐标，不做推测补全。",
            "events": "事件只列 ATIF 自己声明的变化：压缩、模型名、训练状态、截断返回、目标更新。",
        },
    }
