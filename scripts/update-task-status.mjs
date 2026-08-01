#!/usr/bin/env node
/**
 * 任务状态更新脚本
 * 更新任务状态并自动记录事件日志（仅 frontmatter 生效，原子写入）
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { normalizeActorWithReason } from './actor-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, '..', 'cooperation', 'tasks');
const LOG_DIR = path.join(__dirname, '..', 'cooperation', 'logs');
const VALID_STATUSES = ['open', 'in_progress', 'done', 'blocked', 'cancelled'];
const ACTOR = process.env.COOP_ACTOR || 'coop-worker-1';
const RUNTIME_DIR = path.join(__dirname, '..', 'cooperation', 'runtime');

function splitTask(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error('Invalid task file: missing frontmatter');
  return { fmRaw: m[1], body: content.slice(m[0].length) };
}

function parseFrontmatterLines(fmRaw) {
  const lines = fmRaw.split('\n');
  const data = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^['\"]|['\"]$/g, '');
    data[key] = value;
  }
  return { lines, data };
}

function upsertLine(lines, key, value) {
  const target = `${key}: ${value}`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}:`)) {
      found = true;
      return target;
    }
    return line;
  });
  if (!found) next.unshift(target);
  return next;
}

function removeBodyStatusLines(body) {
  return body
    .split('\n')
    .filter((line) => !/^status:\s*(open|in_progress|done|blocked|cancelled)\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function appendActorNormalizationLog(entry) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const logFile = path.join(RUNTIME_DIR, 'actor-normalization.log.jsonl');
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function normalizeActor(rawActor, assignee, taskId) {
  const result = normalizeActorWithReason({ rawActor, assignee, taskId, fallback: 'coop-worker-1' });
  if (result.reason !== 'whitelist_pass') {
    appendActorNormalizationLog({
      ts: new Date().toISOString(),
      task_id: taskId,
      raw_actor: result.raw_actor,
      assignee: typeof assignee === 'string' ? assignee : null,
      normalized_actor: result.actor,
      reason: result.reason,
      guard_action: result.guard_action
    });
  }
  return result;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function buildEvent({ timestamp, eventType, actor, actorRaw, actorReason, actorGuardAction, taskId, status, oldStatus, version, note, reason, source }) {
  const payload = {
    status,
    old_status: oldStatus,
    version,
    current_version: version,
    note,
    actor_raw: actorRaw,
    actor_normalized: actor,
    actor_normalization_reason: actorReason,
    actor_guard_action: actorGuardAction
  };
  if (reason) payload.reason = reason;

  const event = {
    ts: timestamp,
    event_type: eventType,
    actor,
    version: 1,
    event_id: `evt_${crypto.randomBytes(8).toString('hex')}`,
    task_id: `cooperation/tasks/${taskId}.md`,
    payload
  };
  if (source) event.source = source;
  return event;
}

function hasClaimTaskEvent(taskPath) {
  if (!fs.existsSync(LOG_DIR)) return false;
  const files = fs.readdirSync(LOG_DIR).filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, file), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.task_id === taskPath && event?.event_type === 'claim_task') return true;
      } catch {
        // ignore malformed lines
      }
    }
  }
  return false;
}

function updateTaskStatus(taskId, newStatus) {
  const taskFile = path.join(TASKS_DIR, `${taskId}.md`);
  if (!fs.existsSync(taskFile)) {
    console.error(`Task not found: ${taskId}`);
    process.exit(1);
  }

  const content = fs.readFileSync(taskFile, 'utf-8');
  const { fmRaw, body } = splitTask(content);
  const { lines, data } = parseFrontmatterLines(fmRaw);

  const oldStatus = data.status || 'unknown';
  const oldVersion = Number.parseInt(String(data.version || '1'), 10) || 1;
  const timestamp = new Date().toISOString();

  const actorGuard = normalizeActor(ACTOR, data.assignee, taskId);

  const transitions = [];
  if (oldStatus === 'open' && newStatus === 'done') {
    transitions.push({ eventType: 'claim_task', status: 'in_progress', oldStatus: 'open', note: '领取open任务开始执行（自动补链）' });
    transitions.push({ eventType: 'update_task', status: 'in_progress', oldStatus: 'in_progress', note: '进度更新（自动补链）' });
    transitions.push({ eventType: 'done_task', status: 'done', oldStatus: 'in_progress', note: '完成任务' });
  } else if (oldStatus === 'open' && newStatus === 'in_progress') {
    transitions.push({ eventType: 'claim_task', status: 'in_progress', oldStatus: 'open', note: '领取open任务开始执行' });
  } else {
    const eventType = newStatus === 'done' ? 'done_task' : 'update_task';
    const note = newStatus === 'done' ? '完成任务' : '更新任务状态';
    transitions.push({ eventType, status: newStatus, oldStatus, note });
  }

  const finalVersion = oldVersion + transitions.length;
  let fmLines = lines;
  fmLines = upsertLine(fmLines, 'status', newStatus);
  fmLines = upsertLine(fmLines, 'version', String(finalVersion));
  fmLines = upsertLine(fmLines, 'updated', '"' + timestamp + '"');

  const cleanedBody = removeBodyStatusLines(body);
  const newContent = `---\n${fmLines.join('\n')}\n---\n\n${cleanedBody.trimStart()}`;
  atomicWrite(taskFile, newContent);

  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0];
  const logFile = path.join(LOG_DIR, `events-${today}.jsonl`);
  const events = transitions.map((t, index) => buildEvent({
    timestamp: new Date(Date.parse(timestamp) + index).toISOString(),
    eventType: t.eventType,
    actor: actorGuard.actor,
    actorRaw: actorGuard.raw_actor,
    actorReason: actorGuard.reason,
    actorGuardAction: actorGuard.guard_action,
    taskId,
    status: t.status,
    oldStatus: t.oldStatus,
    version: oldVersion + index + 1,
    note: t.note
  }));

  if (newStatus === 'done' && oldStatus !== 'open') {
    const taskPath = `cooperation/tasks/${taskId}.md`;
    const hasClaim = hasClaimTaskEvent(taskPath) || events.some((event) => event.event_type === 'claim_task');
    if (!hasClaim) {
      events.push(buildEvent({
        timestamp: new Date(Date.parse(timestamp) + events.length).toISOString(),
        eventType: 'milestone',
        actor: actorGuard.actor,
        actorRaw: actorGuard.raw_actor,
        actorReason: actorGuard.reason,
        actorGuardAction: actorGuard.guard_action,
        taskId,
        status: 'done',
        oldStatus,
        version: finalVersion,
        note: 'guard: done transition without claim_task detected',
        reason: 'event_chain_reconcile',
        source: 'update-task-status-guard'
      }));
    }
  }

  fs.appendFileSync(logFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  console.log(`✅ Task ${taskId}: ${oldStatus} → ${newStatus} (v${finalVersion})`);
  console.log(`📝 Events logged: ${events.map((e) => e.event_type).join(', ')}`);
}

function main() {
  const taskId = process.argv[2];
  const newStatus = process.argv[3];

  if (!taskId || !newStatus) {
    console.log('Usage: node scripts/update-task-status.mjs <task-id> <new-status>');
    process.exit(1);
  }
  if (!VALID_STATUSES.includes(newStatus)) {
    console.error(`Invalid status: ${newStatus}`);
    console.log(`Valid statuses: ${VALID_STATUSES.join(', ')}`);
    process.exit(1);
  }

  updateTaskStatus(taskId, newStatus);
}

main();
