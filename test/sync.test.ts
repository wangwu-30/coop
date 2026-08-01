import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coopInit } from '../src/tools/init.js';
import { coopPostTask } from '../src/tools/coop.js';
import { coopSync } from '../src/tools/sync.js';

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const roots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('coordination sync', () => {
  it('rejects divergent local decisions instead of rebasing them', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-sync-'));
    roots.push(root);
    const remote = path.join(root, 'remote.git');
    const local = path.join(root, 'local');
    const peer = path.join(root, 'peer');
    await fs.mkdir(local, { recursive: true });
    await exec('git', ['init', '--bare', remote]);

    process.env.AGENT_COOP_DIR = local;
    await coopInit({ remote });
    await exec('git', ['push', '-u', 'origin', 'main'], { cwd: local });
    await exec('git', ['clone', remote, peer]);

    const localTask = JSON.parse(await coopPostTask({
      title: 'Local provisional decision',
      body: 'must not be silently replayed',
      source: 'openclaw',
    }));
    const localHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: local })).stdout.trim();

    process.env.AGENT_COOP_DIR = peer;
    const peerTask = JSON.parse(await coopPostTask({
      title: 'Remote accepted decision',
      body: 'advances the shared branch',
      source: 'openclaw',
    }));
    await exec('git', ['push', 'origin', 'main'], { cwd: peer });

    process.env.AGENT_COOP_DIR = local;
    const result = JSON.parse(await coopSync({}));
    const afterHead = (await exec('git', ['rev-parse', 'HEAD'], { cwd: local })).stdout.trim();

    expect(result.error).toBe('sync_conflict');
    expect(afterHead).toBe(localHead);
    await expect(fs.access(path.join(local, localTask.id))).resolves.toBeUndefined();
    await expect(fs.access(path.join(local, peerTask.id))).rejects.toThrow();
  });
});
