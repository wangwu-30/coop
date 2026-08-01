import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCoopDir, loadConfig } from "../config.js";
import { appendEventLog, trustPolicyErrorToResult } from "../storage/events.js";
import { gitAddAndCommit } from "../storage/git.js";
import { normalizeAndValidateEvent } from "../schema/events.js";

export interface EmitChatInput {
  topic: string;
  actor: string;
  event: string;
  payload?: Record<string, unknown>;
  task_id?: string;
  message_id?: string;
}

export interface IngestChatDecisionInput {
  actor: string;
  decision: string;
  source: string;
  task_id?: string;
  message_id?: string;
  metadata?: Record<string, unknown>;
}

export async function emitChat(input: EmitChatInput, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  const config = await loadConfig(dir);
  if (!config.chatBridge.enabled) {
    return JSON.stringify({ emitted: false, reason: "chat_bridge_disabled" });
  }

  const outboxEvent = normalizeAndValidateEvent({
    event_type: input.event,
    actor: input.actor,
    task_id: input.task_id,
    message_id: input.message_id,
    payload: {
      topic: input.topic,
      ...(input.payload ?? {}),
    },
  });

  const date = outboxEvent.ts.slice(0, 10);
  const outboxDir = config.chatBridge.outboxDir ?? "chat/outbox";
  const relativePath = path.join(outboxDir, `events-${date}.jsonl`);
  const fullPath = path.join(dir, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.appendFile(fullPath, `${JSON.stringify(outboxEvent)}\n`, "utf-8");

  return JSON.stringify({ emitted: true, adapter: config.chatBridge.adapter ?? "file", path: relativePath });
}

export async function ingestChatDecision(input: IngestChatDecisionInput, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  let eventLogPath: string;
  try {
    eventLogPath = await appendEventLog(
      {
        event_type: "ingest_chat_decision",
        actor: input.actor,
        task_id: input.task_id,
        message_id: input.message_id,
        payload: {
          source: input.source,
          decision: input.decision,
          metadata: input.metadata ?? {},
        },
      },
      dir,
    );
  } catch (error) {
    const policyError = trustPolicyErrorToResult(error);
    if (policyError) return policyError;
    throw error;
  }

  try {
    await gitAddAndCommit(
      [eventLogPath],
      `coop: ingest chat decision from ${input.source}`,
      dir,
    );
  } catch {}

  return JSON.stringify({
    ingested: true,
    persisted_event_log: eventLogPath,
    note: "Chat decisions are append-only in Git event log.",
  });
}
