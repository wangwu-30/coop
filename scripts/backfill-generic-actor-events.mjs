#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizeEventActor } from './actor-guard.mjs';

function parseArgs(argv) {
  const args = {
    events: 'cooperation/logs/events-2026-03-11.jsonl',
    hours: 12,
    apply: false,
    out: 'cooperation/reports/generic-actor-backfill-latest.json'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--events') args.events = argv[++i];
    else if (token === '--hours') args.hours = Number(argv[++i]);
    else if (token === '--apply') args.apply = true;
    else if (token === '--out') args.out = argv[++i];
  }
  return args;
}

function parseTs(value) {
  if (typeof value !== 'string') return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

async function run({ events, hours = 12, apply = false, out }) {
  const eventsPath = path.resolve(process.cwd(), events);
  const reportPath = path.resolve(process.cwd(), out);
  const raw = await readFile(eventsPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);

  const now = Date.now();
  const floor = now - hours * 60 * 60 * 1000;

  let inspected = 0;
  let touched = 0;
  const samples = [];

  const rewritten = lines.map((line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return line;
    }
    const ts = parseTs(event.ts);
    if (!ts || ts < floor) return event;
    if (event?.actor !== 'coop-worker') return event;

    inspected += 1;
    const guard = normalizeEventActor(event);
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const next = {
      ...event,
      payload: {
        ...payload,
        actor_raw: event.actor,
        actor_normalized: guard.actor,
        actor_normalization_reason: guard.reason,
        actor_guard_action: guard.guard_action
      }
    };

    touched += 1;
    if (samples.length < 20) {
      samples.push({
        ts: event.ts,
        event_type: event.event_type,
        task_id: event.task_id,
        actor_raw: event.actor,
        actor_normalized: guard.actor,
        reason: guard.reason
      });
    }

    return next;
  });

  if (apply && touched > 0) {
    await writeFile(eventsPath, `${rewritten.map((x) => JSON.stringify(x)).join('\n')}\n`, 'utf8');
  }

  const report = {
    generated_at: new Date().toISOString(),
    events_file: path.relative(process.cwd(), eventsPath),
    window_hours: hours,
    apply,
    inspected_generic_events: inspected,
    backfilled_events: touched,
    sample: samples
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  run(args)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

export { run };
