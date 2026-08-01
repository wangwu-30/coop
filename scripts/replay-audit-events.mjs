#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeEventRecord } from "./lib/event-compat.mjs";

const DEFAULT_RUNTIME_BASELINE_FILE = "cooperation/runtime/audit-baseline.json";

const KNOWN_EVENT_TYPES = new Set([
  "post_task",
  "claim_task",
  "update_task",
  "done_task",
  "milestone",
  "send_message",
  "message_read",
  "message_ack",
  "message_reject",
  "configure_memory",
  "ingest_chat_decision",
  "flywheel_audit",
  "task_initialized",
  "task_timeout_downgrade",
  "open_queue_seeded",
]);

function parseArgs(argv) {
  const args = {
    mode: "replay",
    file: undefined,
    json: true,
    baselineTs: undefined,
    baselineLine: undefined,
    baselineSchemaVersion: undefined,
    baselineFile: DEFAULT_RUNTIME_BASELINE_FILE,
    now: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mode") args.mode = argv[++i];
    else if (token === "--file") args.file = argv[++i];
    else if (token === "--no-json") args.json = false;
    else if (token === "--baseline-ts") args.baselineTs = argv[++i];
    else if (token === "--baseline-line") args.baselineLine = Number(argv[++i]);
    else if (token === "--baseline-schema-version") args.baselineSchemaVersion = Number(argv[++i]);
    else if (token === "--baseline-file") args.baselineFile = argv[++i];
    else if (token === "--now") args.now = argv[++i];
    else if (token === "--no-baseline-file") args.baselineFile = undefined;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

const ACTOR_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function todayDateKey(now = new Date()) {
  // Event filenames are derived from ISO timestamps, so the cutover is UTC.
  // Using host local time made midnight bootstrap fail in western timezones.
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function ensureTodayEventsFileBootstrap(filePath, nowMs = Date.now()) {
  const baseName = path.basename(filePath);
  const match = baseName.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!match) return;
  if (match[1] !== todayDateKey(new Date(nowMs))) return;

  try {
    await access(filePath);
  } catch {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "", "utf8");
  }
}

function effectiveTaskVersion(event) {
  if (typeof event?.payload?.current_version === "number") return event.payload.current_version;
  if (typeof event?.payload?.version === "number") return event.payload.version;
  if (event.event_type === "post_task") return 1;
  if (typeof event.schema_version === "number") return event.schema_version;
  if (typeof event.version === "number") return event.version;
  return null;
}

function effectiveSchemaVersion(event) {
  if (typeof event?.schema_version === "number") return event.schema_version;
  if (typeof event?.version === "number") return event.version;
  return null;
}

function normalizeBaseline(rawBaseline) {
  const baseline = {};

  if (rawBaseline?.ts) {
    const parsed = Date.parse(rawBaseline.ts);
    if (Number.isNaN(parsed)) throw new Error(`Invalid baseline ts: ${rawBaseline.ts}`);
    baseline.ts = rawBaseline.ts;
    baseline.tsMs = parsed;
  }

  if (rawBaseline?.line !== undefined) {
    if (!Number.isInteger(rawBaseline.line) || rawBaseline.line < 1) {
      throw new Error(`Invalid baseline line: ${rawBaseline.line}. Must be an integer >= 1.`);
    }
    baseline.line = rawBaseline.line;
  }

  if (rawBaseline?.schemaVersion !== undefined) {
    if (!Number.isInteger(rawBaseline.schemaVersion) || rawBaseline.schemaVersion < 0) {
      throw new Error(`Invalid baseline schema version: ${rawBaseline.schemaVersion}. Must be an integer >= 0.`);
    }
    baseline.schema_version = rawBaseline.schemaVersion;
  }

  return baseline;
}

function hasExplicitBaseline(rawBaseline = {}) {
  return rawBaseline.ts !== undefined || rawBaseline.line !== undefined || rawBaseline.schemaVersion !== undefined;
}

function coerceRuntimeBaseline(raw = {}) {
  const source = raw?.baseline && typeof raw.baseline === "object" ? raw.baseline : raw;
  return {
    ts: source?.ts,
    line: source?.line,
    schemaVersion: source?.schemaVersion ?? source?.schema_version,
  };
}

async function loadRuntimeBaseline(runtimeBaselineFile) {
  if (!runtimeBaselineFile) return {};

  const baselinePath = path.resolve(process.cwd(), runtimeBaselineFile);
  try {
    const raw = await readFile(baselinePath, "utf8");
    return coerceRuntimeBaseline(JSON.parse(raw));
  } catch {
    return {};
  }
}

function isCurrentEvent(event, baseline) {
  if (!baseline || Object.keys(baseline).length === 0) return true;

  if (baseline.tsMs !== undefined) {
    const eventTsMs = Date.parse(event?.ts ?? "");
    if (Number.isNaN(eventTsMs) || eventTsMs < baseline.tsMs) return false;
  }

  if (baseline.line !== undefined) {
    const line = event?._line ?? event?._index + 1;
    if (typeof line !== "number" || line < baseline.line) return false;
  }

  if (baseline.schema_version !== undefined) {
    const eventSchemaVersion = effectiveSchemaVersion(event);
    if (typeof eventSchemaVersion !== "number" || eventSchemaVersion < baseline.schema_version) return false;
  }

  return true;
}


function sortEventsByTs(events) {
  return [...events].sort((a, b) => {
    const aTs = Date.parse(a?.ts ?? "");
    const bTs = Date.parse(b?.ts ?? "");
    const aMs = Number.isFinite(aTs) ? aTs : Number.POSITIVE_INFINITY;
    const bMs = Number.isFinite(bTs) ? bTs : Number.POSITIVE_INFINITY;
    if (aMs !== bMs) return aMs - bMs;
    return (a?._line ?? a?._index ?? 0) - (b?._line ?? b?._index ?? 0);
  });
}

function applyTimestampSanityGuard(
  events,
  {
    nowMs = Date.now(),
    futureWindowMs = 10 * 60 * 1000,
    maxBackwardSkewMs = 5 * 60 * 1000,
    sortBeforeCheck = false,
  } = {},
) {
  const accepted = [];
  const anomalies = [];
  let latestAcceptedTsMs = Number.NEGATIVE_INFINITY;
  const orderedEvents = sortBeforeCheck ? sortEventsByTs(events) : events;

  for (const event of orderedEvents) {
    const tsMs = Date.parse(event?.ts ?? "");
    if (!Number.isFinite(tsMs)) {
      anomalies.push({ type: "invalid_timestamp", event });
      continue;
    }

    if (tsMs > nowMs + futureWindowMs) {
      anomalies.push({ type: "future_timestamp", event, delta_ms: tsMs - nowMs });
      continue;
    }

    if (latestAcceptedTsMs !== Number.NEGATIVE_INFINITY && tsMs < latestAcceptedTsMs - maxBackwardSkewMs) {
      anomalies.push({
        type: "out_of_order_timestamp",
        event,
        previous_accepted_ts: new Date(latestAcceptedTsMs).toISOString(),
        max_backward_skew_ms: maxBackwardSkewMs,
      });
      continue;
    }

    accepted.push(event);
    if (tsMs > latestAcceptedTsMs) latestAcceptedTsMs = tsMs;
  }

  return {
    accepted,
    anomalies,
    summary: {
      checked_event_count: events.length,
      accepted_event_count: accepted.length,
      dropped_event_count: anomalies.length,
      invalid_timestamp_count: anomalies.filter((item) => item.type === "invalid_timestamp").length,
      future_timestamp_count: anomalies.filter((item) => item.type === "future_timestamp").length,
      out_of_order_timestamp_count: anomalies.filter((item) => item.type === "out_of_order_timestamp").length,
      strategy: sortBeforeCheck
        ? "sort_by_ts_then_drop_invalid_future_or_excessive_backward_skew"
        : "drop_invalid_future_or_out_of_order_ts_then_sort_by_ts",
      future_window_ms: futureWindowMs,
      max_backward_skew_ms: maxBackwardSkewMs,
      sort_before_check: sortBeforeCheck,
      now: new Date(nowMs).toISOString(),
    },
  };
}


async function countUnauthorizedAttempts(eventsFilePath) {
  const eventsFileName = path.basename(eventsFilePath);
  const match = eventsFileName.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!match) return 0;

  const unauthorizedPath = path.join(path.dirname(eventsFilePath), `unauthorized-attempts-${match[1]}.jsonl`);
  try {
    const raw = await readFile(unauthorizedPath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function replayEvents(events, baseline, timestampSanity) {
  const currentEvents = sortEventsByTs(events.filter((event) => isCurrentEvent(event, baseline)));
  const tasks = new Map();

  for (const event of currentEvents) {
    if (!event.task_id) continue;

    const existing = tasks.get(event.task_id) ?? {
      task_id: event.task_id,
      latest_status: null,
      latest_version: null,
      actors: new Set(),
      milestones: [],
      milestone_timeline: [],
    };

    existing.actors.add(event.actor);

    const status = typeof event?.payload?.status === "string"
      ? event.payload.status
      : event.event_type === "post_task"
        ? "open"
        : existing.latest_status;

    const version = effectiveTaskVersion(event);

    existing.latest_status = status;
    if (typeof version === "number") existing.latest_version = version;
    const milestoneEntry = {
      ts: event.ts,
      event_type: event.event_type,
      actor: event.actor,
      status,
      version,
      comment: typeof event?.payload?.comment === "string" ? event.payload.comment : undefined,
      milestone: typeof event?.payload?.milestone === "string" ? event.payload.milestone : undefined,
      line: event._line,
      event_id: event?.event_id,
    };

    existing.milestones.push(milestoneEntry);
    if (event.event_type === "milestone") {
      existing.milestone_timeline.push(milestoneEntry);
    }

    tasks.set(event.task_id, existing);
  }

  const summary = Array.from(tasks.values()).map((task) => ({
    task_id: task.task_id,
    latest_status: task.latest_status,
    latest_version: task.latest_version,
    actors: Array.from(task.actors),
    key_milestones: task.milestones,
    milestone_timeline: task.milestone_timeline,
  }));

  return {
    generated_at: new Date().toISOString(),
    baseline,
    task_scope: "current_only",
    tasks: summary,
    task_count: summary.length,
    event_count: currentEvents.length,
    total_event_count: events.length,
    timestamp_sanity: timestampSanity,
  };
}


function auditEvents(events, baseline, unauthorizedAttempts = 0, timestampSanity) {
  const issues = [];
  const taskVersionState = new Map();
  const seenEventIds = new Map();
  const taskChainState = new Map();

  const orderedEvents = sortEventsByTs(events);

  for (let index = 0; index < orderedEvents.length; index += 1) {
    const event = orderedEvents[index];
    const currentScope = isCurrentEvent(event, baseline) ? "current" : "legacy";
    const ref = {
      index,
      line: event?._line,
      ts: event?.ts,
      event_type: event?.event_type,
      task_id: event?.task_id,
      message_id: event?.message_id,
      event_id: event?.event_id,
      scope: currentScope,
    };

    for (const field of ["ts", "event_type", "actor", "payload"]) {
      if (event?.[field] === undefined || event?.[field] === null) {
        issues.push({ type: "missing_required_field", field, ...ref });
      }
    }

    if (event?.event_id === undefined || event?.event_id === null || String(event.event_id).trim() === "") {
      // flywheel_audit, task_initialized, done_task events are optional event_id (generated by automated systems)
      if (!["flywheel_audit", "task_initialized", "done_task"].includes(event?.event_type)) {
        issues.push({ type: "missing_required_field", field: "event_id", ...ref });
      }
    } else {
      const priorIndex = seenEventIds.get(event.event_id);
      if (priorIndex !== undefined) {
        issues.push({ type: "duplicate_event_id", first_index: priorIndex, duplicate_index: index, ...ref });
      } else {
        seenEventIds.set(event.event_id, index);
      }
    }

    if (typeof event?.actor === "string" && !ACTOR_SLUG_PATTERN.test(event.actor)) {
      issues.push({ type: "malformed_actor", actor: event.actor, ...ref });
    }

    if (!KNOWN_EVENT_TYPES.has(event?.event_type)) {
      issues.push({ type: "unknown_event_type", event_type: event?.event_type, ...ref });
    }

    if (event?.schema_version === undefined && event?.version === undefined) {
      issues.push({ type: "missing_required_field", field: "schema_version", ...ref });
    }

    if (["post_task", "claim_task", "update_task", "milestone"].includes(event?.event_type) && !event?.task_id) {
      issues.push({ type: "missing_required_field", field: "task_id", ...ref });
    }
    if (["send_message", "message_read", "message_ack", "message_reject"].includes(event?.event_type) && !event?.message_id) {
      issues.push({ type: "missing_required_field", field: "message_id", ...ref });
    }

    if (event?.task_id) {
      const chainState = taskChainState.get(event.task_id) ?? { hasClaimOrUpdate: false };
      const exemptionReason = typeof event?.payload?.exemption_reason === "string" ? event.payload.exemption_reason.trim() : "";
      const inferredChainFromOldStatus = event?.payload?.old_status === "in_progress";
      if (event?.event_type === "done_task" && !chainState.hasClaimOrUpdate && !exemptionReason && !inferredChainFromOldStatus) {
        issues.push({
          type: "done_without_claim_or_update_chain",
          message: "done_task 前缺少 claim/update 链路且未提供 exemption_reason",
          ...ref,
        });
      }

      if (event?.event_type === "claim_task" || event?.event_type === "update_task") {
        chainState.hasClaimOrUpdate = true;
      }
      taskChainState.set(event.task_id, chainState);

      const version = effectiveTaskVersion(event);
      if (typeof version === "number") {
        const prev = taskVersionState.get(event.task_id);
        if (typeof prev === "number" && version <= prev) {
          issues.push({
            type: "out_of_order_task_version",
            previous_version: prev,
            current_version: version,
            ...ref,
          });
        }
        taskVersionState.set(event.task_id, version);
      }
    }
  }

  const currentIssues = issues.filter((issue) => issue.scope === "current");
  const legacyIssues = issues.filter((issue) => issue.scope === "legacy");

  return {
    generated_at: new Date().toISOString(),
    baseline,
    pass_current: currentIssues.length === 0,
    issue_count: issues.length,
    current_issue_count: currentIssues.length,
    legacy_issue_count: legacyIssues.length,
    issues,
    current_issues: currentIssues,
    legacy_issues: legacyIssues,
    event_count: orderedEvents.length,
    unauthorized_attempts: unauthorizedAttempts,
    timestamp_sanity: timestampSanity,
  };
}

export async function loadEventsFromFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return { ...normalizeEventRecord(JSON.parse(line)), _index: index, _line: index + 1 };
      } catch (error) {
        return {
          ts: null,
          event_id: `invalid-json-${index}`,
          event_type: "invalid_json",
          actor: "unknown",
          payload: { line, parse_error: String(error) },
          schema_version: 0,
          _invalid: true,
          _index: index,
          _line: index + 1,
        };
      }
    });
}

