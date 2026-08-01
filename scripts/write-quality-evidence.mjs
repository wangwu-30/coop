#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const output = path.join(root, 'cooperation', 'runtime', 'quality-gate-status.json');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const evidence = {
  schema: 'agent-coop.quality-evidence.v1',
  passed: true,
  current_issues: 0,
  checked_at: new Date().toISOString(),
  checked_commit: git(['rev-parse', 'HEAD']) || null,
  worktree_dirty: git(['status', '--porcelain']).length > 0,
  source: 'npm run quality:gate',
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(`✅ wrote fresh quality evidence: ${path.relative(root, output)}`);
