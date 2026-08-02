import { getCoopDir } from '../config.js';
import { withCanonicalMutationLock } from '../storage/fs.js';
import {
  getRemoteBranchRevision,
  gitFetch,
  gitHasRemote,
  gitPushFastForward,
  isGitWorktreeDirty,
} from '../storage/git.js';

export async function coopPublishState(input: { remote?: string; branch?: string } = {}): Promise<string> {
  const coopDir = getCoopDir();
  const remote = input.remote ?? 'origin';
  return withCanonicalMutationLock(async () => {

    if (await isGitWorktreeDirty(coopDir)) {
      return JSON.stringify({
        error: 'dirty_canonical_state',
        message: 'Commit canonical cooperation changes before publishing state.',
      });
    }
    if (!(await gitHasRemote(remote, coopDir))) {
      return JSON.stringify({
        error: 'missing_remote',
        message: `Remote ${remote} is not configured.`,
      });
    }

    const result = await gitPushFastForward(remote, input.branch, coopDir);
    if (!result.pushed) {
      let remoteRevision: string | null = null;
      try {
        await gitFetch(remote, coopDir);
        remoteRevision = (await getRemoteBranchRevision(remote, result.branch ?? input.branch, coopDir)).revision;
      } catch {}
      return JSON.stringify({
        ...result,
        error: 'remote_conflict',
        local_revision: result.revision,
        remote_revision: remoteRevision,
        reconciliation_required: true,
        message: 'The global coordination branch advanced. Inspect with coop_reconcile, discard only a cooperation-only candidate, then re-read and retry the decision.',
        git_error: result.error,
      });
    }
    return JSON.stringify(result);
  }, coopDir);
}
