import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCoopDir, loadTrustPolicy } from "../config.js";
import { type CoopEvent, type CoopEventInput, normalizeAndValidateEvent } from "../schema/events.js";

const HARD_ALLOWED_ACTORS = new Set([
  "coop-leader",
  "observer-pm",
  "coop-worker-1",
  "coop-worker-2",
  "coop-worker-3",
  "impl-agent",
  "subagent-impl",
  // Backward-compatible local/test actors
  "openclaw",
  "claude-code",
  "system",
]);

export class TrustPolicyError extends Error {
  code: "unauthorized_actor" | "disallowed_event_type";
  actor: string;
  event_type: string;
  policy_path: string;

  constructor(input: {
    code: "unauthorized_actor" | "disallowed_event_type";
    actor: string;
    event_type: string;
    policy_path: string;
    message: string;
  }) {
    super(input.message);
    this.name = "TrustPolicyError";
    this.code = input.code;
    this.actor = input.actor;
    this.event_type = input.event_type;
    this.policy_path = input.policy_path;
  }
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractSourceContext(event: CoopEvent): { source_module: string; caller: string } {
  const payload = event.payload ?? {};
  const source_module =
    readPayloadString(payload, "source_module") ??
    readPayloadString(payload, "module") ??
    readPayloadString(payload, "source") ??
    "unknown";
  const caller =
    readPayloadString(payload, "caller") ??
    readPayloadString(payload, "origin") ??
    readPayloadString(payload, "trigger") ??
    "unknown";

  return { source_module, caller };
}

async function summarizeUnauthorizedSourcesTopN(coopDir: string, date: string, topN = 3): Promise<string[]> {
  const fullPath = path.join(coopDir, "logs", `unauthorized-attempts-${date}.jsonl`);
  try {
    const raw = await fs.readFile(fullPath, "utf-8");
    const counts = new Map<string, number>();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { source_module?: string; caller?: string };
      const key = `${row.source_module ?? "unknown"}::${row.caller ?? "unknown"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([k, count]) => `${k} (${count})`);
  } catch {
    return [];
  }
}

async function appendUnauthorizedAttempt(event: CoopEvent, code: TrustPolicyError["code"], coopDir: string): Promise<void> {
  const date = event.ts.slice(0, 10);
  const relativePath = path.join("logs", `unauthorized-attempts-${date}.jsonl`);
  const fullPath = path.join(coopDir, relativePath);
  const { source_module, caller } = extractSourceContext(event);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(
    fullPath,
    `${JSON.stringify({
      ts: event.ts,
      event_id: event.event_id,
      actor: event.actor,
      event_type: event.event_type,
      code,
      source_module,
      caller,
    })}\n`,
    "utf-8",
  );
}

async function enforceTrustPolicy(event: CoopEvent, coopDir: string): Promise<void> {
  const policyPath = path.join(coopDir, "policy.yaml");
  const policy = await loadTrustPolicy(coopDir);

  const allowlist = policy?.allowlist_actors;

  // Preserve legacy open task publication, but protect state transitions with
  // a small built-in actor set when no explicit policy is installed.
  if (!policy) {
    if (event.event_type === "post_task") return;
    if (!HARD_ALLOWED_ACTORS.has(event.actor)) {
      const date = event.ts.slice(0, 10);
      await appendUnauthorizedAttempt(event, "unauthorized_actor", coopDir);
      const topSources = await summarizeUnauthorizedSourcesTopN(coopDir, date, 3);
      const sourceSummary = topSources.length > 0 ? ` top_sources=${topSources.join(", ")}` : "";
      throw new TrustPolicyError({
        code: "unauthorized_actor",
        actor: event.actor,
        event_type: event.event_type,
        policy_path: policyPath,
        message: `Actor ${event.actor} rejected by hard allowlist.${sourceSummary}`,
      });
    }
    return;
  }

  // If policy doesn't define actor allowlist, fall back to hard-coded safety set.
  if ((!allowlist || allowlist.length === 0) && !HARD_ALLOWED_ACTORS.has(event.actor)) {
    const date = event.ts.slice(0, 10);
    await appendUnauthorizedAttempt(event, "unauthorized_actor", coopDir);
    const topSources = await summarizeUnauthorizedSourcesTopN(coopDir, date, 3);
    const sourceSummary = topSources.length > 0 ? ` top_sources=${topSources.join(", ")}` : "";
    throw new TrustPolicyError({
      code: "unauthorized_actor",
      actor: event.actor,
      event_type: event.event_type,
      policy_path: policyPath,
      message: `Actor ${event.actor} rejected by hard allowlist.${sourceSummary}`,
    });
  }

  if (allowlist && !allowlist.includes(event.actor)) {
    await appendUnauthorizedAttempt(event, "unauthorized_actor", coopDir);
    throw new TrustPolicyError({
      code: "unauthorized_actor",
      actor: event.actor,
      event_type: event.event_type,
      policy_path: policyPath,
      message: `Actor ${event.actor} is not allowlisted by trust policy.`,
    });
  }

  if (policy?.allowed_event_types && !policy.allowed_event_types.includes(event.event_type.toLowerCase())) {
    await appendUnauthorizedAttempt(event, "disallowed_event_type", coopDir);
    throw new TrustPolicyError({
      code: "disallowed_event_type",
      actor: event.actor,
      event_type: event.event_type,
      policy_path: policyPath,
      message: `Event type ${event.event_type} is not allowed by trust policy.`,
    });
  }
}

export function trustPolicyErrorToResult(error: unknown): string | null {
  if (!(error instanceof TrustPolicyError)) return null;
  return JSON.stringify({
    error: error.code,
    actor: error.actor,
    event_type: error.event_type,
    policy_path: error.policy_path,
    message: error.message,
  });
}

export async function prepareEventLog(event: CoopEventInput, coopDir?: string): Promise<CoopEvent> {
  const dir = coopDir ?? getCoopDir();
  const normalized: CoopEvent = normalizeAndValidateEvent(event);
  await enforceTrustPolicy(normalized, dir);
  return normalized;
}

export async function appendPreparedEventLog(event: CoopEvent, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  const date = event.ts.slice(0, 10);
  const relativePath = path.join("logs", `events-${date}.jsonl`);
  const fullPath = path.join(dir, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, `${JSON.stringify(event)}\n`, "utf-8");
  return relativePath;
}

export async function appendEventLog(event: CoopEventInput, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  const normalized = await prepareEventLog(event, dir);
  return appendPreparedEventLog(normalized, dir);
}

export async function prepareEventLogBatch(events: CoopEventInput[], coopDir?: string): Promise<CoopEvent[]> {
  const dir = coopDir ?? getCoopDir();
  const prepared: CoopEvent[] = [];
  for (const event of events) prepared.push(await prepareEventLog(event, dir));
  return prepared;
}

export async function appendPreparedEventLogBatch(events: CoopEvent[], coopDir?: string): Promise<string[]> {
  if (events.length === 0) return [];

  const dir = coopDir ?? getCoopDir();
  const byDate = new Map<string, CoopEvent[]>();
  for (const event of events) {
    const date = event.ts.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push(event);
  }

  const writtenPaths: string[] = [];
  for (const [date, evts] of byDate) {
    const relativePath = path.join("logs", `events-${date}.jsonl`);
    const fullPath = path.join(dir, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const content = evts.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(fullPath, content, "utf-8");
    writtenPaths.push(relativePath);
  }
  return writtenPaths;
}

export async function appendEventLogBatch(events: CoopEventInput[], coopDir?: string): Promise<string[]> {
  const dir = coopDir ?? getCoopDir();
  const prepared = await prepareEventLogBatch(events, dir);
  return appendPreparedEventLogBatch(prepared, dir);
}
