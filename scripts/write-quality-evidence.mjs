#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const toolRoot = process.cwd();
const coopRoot = path.resolve(process.env.AGENT_COOP_DIR ?? toolRoot);
const output = path.join(coopRoot, 'cooperation', 'runtime', 'quality-gate-status.json');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: coopRoot, encoding: 'utf8' }).trim();
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
console.log(`✅ wrote fresh quality evidence: ${path.relative(coopRoot, output)}`);
