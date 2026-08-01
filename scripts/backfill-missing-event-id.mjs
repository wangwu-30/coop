#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = { file: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") args.file = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
  }
  if (!args.file) {
    console.error("Usage: node scripts/backfill-missing-event-id.mjs --file cooperation/logs/events-YYYY-MM-DD.jsonl [--dry-run]");
    process.exit(1);
  }
  return args;
}

const { file, dryRun } = parseArgs(process.argv);
const abs = path.resolve(process.cwd(), file);
const raw = await fs.readFile(abs, "utf8");
const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

let totalMissing = 0;
let postTaskMissing = 0;
let patched = 0;
const out = [];

for (const line of lines) {
  const event = JSON.parse(line);
  const eventType = event.event_type ?? event.event;
  if (!event.event_id) {
    totalMissing += 1;
    if (eventType === "post_task") {
      postTaskMissing += 1;
      event.event_id = `backfill_${randomUUID()}`;
      patched += 1;
    }
  }
  out.push(JSON.stringify(event));
}

if (!dryRun && patched > 0) {
  await fs.writeFile(abs, `${out.join("\n")}\n`, "utf8");
}

console.log(JSON.stringify({
  file,
  total_lines: lines.length,
  total_missing_event_id: totalMissing,
  post_task_missing_event_id: postTaskMissing,
  patched_post_task_event_id: patched,
  dry_run: dryRun,
}, null, 2));
