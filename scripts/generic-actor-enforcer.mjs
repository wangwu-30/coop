#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    events: null,
    out: "cooperation/reports/generic-actor-enforcement-latest.json",
    rewrite: false,
    failOnGeneric: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--events") args.events = argv[++i];
    else if (token === "--out") args.out = argv[++i];
    else if (token === "--rewrite") args.rewrite = true;
    else if (token === "--fail-on-generic") args.failOnGeneric = true;
    else if (token === "--help" || token === "-h") args.help = true;
  }

  return args;
}

function getLocalDateString(dateObj = new Date()) {
  const tzOffset = dateObj.getTimezoneOffset() * 60000;
  const localDate = new Date(dateObj.getTime() - tzOffset);
  return localDate.toISOString().split("T")[0];
}

function inferWorkerFromTaskId(taskId) {
  if (typeof taskId !== "string") return null;
  const match = taskId.match(/worker[-_]?([1-9]\d*)/i);
  if (!match) return null;
  return `coop-worker-${match[1]}`;
}

function normalizeActor(event) {
  const rawActor = typeof event?.actor === "string" ? event.actor.trim() : "";
  if (!rawActor) return "unknown";
  if (rawActor !== "coop-worker") return rawActor;

  const payloadAssignee = event?.payload?.assignee;
  if (typeof payloadAssignee === "string" && /^coop-worker-[1-9]\d*$/.test(payloadAssignee)) {
    return payloadAssignee;
  }

  const payloadWorkerId = event?.payload?.worker_id;
  if (typeof payloadWorkerId === "string" && /^coop-worker-[1-9]\d*$/.test(payloadWorkerId)) {
    return payloadWorkerId;
  }

  const inferred = inferWorkerFromTaskId(event?.task_id);
  if (inferred) return inferred;
  return "coop-worker-unknown";
}

function toJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

async function resolveEventsPath(input) {
  if (input) return path.resolve(process.cwd(), input);
  const today = getLocalDateString();
  return path.resolve(process.cwd(), `cooperation/logs/events-${today}.jsonl`);
}

async function run(args) {
  const eventsPath = await resolveEventsPath(args.events);
  const raw = await readFile(eventsPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);

  let genericBefore = 0;
  let genericAfter = 0;
  let rewritten = 0;

  const transformed = lines.map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return line;
    }

    const actorBefore = typeof event?.actor === "string" ? event.actor.trim() : "unknown";
    if (actorBefore === "coop-worker") genericBefore += 1;

    const actorAfter = normalizeActor(event);
    if (actorAfter === "coop-worker") genericAfter += 1;

    if (args.rewrite && actorAfter !== actorBefore) {
      event.actor = actorAfter;
      rewritten += 1;
      return event;
    }

    return event;
  });

  if (args.rewrite && rewritten > 0) {
    await writeFile(eventsPath, toJsonl(transformed), "utf8");
  }

  const report = {
    generated_at: new Date().toISOString(),
    events_file: path.relative(process.cwd(), eventsPath),
    rewrite_enabled: args.rewrite,
    metrics: {
      generic_actor_before: genericBefore,
      generic_actor_after: args.rewrite ? 0 : genericAfter,
      rewritten_events: rewritten,
    },
    passed: (args.rewrite ? 0 : genericAfter) === 0,
  };

  const outPath = path.resolve(process.cwd(), args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (args.failOnGeneric && report.metrics.generic_actor_after > 0) {
    throw new Error(`generic actor remains: ${report.metrics.generic_actor_after}`);
  }

  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/generic-actor-enforcer.mjs [--events cooperation/logs/events-YYYY-MM-DD.jsonl] [--out cooperation/reports/generic-actor-enforcement.json] [--rewrite] [--fail-on-generic]");
    process.exit(0);
  }

  const report = await run(args);
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { run, normalizeActor };
