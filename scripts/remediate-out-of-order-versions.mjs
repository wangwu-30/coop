#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

function usage() {
  console.log('Usage: node scripts/remediate-out-of-order-versions.mjs --file cooperation/logs/events-YYYY-MM-DD.jsonl [--write]');
}

function parseArgs(argv) {
  const args = { file: '', write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file') args.file = argv[++i] || '';
    else if (token === '--write') args.write = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function readEvents(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((line, idx) => ({ line, idx, event: JSON.parse(line) }));
}

function getVersion(event) {
  const v = event?.payload?.current_version ?? event?.payload?.version;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function coercePayloadVersionToNumber(event) {
  if (!event?.payload || typeof event.payload !== 'object') return false;
  let changed = false;
  for (const key of ['current_version', 'version']) {
    const raw = event.payload[key];
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        event.payload[key] = parsed;
        changed = true;
      }
    }
  }
  return changed;
}

function setVersion(event, version) {
  if (!event.payload || typeof event.payload !== 'object') event.payload = {};
  const oldVersion = event.payload.current_version ?? event.payload.version ?? null;
  event.payload.original_version = oldVersion;
  event.payload.version = version;
  event.payload.current_version = version;
}

function remediate(records) {
  const state = new Map();
  const fixes = [];

  for (const rec of records) {
    const event = rec.event;
    if (!event?.task_id) continue;

    const coerced = coercePayloadVersionToNumber(event);
    if (coerced) {
      fixes.push({ line: rec.idx + 1, task_id: event.task_id, from: 'string', to: 'number', event_type: event.event_type, fix: 'coerce_version_type' });
    }

    const ver = getVersion(event);
    if (ver === null) continue;
    const prev = state.get(event.task_id);
    if (typeof prev === 'number' && ver <= prev) {
      const next = prev + 1;
      setVersion(event, next);
      fixes.push({ line: rec.idx + 1, task_id: event.task_id, from: ver, to: next, event_type: event.event_type, fix: 'bump_out_of_order' });
      state.set(event.task_id, next);
    } else {
      state.set(event.task_id, ver);
    }
  }

  return fixes;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const file = path.resolve(process.cwd(), args.file);
  const records = readEvents(file);
  const fixes = remediate(records);

  const output = {
    file: args.file,
    total_events: records.length,
    fixed_count: fixes.length,
    fixes,
    mode: args.write ? 'write' : 'dry-run',
  };

  if (args.write && fixes.length > 0) {
    const content = records.map((r) => JSON.stringify(r.event)).join('\n') + '\n';
    fs.writeFileSync(file, content, 'utf8');
  }

  console.log(JSON.stringify(output, null, 2));
}

main();
