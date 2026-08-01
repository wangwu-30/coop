import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coopInit } from '../src/tools/init.js';
import { coopPostTask } from '../src/tools/coop.js';
import { coopPublishState } from '../src/tools/publish-state.js';

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const temporaryRoots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('publish cooperation state', () => {
  it('treats a rejected fast-forward push as a global state conflict', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-publish-state-'));
    temporaryRoots.push(root);
    const remote = path.join(root, 'remote.git');
    const local = path.join(root, 'local');
    const peer = path.join(root, 'peer');
    await fs.mkdir(local, { recursive: true });
    await exec('git', ['init', '--bare', remote]);

    process.env.AGENT_COOP_DIR = local;
    await coopInit({ remote });
    expect(JSON.parse(await coopPublishState()).pushed).toBe(true);

    await exec('git', ['clone', remote, peer]);
    await fs.writeFile(path.join(peer, 'peer-state.txt'), 'peer update\n', 'utf8');
    await exec('git', ['add', 'peer-state.txt'], { cwd: peer });
    await exec('git', ['commit', '-m', 'peer: advance state'], { cwd: peer });

    await coopPostTask({ title: 'Local candidate', body: 'not global yet', source: 'openclaw' });
    await exec('git', ['push', 'origin', 'main'], { cwd: peer });

    const rejected = JSON.parse(await coopPublishState());
    expect(rejected.error).toBe('remote_conflict');
    expect(rejected.pushed).toBe(false);
  });
});
