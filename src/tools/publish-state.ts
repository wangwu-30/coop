import { getCoopDir } from '../config.js';
import { gitHasRemote, gitPushFastForward, isGitWorktreeDirty } from '../storage/git.js';

export async function coopPublishState(input: { remote?: string; branch?: string } = {}): Promise<string> {
  const coopDir = getCoopDir();
  const remote = input.remote ?? 'origin';

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
    return JSON.stringify({
      ...result,
      error: 'remote_conflict',
      message: 'The global coordination branch advanced. Fetch, re-read the task, and retry the decision.',
      git_error: result.error,
    });
  }
  return JSON.stringify(result);
}
