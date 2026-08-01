#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'cooperation', 'runtime');
const OUT_FILE = path.join(OUT_DIR, 'noop-update-precheck-latest.json');

function parseArgs(argv) {
  const out = {
    threshold: 0,
    recentLines: 400,
    json: false,
    forceAlert: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    if (a === '--force-alert') out.forceAlert = true;
    if (a === '--threshold' && argv[i + 1]) out.threshold = Number(argv[++i]);
    if (a === '--recent-lines' && argv[i + 1]) out.recentLines = Number(argv[++i]);
  }
  return out;
}

function runNoopRegressionProbe() {
  const cmd = 'npx vitest run test/coop.test.ts -t "skip no-op updates without bumping version or logging update_task"';
  try {
    const output = execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { passed: true, output: output.slice(-3000) };
  } catch (error) {
    const output = String(error.stdout || error.stderr || error.message || '');
    return { passed: false, output: output.slice(-3000) };
  }
}

function detectSuspiciousNoopSignals(recentLines) {
  const logDir = path.join(ROOT, 'cooperation', 'logs');
  const files = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()
    : [];

  if (files.length === 0) {
    return { sourceFile: null, scanned: 0, suspiciousNoopUpdates: 0 };
  }

  const latest = path.join(logDir, files[files.length - 1]);
  const lines = fs.readFileSync(latest, 'utf8').trim().split('\n').filter(Boolean);
  const windowLines = lines.slice(Math.max(0, lines.length - recentLines));

  let suspicious = 0;
  for (const line of windowLines) {
    try {
      const evt = JSON.parse(line);
      const eventType = evt?.event_type;
      const note = String(evt?.payload?.note || '');
      if (eventType === 'update_task' && /no-?op/i.test(note)) {
        suspicious += 1;
      }
    } catch {
      // ignore malformed line
    }
  }

  return {
    sourceFile: path.relative(ROOT, latest),
    scanned: windowLines.length,
    suspiciousNoopUpdates: suspicious,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const probe = runNoopRegressionProbe();
  const logCheck = detectSuspiciousNoopSignals(args.recentLines);
  const thresholdExceeded = logCheck.suspiciousNoopUpdates > args.threshold;
  const shouldAlert = args.forceAlert || !probe.passed || thresholdExceeded;

  const result = {
    ts: new Date().toISOString(),
    check: 'noop-update-precheck',
    probe,
    logCheck: {
      ...logCheck,
      threshold: args.threshold,
      thresholdExceeded,
    },
    status: shouldAlert ? 'alert' : 'ok',
    alertSample: shouldAlert
      ? `[ALERT][quality-precheck] no-op update regression risk detected: probe_passed=${probe.passed}, suspicious_noop_updates=${logCheck.suspiciousNoopUpdates}, threshold=${args.threshold}`
      : `[OK][quality-precheck] no-op update precheck passed: probe_passed=${probe.passed}, suspicious_noop_updates=${logCheck.suspiciousNoopUpdates}`,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(shouldAlert ? 2 : 0);
  }

  console.log('=== No-op Update Precheck ===');
  console.log(`status: ${result.status}`);
  console.log(`probe passed: ${probe.passed}`);
  console.log(`log suspicious no-op updates: ${logCheck.suspiciousNoopUpdates}/${args.threshold} (>${args.threshold} triggers alert)`);
  console.log(`runtime output: ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`sample: ${result.alertSample}`);

  process.exit(shouldAlert ? 2 : 0);
}

main();
