/* Build portable ATIF from locally captured Agent events. */
(() => {
    "use strict";

    const string = (value) => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
    const integer = (value) => Number.isSafeInteger(value) && value >= 0;
    const messageOf = (record) => record.response?.choices?.[0]?.message;
    const toolsOf = (message) => Array.isArray(message?.tool_calls) ? message.tool_calls : [];

    function argumentsOf(raw) {
        try {
            const value = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (value && typeof value === "object" && !Array.isArray(value)) return { arguments: value };
        } catch {
            // The original value is retained below when it is not a JSON object.
        }
        return raw == null ? { arguments: {} } : { arguments: {}, extra: { raw_arguments: raw } };
    }

    function usageOf(usage) {
        const values = {
            prompt_tokens: usage?.prompt_tokens,
            completion_tokens: usage?.completion_tokens,
            cached_tokens: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens,
        };
        return Object.fromEntries(Object.entries(values).filter(([, value]) => integer(value)));
    }

    function makeRun(body, time, id) {
        return {
            type: "agent_run", id, created_at: time, status: "running",
            messages: structuredClone(body.messages), tools: structuredClone(body.tools || []),
            effort: body.effort, turns: [],
        };
    }

    function makeTurn(record) {
        return {
            record_id: record.id, timestamp: record.created_at, model: record.model,
            finish_reason: record.finish_reason, message: messageOf(record) || null,
            metrics: usageOf(record.usage), observations: [],
        };
    }

    function build(run) {
        const steps = [];
        const usedIds = new Set();
        const historicalCalls = new Map();
        const add = (source, message, fields) => {
            const step = { step_id: steps.length + 1, source, message: string(message), ...fields };
            steps.push(step);
            return step;
        };

        function addCalls(step, calls) {
            const ids = new Map();
            if (calls.length) {
                step.tool_calls = calls.map((call, index) => {
                    const providerId = typeof call?.id === "string" && call.id ? call.id : null;
                    let id = providerId;
                    if (!id || usedIds.has(id)) {
                        id = "atif-" + step.step_id + "-" + (index + 1);
                        while (usedIds.has(id)) id += "-local";
                    }
                    usedIds.add(id);
                    ids.set(providerId, id);
                    const args = argumentsOf(call?.function?.arguments);
                    const extra = { ...args.extra };
                    if (id !== providerId) extra.provider_call_id = providerId;
                    return {
                        tool_call_id: id, function_name: call?.function?.name || "unknown",
                        arguments: args.arguments, ...(Object.keys(extra).length ? { extra } : {}),
                    };
                });
            }
            return ids;
        }

        function observation(step, content, callId, success, execution) {
            const item = { content: string(content) };
            if (callId) item.source_call_id = callId;
            if (typeof success === "boolean" || execution) item.extra = { success, execution };
            (step.observation ??= { results: [] }).results.push(item);
        }

        const lastHistoricReply = run.messages.findLastIndex((message) => message.role === "assistant");
        for (const [index, message] of run.messages.entries()) {
            const copied = index <= lastHistoricReply || message.role === "tool" ? { is_copied_context: true } : {};
            if (message.role === "assistant") {
                const step = add("agent", message.content, copied);
                if (message.reasoning_content) step.reasoning_content = string(message.reasoning_content);
                for (const [original, id] of addCalls(step, toolsOf(message))) historicalCalls.set(original, { step, id });
            } else if (message.role === "tool") {
                const target = historicalCalls.get(message.tool_call_id);
                if (target) observation(target.step, message.content, target.id);
                else {
                    const step = add("system", "", {
                        ...copied, extra: { input_role: "tool", input_tool_call_id: message.tool_call_id },
                    });
                    observation(step, message.content);
                }
            } else if (message.role === "system" || message.role === "user") add(message.role, message.content, copied);
        }

        for (const turn of run.turns) {
            const message = turn.message;
            const step = add("agent", message?.content, {
                timestamp: turn.timestamp, model_name: turn.model, llm_call_count: 1,
                extra: { local_record_id: turn.record_id, finish_reason: turn.finish_reason },
            });
            if (run.effort) step.reasoning_effort = run.effort;
            if (message?.reasoning_content) step.reasoning_content = string(message.reasoning_content);
            if (Object.keys(turn.metrics).length) step.metrics = turn.metrics;
            const ids = addCalls(step, toolsOf(message));
            for (const result of turn.observations) {
                observation(step, result.content, ids.get(result.call_id), result.success, result.execution);
            }
        }

        const final_metrics = { total_steps: steps.length };
        for (const metric of ["prompt_tokens", "completion_tokens", "cached_tokens"]) {
            if (run.turns.length && run.turns.every((turn) => integer(turn.metrics[metric]))) {
                final_metrics["total_" + metric] = run.turns.reduce((sum, turn) => sum + turn.metrics[metric], 0);
            }
        }

        return {
            schema_version: "ATIF-v1.7", session_id: run.id,
            agent: {
                name: "Trajectory Lab", version: "1.0",
                model_name: run.turns[0]?.model,
                tool_definitions: run.tools,
            },
            steps, final_metrics,
            extra: { run_status: run.status, started_at: run.created_at, ended_at: run.ended_at, recovered: run.recovered || undefined },
        };
    }

    function recoveredRuns(all) {
        const legacy = all.filter((record) => record.type === "inference" && record.agent && !record.agent.run_id);
        const groups = new Map();
        for (const record of legacy) {
            const n = record.agent.iteration;
            if (!groups.has(n)) groups.set(n, []);
            groups.get(n).push(record);
        }
        const results = [];
        for (const first of groups.get(1) || []) {
            const body = first.api_request;
            if (!Array.isArray(body?.messages)) continue;
            const run = makeRun(body, first.created_at, first.id);
            run.effort = body.reasoning_effort;
            run.recovered = true;
            let current = first;
            while (current) {
                const turn = makeTurn(current);
                run.turns.push(turn);
                run.ended_at = current.created_at;
                const calls = toolsOf(turn.message);
                const lastIteration = current.agent.iteration >= current.agent.max_iterations;
                if (!calls.length || lastIteration) {
                    run.status = calls.length ? "iteration_limit" : "completed";
                    break;
                }

                const previous = [...current.api_request.messages, { ...turn.message, role: "assistant" }];
                const ids = new Set(calls.map((call) => call.id));
                const candidates = (groups.get(current.agent.iteration + 1) || []).flatMap((record) => {
                    const messages = record.api_request?.messages;
                    if (record.created_at < current.created_at || record.model_key !== current.model_key ||
                        record.agent.max_iterations !== current.agent.max_iterations ||
                        !Array.isArray(messages) || messages.length !== previous.length + calls.length) return [];
                    if (JSON.stringify(messages.slice(0, previous.length)) !== JSON.stringify(previous)) return [];
                    const outputs = messages.slice(previous.length);
                    if (outputs.some((item) => item.role !== "tool" || !ids.has(item.tool_call_id)) ||
                        new Set(outputs.map((item) => item.tool_call_id)).size !== ids.size) return [];
                    return [{ record, outputs }];
                });
                if (candidates.length !== 1) {
                    run.status = "incomplete";
                    break;
                }
                turn.observations = candidates[0].outputs.map((item) => ({ call_id: item.tool_call_id, content: item.content }));
                current = candidates[0].record;
            }
            results.push(run);
        }
        return results;
    }

    window.slateAtif = { makeRun, makeTurn, build, recoveredRuns };
})();
