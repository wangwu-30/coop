#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { normalizeEventRecord } from "./lib/event-compat.mjs";

function parseArgs(argv) {
  const args = {
    events: `cooperation/logs/events-${new Date().toISOString().slice(0, 10)}.jsonl`,
    out: "cooperation/runtime/event-ops-summary.json",
    windowMinutes: 120,
    workerThroughputMin: 2,
    actorSkewMaxShare: 0.6,
    now: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--events") args.events = argv[++i];
    else if (token === "--out") args.out = argv[++i];
    else if (token === "--window-minutes") args.windowMinutes = Number(argv[++i]);
    else if (token === "--worker-throughput-min") args.workerThroughputMin = Number(argv[++i]);
    else if (token === "--actor-skew-max-share") args.actorSkewMaxShare = Number(argv[++i]);
    else if (token === "--now") args.now = argv[++i];
    else if (token === "--help" || token === "-h") args.help = true;
  }

  return args;
}

async function readJsonFileOrNull(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function collectDispatchObservability() {
  const stateFile = path.resolve(process.cwd(), "cooperation/runtime/loop-run-once.state.json");
  const state = await readJsonFileOrNull(stateFile);
  if (!state) {
    return {
      available: false,
      reason: "loop_run_state_missing",
    };
  }

  const dispatchOutFile = state.dispatch_out_file ?? "cooperation/runtime/next-round.dispatch.json";
  const dispatchPath = path.resolve(process.cwd(), dispatchOutFile);
  const manifest = await readJsonFileOrNull(dispatchPath);

  const taskCount = Array.isArray(manifest?.tasks) ? manifest.tasks.length : null;
  return {
    available: true,
    source_files: {
      state: path.relative(process.cwd(), stateFile),
      dispatch: path.relative(process.cwd(), dispatchPath),
    },
    dispatch_task_count: taskCount,
    dispatch_decision_evidence: state.dispatch_decision_evidence ?? null,
    dispatch_reuse_evidence: state.dispatch_reuse_evidence ?? null,
  };
}

function readJsonl(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizeEventRecord(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isObserverActor(actor) {
  return ["observer-pm", "coop-leader"].includes(actor);
}

function inferWorkerFromTaskId(taskId) {
  if (typeof taskId !== "string") return null;
  const match = taskId.match(/worker[-_]?([1-9]\d*)/i);
  if (!match) return null;
  return `coop-worker-${match[1]}`;
}

function normalizeActor(event) {
  const rawActor = typeof event?.actor === "string" && event.actor.trim() ? event.actor.trim() : "unknown";
  if (rawActor !== "coop-worker") return rawActor;

  const payloadAssignee = event?.payload?.assignee;
  if (typeof payloadAssignee === "string" && /^coop-worker-[1-9]\d*$/.test(payloadAssignee)) {
    return payloadAssignee;
  }

  const payloadWorkerId = event?.payload?.worker_id;
  if (typeof payloadWorkerId === "string" && /^coop-worker-[1-9]\d*$/.test(payloadWorkerId)) {
    return payloadWorkerId;
  }

  return inferWorkerFromTaskId(event?.task_id) ?? rawActor;
}

function extractWorkerActors(counts) {
  return Object.keys(counts).filter((actor) => /^coop-worker-[1-9]\d*$/.test(actor));
}

function buildActorSkew(normalizedActorCounts, totalEvents, maxShareThreshold = 0.6) {
  const allWorkers = ["coop-worker-1", "coop-worker-2", "coop-worker-3"];
  const workerActorsSeen = extractWorkerActors(normalizedActorCounts);
  const workerCounts = Object.fromEntries(allWorkers.map((worker) => [worker, normalizedActorCounts[worker] ?? 0]));
  const workerTotal = Object.values(workerCounts).reduce((sum, count) => sum + count, 0);
  const workerShare = Object.fromEntries(
    Object.entries(workerCounts).map(([worker, count]) => [worker, workerTotal > 0 ? Number((count / workerTotal).toFixed(4)) : 0]),
  );
  const zeroContributionWorkers = Object.entries(workerCounts)
    .filter(([, count]) => count === 0)
    .map(([worker]) => worker);

  const dominantEntry = Object.entries(workerShare).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const [dominantWorker, maxWorkerShare] = dominantEntry;

  const triggerByZeroWorker = zeroContributionWorkers.length > 0;
  const triggerByDominance = maxWorkerShare > maxShareThreshold;

  const recommendedAssignments = [];
  if (triggerByZeroWorker) {
    for (const worker of zeroContributionWorkers) {
      recommendedAssignments.push({
        worker,
        action: "seed_or_reassign_open_task",
        reason: "worker_contribution_zero",
        min_tasks: 1,
      });
    }
  }
  if (triggerByDominance && dominantWorker) {
    recommendedAssignments.push({
      worker: dominantWorker,
      action: "reduce_new_assignment_share",
      reason: "dominance_above_threshold",
      max_share: maxShareThreshold,
    });
  }

  return {
    enabled: true,
    worker_scope: allWorkers,
    worker_scope_seen: workerActorsSeen,
    worker_event_counts: workerCounts,
    worker_contribution_share: workerShare,
    max_worker: dominantWorker,
    max_worker_share: maxWorkerShare,
    max_share_threshold: maxShareThreshold,
    zero_contribution_workers: zeroContributionWorkers,
    triggered: triggerByZeroWorker || triggerByDominance,
    trigger_reason: triggerByZeroWorker ? "worker_zero_contribution" : triggerByDominance ? "dominant_worker_share_exceeded" : "none",
    recommended_rebalance: recommendedAssignments,
    basis_total_events: totalEvents,
  };
}

function summarizeEvents(events, nowIso, windowMinutes, workerThroughputMin = 2, actorSkewMaxShare = 0.6) {
  const nowMs = new Date(nowIso).getTime();
  const windowStartMs = nowMs - windowMinutes * 60 * 1000;
  const datedEvents = events
    .map((event) => ({ event, tsMs: new Date(event.ts).getTime() }))
    .filter(({ tsMs }) => Number.isFinite(tsMs) && tsMs <= nowMs);

  const filtered = datedEvents
    .filter(({ tsMs }) => tsMs >= windowStartMs)
    .map(({ event }) => event);

  const counts = {
    post_task: 0,
    update_task: 0,
    claim_task: 0,
    done_task: 0,
  };

  const actorCounts = {};
  const normalizedActorCounts = {};
  const actorNormalizationPairs = {};

  for (const event of filtered) {
    if (event.event_type in counts) counts[event.event_type] += 1;
    if (event.event_type === "update_task" && event?.payload?.status === "done") {
      counts.done_task += 1;
    }

    const rawActor = typeof event.actor === "string" && event.actor.trim() ? event.actor.trim() : "unknown";
    const normalizedActor = normalizeActor(event);

    actorCounts[rawActor] = (actorCounts[rawActor] ?? 0) + 1;
    normalizedActorCounts[normalizedActor] = (normalizedActorCounts[normalizedActor] ?? 0) + 1;

    const pairKey = `${rawActor} -> ${normalizedActor}`;
    actorNormalizationPairs[pairKey] = (actorNormalizationPairs[pairKey] ?? 0) + 1;
  }

  const actors = Object.keys(normalizedActorCounts);
  const observerOnly = actors.length > 0 && actors.every((actor) => isObserverActor(actor));
  const workerSignal = counts.claim_task + counts.done_task;
  const actorContributionShare = Object.fromEntries(
    Object.entries(normalizedActorCounts).map(([actor, count]) => [actor, filtered.length > 0 ? Number((count / filtered.length).toFixed(4)) : 0]),
  );
  const rawActorContributionShare = Object.fromEntries(
    Object.entries(actorCounts).map(([actor, count]) => [actor, filtered.length > 0 ? Number((count / filtered.length).toFixed(4)) : 0]),
  );
  const actorSkew = buildActorSkew(normalizedActorCounts, filtered.length, actorSkewMaxShare);

  const hasDoneSignal = (event) => event.event_type === "done_task" || (event.event_type === "update_task" && event?.payload?.status === "done");
  const isChainEvent = (event) => event.event_type === "post_task" || event.event_type === "update_task";

  const signalTaskIds = new Set(
    filtered
      .filter((event) => (event.event_type === "claim_task" || hasDoneSignal(event)) && typeof event.task_id === "string")
      .map((event) => event.task_id),
  );

  const hasPayloadChainHint = (event) => {
    const oldStatus = event?.payload?.old_status;
    return typeof oldStatus === "string" && ["open", "in_progress", "done", "blocked"].includes(oldStatus);
  };

  let signalWithoutWindowChain = 0;
  let recoveredByHistory = 0;
  let recoveredByPayloadHint = 0;
  let unrecoveredMissingChain = 0;
  for (const taskId of signalTaskIds) {
    const hasWindowChain = filtered.some((event) => event.task_id === taskId && isChainEvent(event));
    if (hasWindowChain) continue;
    signalWithoutWindowChain += 1;

    const hasHistoricalChain = datedEvents.some(({ event, tsMs }) => tsMs < windowStartMs && event.task_id === taskId && isChainEvent(event));
    if (hasHistoricalChain) {
      recoveredByHistory += 1;
      continue;
    }

    const hasChainHintFromPayload = filtered.some((event) => event.task_id === taskId && hasPayloadChainHint(event));
    if (hasChainHintFromPayload) {
      recoveredByPayloadHint += 1;
      continue;
    }

    unrecoveredMissingChain += 1;
  }

  // Ratio calculation: account for recovered chains (history + payload hint) to reflect true visibility gaps
  const netUnrecovered = signalWithoutWindowChain - recoveredByHistory - recoveredByPayloadHint;
  const normalizedWithoutChainRatio = signalTaskIds.size > 0 ? Number((netUnrecovered / signalTaskIds.size).toFixed(4)) : 0;
  const blindSpotIsHigh = netUnrecovered >= 3 || normalizedWithoutChainRatio >= 0.6;

  const chainVisibility = {
    signal_task_count: signalTaskIds.size,
    signal_without_window_chain: signalWithoutWindowChain,
    signal_recovered_by_history: recoveredByHistory,
    signal_recovered_by_payload_hint: recoveredByPayloadHint,
    signal_unrecovered_missing_chain: unrecoveredMissingChain,
    signal_without_window_chain_ratio: normalizedWithoutChainRatio,
    high_blind_spot: blindSpotIsHigh,
    // Enhanced instrumentation for chain gap analysis
    chain_recovery_efficiency: signalTaskIds.size > 0
      ? Number(((recoveredByHistory + recoveredByPayloadHint) / signalTaskIds.size).toFixed(4))
      : 0,
    net_unrecovered_gaps: netUnrecovered,
    root_cause_breakdown: {
      normal_old_task_processing: recoveredByHistory + recoveredByPayloadHint,
      missing_events_or_instrumentation_gap: unrecoveredMissingChain,
    },
  };

  const risks = [];
  if (observerOnly) {
    risks.push({
      code: "observer_only_activity",
      level: "high",
      message: "窗口期内仅 observer/leader 侧活跃，worker 侧无可见执行信号。",
      suggested_actions: [
        "暂停新增派单，优先催办最老 open 任务",
        "对每个 worker 至少触发 1 条 claim 或 done 回执",
      ],
    });
  } else if (workerSignal < workerThroughputMin && filtered.length > 0) {
    risks.push({
      code: "worker_throughput_below_min",
      level: workerSignal === 0 ? "high" : "medium",
      message: `窗口期内 worker 吞吐信号不足：claim+done=${workerSignal}，低于阈值 ${workerThroughputMin}。`,
      evidence: {
        worker_throughput_signals: workerSignal,
        worker_throughput_min: workerThroughputMin,
      },
      suggested_actions: [
        "优先处理最老 open 任务并回填 claim/update/done 证据链",
        "若连续两窗口低于阈值，暂停新增派单并要求逐人回执",
      ],
    });
  }

  if (workerSignal > 0 && counts.post_task === 0 && counts.update_task === 0) {
    const chainRiskLevel = chainVisibility.high_blind_spot && chainVisibility.signal_unrecovered_missing_chain > 0 ? "high" : "medium";
    const chainMessage = chainVisibility.high_blind_spot
      ? `窗口期证据链盲区偏高：无窗口链路任务 ${chainVisibility.signal_without_window_chain}/${chainVisibility.signal_task_count}，其中不可恢复 ${chainVisibility.signal_unrecovered_missing_chain}。`
      : "窗口期出现 claim/done，但 post/update 为 0，存在证据链窗口盲区。";

    risks.push({
      code: "evidence_chain_window_blind_spot",
      level: chainRiskLevel,
      message: chainMessage,
      evidence: chainVisibility,
      suggested_actions: [
        "检查是否集中处理了窗口外创建的旧任务（可接受）",
        "对 signal_unrecovered_missing_chain>0 的任务补齐 task_id 维度埋点与链路追踪",
        "若 high_blind_spot 持续为 true，按 task_id 逐条回放并校验 post/update 缺失根因",
      ],
    });
  }


  if (actorSkew.triggered) {
    const zeroWorkers = actorSkew.zero_contribution_workers;
    risks.push({
      code: "actor_skew",
      level: zeroWorkers.length > 0 ? "high" : "medium",
      message:
        zeroWorkers.length > 0
          ? `检测到 worker 贡献偏斜：${zeroWorkers.join(", ")} 贡献为0，且最大贡献占比为 ${actorSkew.max_worker_share}。`
          : `检测到 worker 贡献偏斜：最大贡献占比 ${actorSkew.max_worker_share} 超过阈值 ${actorSkew.max_share_threshold}。`,
      evidence: actorSkew,
      suggested_actions: [
        "将下一批 open 任务优先分配给零贡献 worker，每个至少 1 条",
        "对最大贡献 worker 降低新增派发占比，直到回落至阈值以下",
      ],
    });
  }

  return {
    schema: "agent-coop.event-ops-summary.v1",
    generated_at: nowIso,
    window: {
      minutes: windowMinutes,
      start: new Date(windowStartMs).toISOString(),
      end: nowIso,
    },
    summary: {
      total_events: filtered.length,
      event_type_counts: counts,
      actor_counts_raw: actorCounts,
      actor_counts_normalized: normalizedActorCounts,
      actor_normalization_pairs: actorNormalizationPairs,
      actor_contribution_share_raw: rawActorContributionShare,
      actor_contribution_share: actorContributionShare,
      actor_skew: actorSkew,
      actor_normalization_impact: {
        merged_actor_count_delta: Object.keys(actorCounts).length - Object.keys(normalizedActorCounts).length,
        had_generic_actor: (actorCounts["coop-worker"] ?? 0) > 0,
        generic_actor_events: actorCounts["coop-worker"] ?? 0,
        threshold_risk: (actorCounts["coop-worker"] ?? 0) > 0 ? "medium" : "low",
        assessment: (actorCounts["coop-worker"] ?? 0) > 0
          ? "存在 generic actor，被归一化后贡献度将回流到具体 worker；吞吐阈值不受影响，但按 worker 的贡献份额会发生变化。"
          : "未发现 generic actor，历史阈值口径基本不受影响。",
      },
      observer_only_active: observerOnly,
      worker_throughput_signals: workerSignal,
      worker_throughput_min: workerThroughputMin,
      chain_visibility: chainVisibility,
    },
    risks,
  };
}

function getLocalDateString(dateObj = new Date()) {
  // Get local date string in YYYY-MM-DD format
  const tzOffset = dateObj.getTimezoneOffset() * 60000;
  const localDate = new Date(dateObj.getTime() - tzOffset);
  return localDate.toISOString().split('T')[0];
}

async function findEventsFile() {
  const today = getLocalDateString();
  const yesterday = getLocalDateString(new Date(Date.now() - 86400000));

  const todayPath = path.resolve(process.cwd(), `cooperation/logs/events-${today}.jsonl`);
  const yesterdayPath = path.resolve(process.cwd(), `cooperation/logs/events-${yesterday}.jsonl`);

  try {
    await readFile(todayPath, "utf8");
    return { path: todayPath, date: today };
  } catch {
    // Today's file doesn't exist, try yesterday
    try {
      await readFile(yesterdayPath, "utf8");
      return { path: yesterdayPath, date: yesterday };
    } catch {
      throw new Error(`No events file found for today (${today}) or yesterday (${yesterday})`);
    }
  }
}

async function run({ events, out, windowMinutes, workerThroughputMin, actorSkewMaxShare, now }) {
  // Auto-detect events file: try today first, then yesterday
  let eventsPath, eventsDate;
  if (events.includes("events-YYYY-MM-DD") || !events) {
    const result = await findEventsFile();
    eventsPath = result.path;
    eventsDate = result.date;
    console.log(`Using events file: ${eventsPath} (date: ${eventsDate})`);
  } else {
    eventsPath = path.resolve(process.cwd(), events);
    // Extract date from filename
    const match = eventsPath.match(/events-(\d{4}-\d{2}-\d{2})\.jsonl/);
    eventsDate = match ? match[1] : new Date().toISOString().slice(0, 10);
  }

  const raw = await readFile(eventsPath, "utf8");
  const parsed = readJsonl(raw);

  // Calculate time window based on the events file date
  // Use end of the events file date (23:59:59 local) as the reference point
  let nowIso;
  if (now) {
    nowIso = now;
  } else if (eventsDate === getLocalDateString()) {
    // Today's events file - use current time
    nowIso = new Date().toISOString();
  } else {
    // Historical events file - use end of that day (23:59:59 local)
    nowIso = `${eventsDate}T23:59:59+08:00`;
  }

  const report = summarizeEvents(parsed, nowIso, windowMinutes, workerThroughputMin, actorSkewMaxShare);
  report.dispatch_observability = await collectDispatchObservability();

  const outPath = path.resolve(process.cwd(), out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/event-audit-ops-summary.mjs [--events cooperation/logs/events-YYYY-MM-DD.jsonl] [--out cooperation/runtime/event-ops-summary.json] [--window-minutes 120] [--worker-throughput-min 2] [--actor-skew-max-share 0.6] [--now 2026-03-08T10:00:00Z]");
    console.log("\nworker-throughput-min: 窗口内 claim_task + done_task 的最低期望值，建议默认 2。");
    console.log("actor-skew-max-share: worker 最大贡献占比阈值，超过则触发偏斜告警，默认 0.6。\n");
    process.exit(0);
  }

  if (!Number.isFinite(args.windowMinutes) || args.windowMinutes <= 0) {
    throw new Error(`Invalid --window-minutes: ${args.windowMinutes}`);
  }
  if (!Number.isFinite(args.workerThroughputMin) || args.workerThroughputMin < 0) {
    throw new Error(`Invalid --worker-throughput-min: ${args.workerThroughputMin}`);
  }
  if (!Number.isFinite(args.actorSkewMaxShare) || args.actorSkewMaxShare <= 0 || args.actorSkewMaxShare > 1) {
    throw new Error(`Invalid --actor-skew-max-share: ${args.actorSkewMaxShare}`);
  }

  const result = await run(args);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { run, summarizeEvents };
