import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { coopInit } from '../src/tools/init.js';
import { gitAddAndCommit } from '../src/storage/git.js';

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const roots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('business repository safety', () => {
  it('reuses an existing config without rewriting it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-init-safe-'));
    roots.push(root);
    process.env.AGENT_COOP_DIR = root;
    await exec('git', ['init'], { cwd: root });
    const original = 'version: 9.9.9\nagents:\n  - custom-agent\nmemoryBridge:\n  enabled: false\nchatBridge:\n  enabled: false\n';
    await fs.writeFile(path.join(root, 'config.yaml'), original, 'utf8');

    await coopInit({});

    expect(await fs.readFile(path.join(root, 'config.yaml'), 'utf8')).toBe(original);
  });

  it('commits only cooperation files and leaves unrelated staged work staged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-coop-commit-safe-'));
    roots.push(root);
    await exec('git', ['init'], { cwd: root });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: root });
    await fs.writeFile(path.join(root, 'business.txt'), 'business change\n', 'utf8');
    await fs.writeFile(path.join(root, 'coop.txt'), 'cooperation change\n', 'utf8');
    await exec('git', ['add', 'business.txt'], { cwd: root });

    await gitAddAndCommit(['coop.txt'], 'coop: isolated commit', root);

    const committed = await exec('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], { cwd: root });
    const staged = await exec('git', ['diff', '--cached', '--name-only'], { cwd: root });
    expect(committed.stdout.trim()).toBe('coop.txt');
    expect(staged.stdout.trim()).toBe('business.txt');
  });
});
