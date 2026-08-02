import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coopInit } from '../src/tools/init.js';
import { coopCheckInbox, coopPostTask } from '../src/tools/coop.js';
import { coopGetGlobalState } from '../src/tools/global-state.js';

let tmpDir: string;
const originalCoopDir = process.env.AGENT_COOP_DIR;
const exec = promisify(execFile);

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-global-state-'));
  process.env.AGENT_COOP_DIR = tmpDir;
  await coopInit({});
});

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('global state', () => {
  it('uses the Git revision as a global cursor and reports changed tasks', async () => {
    const initial = JSON.parse(await coopGetGlobalState({ fetch: false }));
    expect(initial.canonical_revision).toBeTruthy();
    expect(initial.revision_relation).toBe('local_only');

    await coopPostTask({ title: 'Global cursor', body: 'detect this task', source: 'openclaw' });
    const updated = JSON.parse(await coopGetGlobalState({
      fetch: false,
      last_seen_commit: initial.canonical_revision,
    }));

    expect(updated.revision_changed).toBe(true);
    expect(updated.canonical_revision).not.toBe(initial.canonical_revision);
    expect(updated.changed_tasks).toHaveLength(1);
    expect(updated.task_counts.open).toBe(1);
    expect(updated.task_counts_revision).toBe(updated.canonical_revision);
  });

  it('reports task counts from the remote commit when the local worktree is behind', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-global-remote-'));
    const remote = path.join(root, 'remote.git');
    const peer = path.join(root, 'peer');
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: tmpDir });
    await exec('git', ['push', '-u', 'origin', 'main'], { cwd: tmpDir });
    await exec('git', ['clone', remote, peer]);

    process.env.AGENT_COOP_DIR = peer;
    await coopPostTask({ title: 'Remote only', body: 'not checked out locally', source: 'openclaw' });
    await exec('git', ['push', 'origin', 'main'], { cwd: peer });

    process.env.AGENT_COOP_DIR = tmpDir;
    const state = JSON.parse(await coopGetGlobalState());
    expect(state.local_is_current).toBe(false);
    expect(state.revision_relation).toBe('remote_ahead');
    expect(state.task_counts.open).toBe(1);
    expect(state.local_worktree_task_counts.open).toBe(0);
    expect(state.task_counts_revision).toBe(state.remote_revision);

    await fs.rm(root, { recursive: true, force: true });
  });

  it('distinguishes a local candidate that needs publish from remote state that needs sync', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-global-local-ahead-'));
    const remote = path.join(root, 'remote.git');
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['remote', 'add', 'origin', remote], { cwd: tmpDir });
    await exec('git', ['push', '-u', 'origin', 'main'], { cwd: tmpDir });

    await coopPostTask({ title: 'Local candidate', body: 'publish me', source: 'codex' });
    const state = JSON.parse(await coopGetGlobalState({ fetch: false }));
    expect(state.revision_relation).toBe('local_ahead');

    const inbox = JSON.parse(await coopCheckInbox({ agent_id: 'codex', fetch: false }));
    expect(inbox.summary).toMatchObject({
      sync_required: false,
      publish_required: true,
      reconciliation_required: false,
    });

    await fs.rm(root, { recursive: true, force: true });
  });
});
