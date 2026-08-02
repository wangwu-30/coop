import { getCoopDir } from "../config.js";
import { withCanonicalMutationLock } from "../storage/fs.js";
import {
  getCurrentBranch,
  getGitDivergence,
  getGitMergeBase,
  getGitRevision,
  getRemoteBranchRevision,
  gitFetch,
  gitHasRemote,
  gitResetHard,
  isGitWorktreeCompletelyDirty,
  listAllChangedFiles,
} from "../storage/git.js";

const CANONICAL_FILES = new Set(["config.yaml", "policy.yaml"]);
const CANONICAL_PREFIXES = [
  "cooperation/",
  "logs/",
];

function isCanonicalPath(file: string): boolean {
  return CANONICAL_FILES.has(file) || CANONICAL_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export interface ReconcileInput {
  remote?: string;
  branch?: string;
  discard_local_candidate?: boolean;
  expected_local_revision?: string;
}

/**
 * Inspect a rejected candidate commit and, only with explicit confirmation,
 * discard it so the caller can sync, re-read canonical state and retry the
 * high-level decision. We deliberately do not rebase task decisions: a clean
 * textual rebase does not prove the decision is still valid.
 */
export async function coopReconcile(input: ReconcileInput = {}): Promise<string> {
  const coopDir = getCoopDir();
  const remote = input.remote ?? "origin";

  return withCanonicalMutationLock(async () => {
    if (!(await gitHasRemote(remote, coopDir))) {
      return JSON.stringify({ error: "missing_remote", remote });
    }
    if (await isGitWorktreeCompletelyDirty(coopDir)) {
      return JSON.stringify({
        error: "dirty_worktree",
        message: "Reconciliation requires a completely clean worktree so unrelated business changes cannot be discarded.",
      });
    }

    try {
      await gitFetch(remote, coopDir);
    } catch (error) {
      return JSON.stringify({
        error: "fetch_failed",
        remote,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    const currentBranch = input.branch ?? await getCurrentBranch(coopDir);
    const localRevision = await getGitRevision("HEAD", coopDir);
    const remoteState = await getRemoteBranchRevision(remote, currentBranch ?? undefined, coopDir);
    const remoteRevision = remoteState.revision;
    if (!localRevision || !remoteRevision || !remoteState.ref) {
      return JSON.stringify({
        error: "missing_revision",
        branch: currentBranch,
        local_revision: localRevision,
        remote_revision: remoteRevision,
      });
    }

    if (input.expected_local_revision && input.expected_local_revision !== localRevision) {
      return JSON.stringify({
        error: "local_revision_changed",
        expected_local_revision: input.expected_local_revision,
        actual_local_revision: localRevision,
      });
    }

    const divergence = await getGitDivergence(localRevision, remoteRevision, coopDir);
    if (divergence.ahead === 0 && divergence.behind === 0) {
      return JSON.stringify({
        reconciled: true,
        status: "current",
        branch: remoteState.branch,
        local_revision: localRevision,
        remote_revision: remoteRevision,
        ...divergence,
      });
    }

    const mergeBase = await getGitMergeBase(localRevision, remoteRevision, coopDir);
    if (!mergeBase) {
      return JSON.stringify({
        error: "unrelated_histories",
        branch: remoteState.branch,
        local_revision: localRevision,
        remote_revision: remoteRevision,
      });
    }

    const candidatePaths = divergence.ahead > 0
      ? await listAllChangedFiles(mergeBase, localRevision, coopDir)
      : [];
    const nonCanonicalPaths = candidatePaths.filter((file) => !isCanonicalPath(file));
    const candidateIsCooperationOnly = candidatePaths.length > 0 && nonCanonicalPaths.length === 0;
    const status = divergence.ahead > 0 && divergence.behind > 0
      ? "diverged"
      : divergence.ahead > 0
        ? "local_ahead"
        : "remote_ahead";

    const inspection = {
      reconciled: false,
      status,
      branch: remoteState.branch,
      local_revision: localRevision,
      remote_revision: remoteRevision,
      merge_base: mergeBase,
      ...divergence,
      candidate_paths: candidatePaths,
      non_cooperation_paths: nonCanonicalPaths,
      candidate_is_cooperation_only: candidateIsCooperationOnly,
      can_discard_local_candidate: divergence.ahead > 0 && candidateIsCooperationOnly,
    };

    if (!input.discard_local_candidate) {
      return JSON.stringify(inspection);
    }
    if (divergence.ahead === 0) {
      return JSON.stringify({
        ...inspection,
        error: "no_local_candidate",
        message: "There is no local candidate commit to discard; use coop_sync for a fast-forward update.",
      });
    }
    if (!candidateIsCooperationOnly) {
      return JSON.stringify({
        ...inspection,
        error: "unsafe_candidate_scope",
        message: "Local commits include non-cooperation files and will not be discarded automatically.",
      });
    }

    await gitResetHard(remoteState.ref, coopDir);
    return JSON.stringify({
      reconciled: true,
      status: "candidate_discarded",
      branch: remoteState.branch,
      discarded_revision: localRevision,
      canonical_revision: remoteRevision,
      discarded_paths: candidatePaths,
      next: "Re-read task and inbox state before retrying the decision.",
    });
  }, coopDir);
}