export async function runReplayOrAudit({
  file,
  mode = "replay",
  baseline = {},
  runtimeBaselineFile = DEFAULT_RUNTIME_BASELINE_FILE,
  now = undefined,
}) {
  if (!file) throw new Error("Missing --file <path-to-events.jsonl>");

  const fullPath = path.resolve(process.cwd(), file);
  const nowMs = now ? Date.parse(now) : Date.now();
  if (!Number.isFinite(nowMs)) throw new Error(`Invalid now timestamp: ${now}`);
  await ensureTodayEventsFileBootstrap(fullPath, nowMs);
  const events = await loadEventsFromFile(fullPath);
  const timestampSanity = applyTimestampSanityGuard(events, { nowMs });
  const unauthorizedAttempts = await countUnauthorizedAttempts(fullPath);
  const runtimeBaseline = hasExplicitBaseline(baseline) ? {} : await loadRuntimeBaseline(runtimeBaselineFile);
  const explicitBaseline = Object.fromEntries(
    Object.entries(baseline ?? {}).filter(([, value]) => value !== undefined),
  );
  const normalizedBaseline = normalizeBaseline({ ...runtimeBaseline, ...explicitBaseline });

  if (mode === "replay") return replayEvents(timestampSanity.accepted, normalizedBaseline, timestampSanity.summary);
  if (mode === "audit") return auditEvents(timestampSanity.accepted, normalizedBaseline, unauthorizedAttempts, timestampSanity.summary);
  throw new Error(`Unsupported mode: ${mode}. Use replay or audit.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.file) {
    console.log(`Usage: node scripts/replay-audit-events.mjs --mode <replay|audit> --file <cooperation/logs/events-YYYY-MM-DD.jsonl> [--baseline-ts <iso>] [--baseline-line <n>] [--baseline-schema-version <n>] [--baseline-file cooperation/runtime/audit-baseline.json] [--now <iso>]\n`);
    process.exit(args.help ? 0 : 1);
  }

  const result = await runReplayOrAudit({
    file: args.file,
    mode: args.mode,
    baseline: {
      ts: args.baselineTs,
      line: args.baselineLine,
      schemaVersion: args.baselineSchemaVersion,
    },
    now: args.now,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
