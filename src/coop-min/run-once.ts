import { buildCoopMinDispatch } from './dispatch.js';
import { runCoopMinPlanner } from './planner.js';
import { getCoopDir } from '../config.js';

export async function runCoopMinOnce(coopDir = getCoopDir()) {
  const summary = await runCoopMinPlanner({ coopDir });
  const dispatch = await buildCoopMinDispatch({ coopDir });
  return { summary, dispatch };
}
