import { createHash } from 'node:crypto';
import { getCoopDir } from '../config.js';
import { readFile, writeFile } from '../storage/fs.js';
import type { CoopMinDispatch, CoopMinObserverSummary } from './types.js';

function createDispatchId(summary: CoopMinObserverSummary, actor: string): string {
  const stableInput = JSON.stringify({
    actor,
    source_commit: summary.source_commit,
    decision: summary.decision,
    reason: summary.reason,
    tasks: summary.suggested_tasks,
  });
  return createHash('sha256').update(stableInput).digest('hex').slice(0, 20);
}

export async function buildCoopMinDispatch({
  coopDir = getCoopDir(),
  inputFile = 'coop-min/state/observer-summary.json',
  outFile = 'coop-min/state/dispatch.json',
  actor = 'observer-pm',
}: {
  coopDir?: string;
  inputFile?: string;
  outFile?: string;
  actor?: string;
} = {}): Promise<CoopMinDispatch> {
  const summary = JSON.parse(await readFile(inputFile, coopDir)) as CoopMinObserverSummary;

  const dispatch: CoopMinDispatch = {
    schema: 'agent-coop.coop-min.dispatch.v1',
    dispatch_id: createDispatchId(summary, actor),
    generated_at: new Date().toISOString(),
    actor,
    source_commit: summary.source_commit ?? null,
    decision: summary.decision,
    reason: summary.reason,
    task_count: summary.suggested_tasks.length,
    tasks: summary.suggested_tasks,
  };

  await writeFile(outFile, `${JSON.stringify(dispatch, null, 2)}\n`, coopDir);
  return dispatch;
}
