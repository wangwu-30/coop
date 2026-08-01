import { runCoopMinPlanner } from './planner.js';
import { buildCoopMinDispatch } from './dispatch.js';
import { publishCoopMinTasks } from './publish.js';
import { getCoopDir } from '../config.js';

export async function runCoopMinHeartbeat(coopDir = getCoopDir()) {
  const summary = await runCoopMinPlanner({ coopDir });
  const dispatch = await buildCoopMinDispatch({ coopDir });
  const publish = await publishCoopMinTasks({ dispatch, coopDir });
  return { summary, dispatch, publish };
}
