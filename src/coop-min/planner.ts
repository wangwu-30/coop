import type { CoopMinObserverSummary, CoopMinSuggestedTask, CoopMinTaskSummary } from './types.js';
import { getCoopDir } from '../config.js';
import { parseTask } from '../schema/coop.js';
import { listCoopFiles, readFile, writeFile } from '../storage/fs.js';
import { getGitRevision, isGitWorktreeDirty } from '../storage/git.js';

async function loadTasks(coopDir: string): Promise<{ tasks: CoopMinTaskSummary[]; issues: string[] }> {
  const files = await listCoopFiles('tasks', coopDir);
  const tasks: CoopMinTaskSummary[] = [];
  const issues: string[] = [];

  for (const file of files) {
    try {
      const task = parseTask(await readFile(file, coopDir), file);
      tasks.push({
        id: file,
        title: task.title,
        status: task.frontmatter.status,
        assignee: task.frontmatter.assignee,
        priority: task.frontmatter.priority,
        updated: task.frontmatter.updated,
      });
    } catch (error) {
      issues.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tasks, issues };
}

async function loadQuality(
  qualityFile: string,
  coopDir: string,
  maxAgeMs: number,
): Promise<{ quality: Record<string, unknown>; issues: string[] }> {
  try {
    const quality = JSON.parse(await readFile(qualityFile, coopDir)) as Record<string, unknown>;
    const issues: string[] = [];

    if (typeof quality.passed !== 'boolean') issues.push('quality.passed must be a boolean');
    if (!Number.isFinite(Number(quality.current_issues))) issues.push('quality.current_issues must be numeric');

    const checkedAt = quality.checked_at ?? quality.timestamp;
    const checkedAtMs = typeof checkedAt === 'string' ? Date.parse(checkedAt) : Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      issues.push('quality evidence is missing checked_at/timestamp');
    } else if (Date.now() - checkedAtMs > maxAgeMs) {
      issues.push(`quality evidence is stale (${String(checkedAt)})`);
    }

    return { quality, issues };
  } catch (error) {
    return {
      quality: {
        passed: false,
        current_issues: 1,
        source: 'missing-or-invalid-quality-file',
      },
      issues: [`${qualityFile}: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

export async function runCoopMinPlanner({
  coopDir = getCoopDir(),
  qualityFile = 'cooperation/runtime/quality-gate-status.json',
  outFile = 'coop-min/state/observer-summary.json',
  actor = 'observer-pm',
  qualityMaxAgeMs = 24 * 60 * 60 * 1000,
}: {
  coopDir?: string;
  qualityFile?: string;
  outFile?: string;
  actor?: string;
  qualityMaxAgeMs?: number;
} = {}): Promise<CoopMinObserverSummary> {
  const [{ tasks, issues: taskIssues }, { quality, issues: qualityIssues }, sourceCommit, worktreeDirty] = await Promise.all([
    loadTasks(coopDir),
    loadQuality(qualityFile, coopDir, qualityMaxAgeMs),
    getGitRevision('HEAD', coopDir),
    isGitWorktreeDirty(coopDir),
  ]);
  const inputIssues = [...taskIssues, ...qualityIssues];
  if (quality.worktree_dirty === true) inputIssues.push('quality evidence was produced from a dirty worktree');
  if (
    typeof quality.checked_commit === 'string' &&
    sourceCommit &&
    quality.checked_commit !== sourceCommit
  ) {
    inputIssues.push(`quality evidence covers ${quality.checked_commit}, current commit is ${sourceCommit}`);
  }

  const openTasks = tasks.filter((task) => task.status === 'open');
  const inProgressTasks = tasks.filter((task) => task.status === 'in_progress');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');

  let decision: 'continue' | 'stop' = 'stop';
  let reason = 'no_actionable_findings';
  const suggestedTasks: CoopMinSuggestedTask[] = [];

  const qualityPassed = quality.passed === true;
  const currentIssues = Number(quality.current_issues);

  if (worktreeDirty) {
    reason = 'canonical_state_has_uncommitted_changes';
  } else if (inputIssues.length > 0 || !qualityPassed || currentIssues > 0) {
    decision = 'continue';
    reason = 'quality_or_input_integrity_needs_fix';
    suggestedTasks.push({
      slot: 'A',
      title: 'Restore current quality evidence',
      lane: 'stability',
      priority: 'high',
      recommended: true,
      why: inputIssues[0] ?? 'quality gate failed or current issues > 0',
      acceptance_criteria: [
        'quality gate passes with fresh checked_at evidence',
        'current issues are reduced to 0',
        'all task files parse against the canonical schema',
      ],
      suggested_assignee: 'impl-agent',
    });
  } else if (blockedTasks.length > 0 && inProgressTasks.length === 0) {
    decision = 'continue';
    reason = 'blocked_tasks_need_unblock';
    suggestedTasks.push({
      slot: 'A',
      title: 'Unblock blocked tasks',
      lane: 'stability',
      priority: 'high',
      recommended: true,
      why: 'blocked tasks exist and no worker is actively draining them',
      acceptance_criteria: [
        'each blocked task has a concrete unblock path',
        'at least one blocked task is moved back to open or in_progress',
        'block reasons are documented clearly',
      ],
      suggested_assignee: 'impl-agent',
    });
  } else if (openTasks.length > 0 || inProgressTasks.length > 0) {
    reason = 'active_tasks_should_be_drained';
  }

  const summary: CoopMinObserverSummary = {
    schema: 'agent-coop.coop-min.observer-summary.v1',
    generated_at: new Date().toISOString(),
    actor,
    source_commit: sourceCommit,
    worktree_dirty: worktreeDirty,
    input_issues: inputIssues,
    counts: {
      open: openTasks.length,
      in_progress: inProgressTasks.length,
      blocked: blockedTasks.length,
      total: tasks.length,
    },
    quality,
    decision,
    reason,
    suggested_tasks: suggestedTasks.slice(0, 2),
  };

  await writeFile(outFile, `${JSON.stringify(summary, null, 2)}\n`, coopDir);
  return summary;
}
