import path from 'node:path';
import { getCoopDir } from '../config.js';
import { serializeTask, type CoopTask } from '../schema/coop.js';
import {
  appendPreparedEventLogBatch,
  prepareEventLogBatch,
} from '../storage/events.js';
import {
  fileExists,
  readFile,
  removeFile,
  withMutationLock,
  writeFile,
} from '../storage/fs.js';
import { gitAddAndCommit } from '../storage/git.js';
import type { CoopMinDispatch } from './types.js';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function taskFileName(dispatchId: string, title: string, slot: string): string {
  return `coop-min-${dispatchId}-${slugify(slot)}-${slugify(title)}.md`;
}

export async function publishCoopMinTasks({
  dispatch,
  coopDir = getCoopDir(),
  maxTasks = 2,
  defaultAssignee = 'impl-agent',
}: {
  dispatch: CoopMinDispatch;
  coopDir?: string;
  maxTasks?: number;
  defaultAssignee?: string;
}) {
  if (dispatch.decision !== 'continue' || dispatch.tasks.length === 0) {
    return { published: 0, task_ids: [], reason: 'nothing_to_publish', dispatch_id: dispatch.dispatch_id };
  }

  return withMutationLock(`dispatch:${dispatch.dispatch_id}`, async () => {
    const receiptPath = path.join('cooperation', 'dispatch-receipts', `${dispatch.dispatch_id}.json`);
    if (await fileExists(receiptPath, coopDir)) {
      const receipt = JSON.parse(await readFile(receiptPath, coopDir)) as { task_ids?: string[] };
      return {
        published: 0,
        task_ids: receipt.task_ids ?? [],
        reason: 'already_published',
        dispatch_id: dispatch.dispatch_id,
      };
    }

    const selected = dispatch.tasks.slice(0, Math.max(0, maxTasks));
    const now = new Date().toISOString();
    const taskEntries = selected.map((item) => {
      const relativePath = path.join(
        'cooperation',
        'tasks',
        taskFileName(dispatch.dispatch_id, item.title, item.slot),
      );
      const task: Omit<CoopTask, 'filePath'> = {
        frontmatter: {
          status: 'open',
          priority: item.priority,
          created_by: dispatch.actor,
          assignee: item.suggested_assignee || defaultAssignee,
          created: now,
          updated: now,
          tags: ['coop-min', 'observer-generated', item.lane],
          depends_on: [],
          version: 1,
        },
        title: item.title,
        body: [
          'Observer-generated task from coop-min.',
          '',
          `- dispatch_id: ${dispatch.dispatch_id}`,
          `- source_commit: ${dispatch.source_commit ?? 'uncommitted'}`,
          `- lane: ${item.lane}`,
          `- recommended: ${String(item.recommended)}`,
          `- why: ${item.why}`,
          `- source_reason: ${dispatch.reason}`,
          `- suggested_assignee: ${item.suggested_assignee || defaultAssignee}`,
          '',
          '## Acceptance Criteria',
          ...item.acceptance_criteria.map((criterion) => `- ${criterion}`),
        ].join('\n'),
      };
      return { item, relativePath, content: serializeTask(task) };
    });

    for (const entry of taskEntries) {
      if (await fileExists(entry.relativePath, coopDir)) {
        throw new Error(`Dispatch task exists without receipt: ${entry.relativePath}`);
      }
    }

    // Validate every event and the trust policy before the first task is written.
    const preparedEvents = await prepareEventLogBatch(taskEntries.map(({ item, relativePath }) => ({
      event_type: 'post_task',
      task_id: relativePath,
      actor: dispatch.actor,
      trace_id: dispatch.dispatch_id,
      payload: {
        dispatch_id: dispatch.dispatch_id,
        source_commit: dispatch.source_commit,
        title: item.title,
        priority: item.priority,
        tags: ['coop-min', 'observer-generated', item.lane],
      },
    })), coopDir);

    const writtenTasks: string[] = [];
    let evidenceAppended = false;
    try {
      for (const entry of taskEntries) {
        await writeFile(entry.relativePath, entry.content, coopDir);
        writtenTasks.push(entry.relativePath);
      }
      const eventLogPaths = await appendPreparedEventLogBatch(preparedEvents, coopDir);
      evidenceAppended = true;
      const receipt = {
        schema: 'agent-coop.dispatch-receipt.v1',
        dispatch_id: dispatch.dispatch_id,
        source_commit: dispatch.source_commit,
        published_at: now,
        task_ids: writtenTasks,
      };
      await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, coopDir);
      await gitAddAndCommit(
        [...writtenTasks, ...eventLogPaths, receiptPath],
        `coop: publish dispatch ${dispatch.dispatch_id}`,
        coopDir,
      );
    } catch (error) {
      // Before append, rollback is safe. Once append-only evidence exists, keep
      // the matching task files for repair instead of creating orphan events.
      if (!evidenceAppended) {
        for (const taskPath of writtenTasks) await removeFile(taskPath, coopDir);
        await removeFile(receiptPath, coopDir);
      }
      throw error;
    }

    return {
      published: writtenTasks.length,
      task_ids: writtenTasks,
      reason: 'published',
      dispatch_id: dispatch.dispatch_id,
    };
  }, coopDir);
}
