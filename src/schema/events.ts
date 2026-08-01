import { randomUUID } from "node:crypto";
import { z } from "zod";

export const EVENT_SCHEMA_VERSION = 2;
const ACTOR_SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const MAX_FUTURE_SKEW_MS = 30 * 1000;
let lastEmittedTsMs = Number.NEGATIVE_INFINITY;

const ActorSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^[-_]+|[-_]+$/g, ""))
  .pipe(z.string().min(1).regex(ACTOR_SLUG_PATTERN, "actor must be a lowercase slug"));

export const CoopEventSchema = z.object({
  ts: z.string().datetime(),
  event_id: z.string().min(1),
  trace_id: z.string().min(1).optional(),
  event_type: z.string().min(1),
  // Backward-read compatibility for legacy logs that used `event`.
  event: z.string().min(1).optional(),
  actor: ActorSchema,
  schema_version: z.number().int().positive(),
  // Backward-read compatibility only. New writers should use schema_version.
  version: z.number().int().positive().optional(),
  payload: z.record(z.unknown()),
  task_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
});

export type CoopEvent = z.infer<typeof CoopEventSchema>;

export type CoopEventInput = Omit<CoopEvent, "ts" | "event_id" | "schema_version" | "actor"> & {
  ts?: string;
  event_id?: string;
  trace_id?: string;
  actor: string;
  schema_version?: number;
  version?: number;
  // Legacy alias accepted on input.
  event?: string;
};

function normalizeEventTimestamp(ts?: string): string {
  const nowMs = Date.now();
  let candidateMs = typeof ts === "string" ? Date.parse(ts) : nowMs;

  if (!Number.isFinite(candidateMs)) candidateMs = nowMs;
  if (candidateMs > nowMs + MAX_FUTURE_SKEW_MS) candidateMs = nowMs;

  // If a previous emit somehow landed far in the future (clock jump/manual override),
  // reset the in-memory floor to avoid propagating future timestamps forever.
  if (lastEmittedTsMs > nowMs + MAX_FUTURE_SKEW_MS) {
    lastEmittedTsMs = nowMs;
  }

  // Keep per-process event timestamp monotonic to avoid large backward jumps
  // from concurrent producers / clock jitter.
  if (candidateMs <= lastEmittedTsMs) {
    candidateMs = lastEmittedTsMs + 1;
  }

  lastEmittedTsMs = candidateMs;
  return new Date(candidateMs).toISOString();
}

export function normalizeAndValidateEvent(event: CoopEventInput): CoopEvent {
  const effectiveEventType = event.event_type ?? event.event;

  const normalized = {
    ts: normalizeEventTimestamp(event.ts),
    event_id: event.event_id ?? randomUUID(),
    trace_id: event.trace_id,
    event_type: effectiveEventType,
    // Dual-write compatibility field for legacy readers.
    event: effectiveEventType,
    actor: event.actor,
    schema_version: event.schema_version ?? EVENT_SCHEMA_VERSION,
    version: event.version,
    payload: event.payload,
    task_id: event.task_id,
    message_id: event.message_id,
  };

  return CoopEventSchema.parse(normalized);
}
