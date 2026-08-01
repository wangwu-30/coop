import { gitPull, gitHasRemote, isGitWorktreeDirty } from "../storage/git.js";
import { getCoopDir } from "../config.js";

export interface SyncInput { remote?: string; }

export async function coopSync(input: SyncInput): Promise<string> {
  const coopDir = getCoopDir();
  const remote = input.remote ?? "origin";

  const hasRemote = await gitHasRemote(remote, coopDir);
  if (!hasRemote) {
    return JSON.stringify({ error: `No remote '${remote}' configured. Use coop_init with remote first.` });
  }
  if (await isGitWorktreeDirty(coopDir)) {
    return JSON.stringify({
      error: "dirty_canonical_state",
      message: "Commit or reconcile canonical cooperation changes before syncing.",
    });
  }

  const pullResult = await gitPull(remote, coopDir);
  if (pullResult.startsWith("Sync failed:") || pullResult.startsWith("Sync skipped:")) {
    return JSON.stringify({
      error: "sync_conflict",
      remote,
      message: pullResult,
    });
  }
  return JSON.stringify({ synced: true, remote, result: pullResult });
}
