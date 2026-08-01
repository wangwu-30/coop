#!/usr/bin/env node
import { coopGetGlobalState, type GlobalStateInput } from './tools/global-state.js';

function readOption(name: string): string | undefined {
  const exactIndex = process.argv.indexOf(name);
  if (exactIndex >= 0) return process.argv[exactIndex + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  const coopDir = readOption('--coop-dir');
  if (coopDir) process.env.AGENT_COOP_DIR = coopDir;
  const watch = process.argv.includes('--watch');
  const intervalMs = Math.max(250, Number(readOption('--interval-ms') ?? 5_000));
  const input: GlobalStateInput = {
    last_seen_commit: readOption('--last-seen'),
    remote: readOption('--remote'),
    branch: readOption('--branch'),
    fetch: !process.argv.includes('--no-fetch'),
  };

  do {
    const raw = await coopGetGlobalState(input);
    const state = JSON.parse(raw) as { canonical_revision?: string; revision_changed?: boolean };
    if (!watch || !input.last_seen_commit || state.revision_changed) console.log(raw);
    if (!watch) return;
    input.last_seen_commit = state.canonical_revision ?? input.last_seen_commit;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (true);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
