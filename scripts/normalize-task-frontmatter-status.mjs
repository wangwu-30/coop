#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, '..', 'cooperation', 'tasks');
const VALID = new Set(['open', 'in_progress', 'done', 'blocked', 'cancelled']);

function splitTask(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return null;
  return { fmRaw: match[1], body: content.slice(match[0].length) };
}

function parseFrontmatter(fmRaw) {
  const lines = fmRaw.split('\n');
  let status = null;
  for (const line of lines) {
    const m = line.match(/^status:\s*(.+?)\s*$/);
    if (m) status = m[1].replace(/^['\"]|['\"]$/g, '');
  }
  return { lines, status };
}

function setFrontmatterStatus(lines, nextStatus) {
  let replaced = false;
  const out = lines.map((line) => {
    if (/^status:\s*/.test(line)) {
      replaced = true;
      return `status: ${nextStatus}`;
    }
    return line;
  });
  if (!replaced) out.unshift(`status: ${nextStatus}`);
  return out;
}

function normalizeBodyStatus(body) {
  const lines = body.split('\n');
  const found = [];
  const kept = [];
  for (const line of lines) {
    const m = line.match(/^status:\s*(open|in_progress|done|blocked|cancelled)\s*$/);
    if (m) {
      found.push(m[1]);
      continue;
    }
    kept.push(line);
  }
  return { found, body: kept.join('\n').replace(/\n{3,}/g, '\n\n') };
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

let changed = 0;
for (const file of fs.readdirSync(TASKS_DIR)) {
  if (!file.endsWith('.md')) continue;
  const full = path.join(TASKS_DIR, file);
  const raw = fs.readFileSync(full, 'utf8');
  const split = splitTask(raw);
  if (!split) continue;

  const { lines, status: fmStatus } = parseFrontmatter(split.fmRaw);
  const { found, body } = normalizeBodyStatus(split.body);
  if (found.length === 0) continue;

  const lastBodyStatus = found[found.length - 1];
  const targetStatus = VALID.has(lastBodyStatus) ? lastBodyStatus : fmStatus;
  const nextFmLines = setFrontmatterStatus(lines, targetStatus);

  const next = `---\n${nextFmLines.join('\n')}\n---\n\n${body.trimStart()}`;
  if (next !== raw) {
    atomicWrite(full, next);
    changed += 1;
    console.log(`normalized ${file}: fm=${fmStatus} -> ${targetStatus}, removed_body_status=${found.length}`);
  }
}

console.log(`done: normalized ${changed} task file(s)`);
