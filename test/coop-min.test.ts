import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { coopInit } from '../src/tools/init.js';
import { coopPostTask } from '../src/tools/coop.js';
import { getGitRevision, gitAddAndCommit } from '../src/storage/git.js';
import { runCoopMinPlanner } from '../src/coop-min/planner.js';
import { buildCoopMinDispatch } from '../src/coop-min/dispatch.js';
import { publishCoopMinTasks } from '../src/coop-min/publish.js';

let tmpDir: string;
const originalCoopDir = process.env.AGENT_COOP_DIR;

async function writeQuality(passed: boolean, currentIssues: number, includeCheckedCommit = false) {
  const relativePath = 'cooperation/runtime/quality-gate-status.json';
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify({
    passed,
    current_issues: currentIssues,
    checked_at: new Date().toISOString(),
    checked_commit: includeCheckedCommit ? await getGitRevision('HEAD', tmpDir) : undefined,
    source: 'test',
  }), 'utf8');
  await gitAddAndCommit([relativePath], 'test: quality evidence', tmpDir);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-min-test-'));
  process.env.AGENT_COOP_DIR = tmpDir;
  await coopInit({});
});

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('coop-min observer', () => {
  it('fails closed when quality evidence is missing', async () => {
    const summary = await runCoopMinPlanner({ coopDir: tmpDir });
    expect(summary.decision).toBe('continue');
    expect(summary.reason).toBe('quality_or_input_integrity_needs_fix');
    expect(summary.quality.passed).toBe(false);
    expect(summary.input_issues.length).toBeGreaterThan(0);
  });

  it('stops instead of inventing work when the task pool is empty and healthy', async () => {
    await writeQuality(true, 0);
    const summary = await runCoopMinPlanner({ coopDir: tmpDir });
    expect(summary.decision).toBe('stop');
    expect(summary.reason).toBe('no_actionable_findings');
    expect(summary.suggested_tasks).toEqual([]);
  });

  it('accepts committed evidence for its parent revision and invalidates it after task changes', async () => {
    await writeQuality(true, 0, true);
    const healthy = await runCoopMinPlanner({ coopDir: tmpDir });
    expect(healthy.decision).toBe('stop');
    expect(healthy.input_issues).toEqual([]);

    await coopPostTask({
      title: 'Change after evidence',
      body: 'invalidates the checked canonical state',
      source: 'openclaw',
    });
    const stale = await runCoopMinPlanner({ coopDir: tmpDir });
    expect(stale.decision).toBe('continue');
    expect(stale.input_issues.some((issue) => issue.includes('quality evidence covers'))).toBe(true);
  });

  it('publishes a dispatch once into the same canonical root', async () => {
    await writeQuality(false, 1);
    const summary = await runCoopMinPlanner({ coopDir: tmpDir });
    expect(summary.decision).toBe('continue');

    const dispatch = await buildCoopMinDispatch({ coopDir: tmpDir });
    const first = await publishCoopMinTasks({ dispatch, coopDir: tmpDir });
    const second = await publishCoopMinTasks({ dispatch, coopDir: tmpDir });

    expect(first.published).toBe(1);
    expect(second.published).toBe(0);
    expect(second.reason).toBe('already_published');
    expect(second.task_ids).toEqual(first.task_ids);
    await expect(fs.access(path.join(tmpDir, first.task_ids[0]))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, 'cooperation', 'dispatch-receipts', `${dispatch.dispatch_id}.json`))).resolves.toBeUndefined();
  });
});
