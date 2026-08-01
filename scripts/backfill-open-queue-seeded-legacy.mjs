#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = { file: null, dryRun: false, schemaVersion: 2 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--schema-version") args.schemaVersion = Number(argv[++i]);
  }
  if (!args.file) {
    console.error("Usage: node scripts/backfill-open-queue-seeded-legacy.mjs --file cooperation/logs/events-YYYY-MM-DD.jsonl [--schema-version 2] [--dry-run]");
    process.exit(1);
  }
  if (!Number.isInteger(args.schemaVersion) || args.schemaVersion < 1) {
    console.error("--schema-version must be a positive integer");
    process.exit(1);
  }
  return args;
}

const { file, dryRun, schemaVersion } = parseArgs(process.argv);
const abs = path.resolve(process.cwd(), file);
const raw = await fs.readFile(abs, "utf8");
const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

let openQueueSeededEvents = 0;
let patchedEventId = 0;
let patchedSchemaVersion = 0;
let normalizedEventAlias = 0;

const out = lines.map((line) => {
  const event = JSON.parse(line);
  const eventType = event.event_type ?? event.event;

  if (eventType === "open_queue_seeded") {
    openQueueSeededEvents += 1;

    if (!event.event_id) {
      event.event_id = `backfill_${randomUUID()}`;
      patchedEventId += 1;
    }

    if (!Number.isInteger(event.schema_version)) {
      event.schema_version = schemaVersion;
      patchedSchemaVersion += 1;
    }

    if (event.event !== "open_queue_seeded") {
      event.event = "open_queue_seeded";
      normalizedEventAlias += 1;
    }
  }

  return JSON.stringify(event);
});

if (!dryRun && (patchedEventId > 0 || patchedSchemaVersion > 0 || normalizedEventAlias > 0)) {
  await fs.writeFile(abs, `${out.join("\n")}\n`, "utf8");
}

console.log(JSON.stringify({
  file,
  total_lines: lines.length,
  open_queue_seeded_events: openQueueSeededEvents,
  patched_event_id: patchedEventId,
  patched_schema_version: patchedSchemaVersion,
  normalized_event_alias: normalizedEventAlias,
  schema_version_written: schemaVersion,
  dry_run: dryRun,
}, null, 2));
