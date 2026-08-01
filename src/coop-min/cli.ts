#!/usr/bin/env node
import { runCoopMinPlanner } from './planner.js';
import { buildCoopMinDispatch } from './dispatch.js';
import { runCoopMinOnce } from './run-once.js';
import { publishCoopMinTasks } from './publish.js';
import { runCoopMinHeartbeat } from './heartbeat.js';

async function main() {
  const coopDirIndex = process.argv.indexOf('--coop-dir');
  if (coopDirIndex >= 0 && process.argv[coopDirIndex + 1]) {
    process.env.AGENT_COOP_DIR = process.argv[coopDirIndex + 1];
  }
  const mode = process.argv[2] ?? 'run';
  if (mode === 'plan') {
    console.log(JSON.stringify(await runCoopMinPlanner(), null, 2));
    return;
  }
  if (mode === 'dispatch') {
    console.log(JSON.stringify(await buildCoopMinDispatch(), null, 2));
    return;
  }
  if (mode === 'publish') {
    const dispatch = await buildCoopMinDispatch();
    console.log(JSON.stringify(await publishCoopMinTasks({ dispatch }), null, 2));
    return;
  }
  if (mode === 'heartbeat') {
    console.log(JSON.stringify(await runCoopMinHeartbeat(), null, 2));
    return;
  }
  console.log(JSON.stringify(await runCoopMinOnce(), null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
