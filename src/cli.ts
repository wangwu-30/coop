#!/usr/bin/env node
import { coopInit } from './tools/init.js';
import { coopGetGlobalState } from './tools/global-state.js';
import { coopPublishState } from './tools/publish-state.js';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const coopDir = readOption('--coop-dir');
  if (coopDir) process.env.AGENT_COOP_DIR = coopDir;
  const command = process.argv[2] ?? 'help';

  if (command === 'init') {
    console.log(await coopInit({ remote: readOption('--remote') }));
    return;
  }
  if (command === 'state') {
    console.log(await coopGetGlobalState({
      last_seen_commit: readOption('--last-seen'),
      remote: readOption('--remote'),
      branch: readOption('--branch'),
      fetch: !process.argv.includes('--no-fetch'),
    }));
    return;
  }
  if (command === 'push') {
    console.log(await coopPublishState({
      remote: readOption('--remote'),
      branch: readOption('--branch'),
    }));
    return;
  }

  console.log([
    'Usage:',
    '  agent-coop-cli init [--coop-dir <path>] [--remote <url>]',
    '  agent-coop-cli state [--coop-dir <path>] [--last-seen <sha>] [--no-fetch]',
    '  agent-coop-cli push [--coop-dir <path>] [--remote <name>] [--branch <name>]',
    '',
    'Run `agent-coop` to start the MCP stdio server.',
  ].join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
