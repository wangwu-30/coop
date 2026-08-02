import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCoopDir } from "../config.js";

const exec = promisify(execFile);

async function git(args: string[], coopDir?: string): Promise<{ stdout: string; stderr: string }> {
  const dir = coopDir ?? getCoopDir();
  return exec("git", args, { cwd: dir, timeout: 30_000 });
}

export async function getGitRevision(ref = "HEAD", coopDir?: string): Promise<string | null> {
  try {
    const { stdout } = await git(["rev-parse", ref], coopDir);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function isGitWorktreeDirty(coopDir?: string): Promise<boolean> {
  try {
    const { stdout } = await git([
      "status",
      "--porcelain",
      "--",
      "cooperation",
      "logs",
      "config.yaml",
      "policy.yaml",
    ], coopDir);
    return stdout.trim().length > 0;
  } catch {
    // A caller must never mistake an unreadable/non-Git state directory for a
    // clean coordination snapshot.
    return true;
  }
}

export async function isGitWorktreeCompletelyDirty(coopDir?: string): Promise<boolean> {
  try {
    const { stdout } = await git(["status", "--porcelain", "--untracked-files=all"], coopDir);
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .some((line) => {
        const file = line.slice(3).replace(/^"|"$/g, "");
        return !file.startsWith(".agent-coop-runtime/");
      });
  } catch {
    return true;
  }
}

export async function getGitMergeBase(
  leftRevision: string,
  rightRevision: string,
  coopDir?: string,
): Promise<string | null> {
  try {
    const { stdout } = await git(["merge-base", leftRevision, rightRevision], coopDir);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getGitDivergence(
  localRevision: string,
  remoteRevision: string,
  coopDir?: string,
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await git([
    "rev-list",
    "--left-right",
    "--count",
    `${localRevision}...${remoteRevision}`,
  ], coopDir);
  const [aheadText = "0", behindText = "0"] = stdout.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadText, 10) || 0,
    behind: Number.parseInt(behindText, 10) || 0,
  };
}

export async function listAllChangedFiles(
  fromRevision: string,
  toRevision: string,
  coopDir?: string,
): Promise<string[]> {
  const { stdout } = await git(["diff", "--name-only", `${fromRevision}..${toRevision}`], coopDir);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function gitResetHard(revision: string, coopDir?: string): Promise<void> {
  await git(["reset", "--hard", revision], coopDir);
}

export async function listFilesAtRevision(
  revision: string,
  subdir: string,
  coopDir?: string,
): Promise<string[]> {
  const { stdout } = await git(["ls-tree", "-r", "--name-only", revision, "--", subdir], coopDir);
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function readFileAtRevision(
  revision: string,
  relativePath: string,
  coopDir?: string,
): Promise<string> {
  const { stdout } = await git(["show", `${revision}:${relativePath}`], coopDir);
  return stdout;
}

export async function gitFetch(remote = "origin", coopDir?: string): Promise<void> {
  await git(["fetch", "--prune", remote], coopDir);
}

export async function getRemoteBranchRevision(
  remote = "origin",
  branch?: string,
  coopDir?: string,
): Promise<{ branch: string | null; ref: string | null; revision: string | null }> {
  const selectedBranch = branch ?? await getCurrentBranch(coopDir) ?? await getRemoteHeadBranch(remote, coopDir);
  if (!selectedBranch) return { branch: null, ref: null, revision: null };
  const ref = `refs/remotes/${remote}/${selectedBranch}`;
  return { branch: selectedBranch, ref, revision: await getGitRevision(ref, coopDir) };
}

export async function listChangedFiles(
  fromRevision: string,
  toRevision: string,
  coopDir?: string,
): Promise<string[]> {
  try {
    const { stdout } = await git([
      "diff",
      "--name-only",
      `${fromRevision}..${toRevision}`,
      "--",
      "cooperation/tasks",
      "cooperation/messages",
      "cooperation/message-receipts",
      "logs",
      "config.yaml",
      "policy.yaml",
    ], coopDir);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function pickPullBranch(currentBranch: string | null, remoteHeadBranch: string | null): string | null {
  if (currentBranch && currentBranch !== "HEAD") return currentBranch;
  if (remoteHeadBranch) return remoteHeadBranch;
  return null;
}

export function parseRemoteHeadBranch(refOutput: string): string | null {
  // Example: "refs/remotes/origin/main"
  const trimmed = refOutput.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  return parts.at(-1) ?? null;
}

export async function getCurrentBranch(coopDir?: string): Promise<string | null> {
  try {
    const { stdout } = await git(["branch", "--show-current"], coopDir);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function getRemoteHeadBranch(remote: string, coopDir?: string): Promise<string | null> {
  try {
    const { stdout } = await git(["symbolic-ref", `refs/remotes/${remote}/HEAD`], coopDir);
    return parseRemoteHeadBranch(stdout);
  } catch {
    return null;
  }
}

export async function isGitRepo(coopDir?: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--is-inside-work-tree"], coopDir);
    return true;
  } catch {
    return false;
  }
}

export async function gitInit(coopDir?: string): Promise<void> {
  await git(["init"], coopDir);
}

export async function gitAddAndCommit(files: string[], message: string, coopDir?: string): Promise<void> {
  if (files.length === 0) return;
  await git(["add", "--", ...files], coopDir);
  try {
    await git(["diff", "--cached", "--quiet", "--", ...files], coopDir);
    return;
  } catch {}
  // --only prevents pre-staged business changes from leaking into an
  // automatic cooperation commit when agent-coop lives in a business repo.
  await git(["commit", "--no-edit", "-m", message, "--only", "--", ...files], coopDir);
}

export async function gitRemoteAdd(remote: string, url: string, coopDir?: string): Promise<void> {
  try {
    await git(["remote", "add", remote, url], coopDir);
  } catch {
    await git(["remote", "set-url", remote, url], coopDir);
  }
}

export async function gitHasRemote(remote: string, coopDir?: string): Promise<boolean> {
  try {
    const { stdout } = await git(["remote"], coopDir);
    return stdout.split("\n").includes(remote);
  } catch {
    return false;
  }
}

export async function gitPull(remote = "origin", coopDir?: string): Promise<string> {
  try {
    await gitFetch(remote, coopDir);
    const currentBranch = await getCurrentBranch(coopDir);
    const remoteHeadBranch = await getRemoteHeadBranch(remote, coopDir);
    const branch = pickPullBranch(currentBranch, remoteHeadBranch);

    if (!branch) {
      return `Sync skipped: unable to detect local branch or ${remote}/HEAD.`;
    }

    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const { stdout } = await git(["merge", "--ff-only", remoteRef], coopDir);
    return stdout || `Already current with ${remote}/${branch}.`;
  } catch (err: any) {
    return `Sync failed: ${err.message}`;
  }
}

export async function gitPushFastForward(
  remote = "origin",
  branch?: string,
  coopDir?: string,
): Promise<{ pushed: boolean; branch: string | null; revision: string | null; error?: string }> {
  const selectedBranch = branch ?? await getCurrentBranch(coopDir);
  if (!selectedBranch) {
    return { pushed: false, branch: null, revision: null, error: "Unable to determine coordination branch." };
  }

  try {
    await git(["push", remote, `HEAD:${selectedBranch}`], coopDir);
    return {
      pushed: true,
      branch: selectedBranch,
      revision: await getGitRevision("HEAD", coopDir),
    };
  } catch (error) {
    return {
      pushed: false,
      branch: selectedBranch,
      revision: await getGitRevision("HEAD", coopDir),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
