#!/usr/bin/env node
/**
 * 自动修复 done_task 链路：当 done_task 前缺少 claim/update 链路时，自动补可审计豁免原因。
 *
 * 用法：
 *   node scripts/repair-done-chain.mjs --file cooperation/logs/events-YYYY-MM-DD.jsonl [--dry-run] [--strategy exemption|synthetic-update]
 *
 * 默认策略（exemption）：
 *   - 不改事件顺序，直接给 done_task.payload 写入 exemption_reason
 *
 * 兼容策略（synthetic-update）：
 *   - 在 done_task 前插入一条合成 update_task（历史兼容）
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

function parseArgs(argv) {
  const args = { file: '', dryRun: false, strategy: 'exemption' };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--file') args.file = argv[++i] || '';
    if (token === '--dry-run') args.dryRun = true;
    if (token === '--strategy') args.strategy = (argv[++i] || 'exemption').trim();
  }
  if (!['exemption', 'synthetic-update'].includes(args.strategy)) {
    throw new Error(`Unsupported --strategy: ${args.strategy}`);
  }
  return args;
}

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function hasChain(state, taskId) {
  const s = state.get(taskId);
  return !!(s && (s.hasClaim || s.hasUpdate));
}

function mkSyntheticUpdate(doneEvent) {
  const doneTs = Date.parse(doneEvent.ts || '') || Date.now();
  return {
    ts: new Date(doneTs - 1).toISOString(),
    event_type: 'update_task',
    actor: doneEvent.actor || 'coop-system',
    version: 1,
    event_id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    task_id: doneEvent.task_id,
    payload: {
      status: 'in_progress',
      old_status: 'in_progress',
      version: Number(doneEvent?.payload?.version || 1),
      current_version: Number(doneEvent?.payload?.current_version || 1),
      note: 'auto-repair: inject progress update before done_task',
      exemption_reason: 'auto_chain_repair'
    }
  };
}

function ensureExemption(doneEvent) {
  if (!doneEvent.payload || typeof doneEvent.payload !== 'object') doneEvent.payload = {};
  if (!doneEvent.payload.exemption_reason || String(doneEvent.payload.exemption_reason).trim() === '') {
    doneEvent.payload.exemption_reason = 'auto_done_without_chain_guard';
  }
  doneEvent.payload.chain_guard = 'auto_exemption_written';
  if (!doneEvent.payload.note) {
    doneEvent.payload.note = 'auto-guard: done_task had no claim/update chain, exemption attached for audit traceability';
  }
}

function main() {
  const { file, dryRun, strategy } = parseArgs(process.argv);
  if (!file) {
    console.error('Usage: node scripts/repair-done-chain.mjs --file cooperation/logs/events-YYYY-MM-DD.jsonl [--dry-run] [--strategy exemption|synthetic-update]');
    process.exit(1);
  }

  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split('\n').filter(Boolean);

  const taskState = new Map();
  const output = [];
  let repaired = 0;

  for (const line of lines) {
    const event = safeParse(line);
    if (!event) {
      output.push(line);
      continue;
    }

    const taskId = event.task_id;
    if (!taskState.has(taskId)) taskState.set(taskId, { hasClaim: false, hasUpdate: false });

    const noChainDone = event.event_type === 'done_task' && taskId && !hasChain(taskState, taskId);
    const inferredChain = event?.payload?.old_status === 'in_progress';
    const hasExemption = typeof event?.payload?.exemption_reason === 'string' && event.payload.exemption_reason.trim() !== '';

    if (noChainDone && !inferredChain && !hasExemption) {
      if (strategy === 'synthetic-update') {
        const synthetic = mkSyntheticUpdate(event);
        output.push(JSON.stringify(synthetic));
      } else {
        ensureExemption(event);
      }
      repaired += 1;
      taskState.set(taskId, { hasClaim: true, hasUpdate: true });
    }

    output.push(JSON.stringify(event));

    if (event.event_type === 'claim_task') {
      taskState.set(taskId, { ...(taskState.get(taskId) || {}), hasClaim: true });
    }
    if (event.event_type === 'update_task') {
      taskState.set(taskId, { ...(taskState.get(taskId) || {}), hasUpdate: true });
    }
    if (event.event_type === 'post_task') {
      taskState.set(taskId, { hasClaim: false, hasUpdate: false });
    }
  }

  if (dryRun) {
    console.log(JSON.stringify({ file: abs, repaired, dryRun: true, strategy }, null, 2));
    return;
  }

  const backup = `${abs}.bak-${Date.now()}`;
  fs.copyFileSync(abs, backup);
  fs.writeFileSync(abs, output.join('\n') + '\n', 'utf8');

  console.log(JSON.stringify({ file: abs, repaired, backup, strategy }, null, 2));
}

main();
