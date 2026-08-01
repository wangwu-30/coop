import { getCoopDir } from '../config.js';
import { parseTask, type TaskStatus } from '../schema/coop.js';
import { listCoopFiles, readFile } from '../storage/fs.js';
import {
  getCurrentBranch,
  getGitRevision,
  getRemoteBranchRevision,
  gitFetch,
  gitHasRemote,
  isGitWorktreeDirty,
  listFilesAtRevision,
  listChangedFiles,
  readFileAtRevision,
} from '../storage/git.js';

export interface GlobalStateInput {
  last_seen_commit?: string;
  remote?: string;
  branch?: string;
  fetch?: boolean;
}

async function countTasks(coopDir: string): Promise<Record<TaskStatus | 'total' | 'invalid', number>> {
  const counts: Record<TaskStatus | 'total' | 'invalid', number> = {
    open: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    total: 0,
    invalid: 0,
  };
  for (const file of await listCoopFiles('tasks', coopDir)) {
    counts.total += 1;
    try {
      const task = parseTask(await readFile(file, coopDir), file);
      counts[task.frontmatter.status] += 1;
    } catch {
      counts.invalid += 1;
    }
  }
  return counts;
}

async function countTasksAtRevision(
  revision: string,
  coopDir: string,
): Promise<Record<TaskStatus | 'total' | 'invalid', number>> {
  const counts: Record<TaskStatus | 'total' | 'invalid', number> = {
    open: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    total: 0,
    invalid: 0,
  };
  for (const file of await listFilesAtRevision(revision, 'cooperation/tasks', coopDir)) {
    if (!file.endsWith('.md')) continue;
    counts.total += 1;
    try {
      const task = parseTask(await readFileAtRevision(revision, file, coopDir), file);
      counts[task.frontmatter.status] += 1;
    } catch {
      counts.invalid += 1;
    }
  }
  return counts;
}

export async function coopGetGlobalState(input: GlobalStateInput = {}): Promise<string> {
  const coopDir = getCoopDir();
  const remote = input.remote ?? 'origin';
  const hasRemote = await gitHasRemote(remote, coopDir);
  let fetchError: string | null = null;

  if (hasRemote && input.fetch !== false) {
    try {
      await gitFetch(remote, coopDir);
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }
  }

  const localRevision = await getGitRevision('HEAD', coopDir);
  const localBranch = await getCurrentBranch(coopDir);
  const remoteState = hasRemote
    ? await getRemoteBranchRevision(remote, input.branch ?? localBranch ?? undefined, coopDir)
    : { branch: null, ref: null, revision: null };
  const canonicalRevision = remoteState.revision ?? localRevision;
  const revisionChanged = Boolean(
    input.last_seen_commit &&
    canonicalRevision &&
    input.last_seen_commit !== canonicalRevision
  );
  const changedFiles = revisionChanged
    ? await listChangedFiles(input.last_seen_commit!, canonicalRevision!, coopDir)
    : [];
  const canonicalCounts = canonicalRevision
    ? await countTasksAtRevision(canonicalRevision, coopDir)
    : await countTasks(coopDir);
  const localWorktreeCounts = await countTasks(coopDir);

  return JSON.stringify({
    schema: 'agent-coop.global-state.v1',
    generated_at: new Date().toISOString(),
    coop_dir: coopDir,
    branch: remoteState.branch ?? localBranch,
    local_revision: localRevision,
    remote_revision: remoteState.revision,
    canonical_revision: canonicalRevision,
    local_is_current: !remoteState.revision || remoteState.revision === localRevision,
    worktree_dirty: await isGitWorktreeDirty(coopDir),
    revision_changed: revisionChanged,
    changed_files: changedFiles,
    changed_tasks: changedFiles.filter((file) => file.startsWith('cooperation/tasks/')),
    task_counts: canonicalCounts,
    task_counts_revision: canonicalRevision,
    local_worktree_task_counts: localWorktreeCounts,
    fetch_error: fetchError,
  });
}
