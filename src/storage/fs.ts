import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getCoopDir } from "../config.js";

const DIRS = ["cooperation/tasks", "cooperation/messages", "cooperation/message-receipts"];

export function resolveSafePath(baseDir: string, relativePath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, relativePath);
  const relative = path.relative(resolvedBase, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path outside cooperation directory: ${relativePath}`);
  }
  return target;
}

export async function ensureDirectoryStructure(coopDir?: string): Promise<void> {
  const dir = coopDir ?? getCoopDir();
  for (const sub of DIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
}

export async function writeFile(relativePath: string, content: string, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  const fullPath = resolveSafePath(dir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const temporaryPath = `${fullPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, "utf-8");
    await fs.rename(temporaryPath, fullPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return fullPath;
}

export async function removeFile(relativePath: string, coopDir?: string): Promise<void> {
  const dir = coopDir ?? getCoopDir();
  await fs.unlink(resolveSafePath(dir, relativePath)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function fileExists(relativePath: string, coopDir?: string): Promise<boolean> {
  const dir = coopDir ?? getCoopDir();
  try {
    await fs.access(resolveSafePath(dir, relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function withMutationLock<T>(
  key: string,
  operation: () => Promise<T>,
  coopDir?: string,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const dir = coopDir ?? getCoopDir();
  const timeoutMs = options.timeoutMs ?? 5_000;
  const staleMs = options.staleMs ?? 60_000;
  const lockName = createHash("sha256").update(key).digest("hex");
  const lockDir = path.join(dir, ".agent-coop-runtime", "locks");
  const lockPath = path.join(lockDir, `${lockName}.lock`);
  const startedAt = Date.now();

  await fs.mkdir(lockDir, { recursive: true });

  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, key, created_at: new Date().toISOString() }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for cooperation mutation lock: ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Serialize every mutation that can create a Git commit in one cooperation
 * checkout. Per-task locks protect domain versions, but Git's index and HEAD
 * are repository-wide resources, so different tasks must not commit at the
 * same time either.
 */
export function withCanonicalMutationLock<T>(
  operation: () => Promise<T>,
  coopDir?: string,
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  return withMutationLock("canonical-git-state", operation, coopDir, options);
}

export async function readFile(relativePath: string, coopDir?: string): Promise<string> {
  const dir = coopDir ?? getCoopDir();
  return fs.readFile(resolveSafePath(dir, relativePath), "utf-8");
}

export async function listFiles(subdir: string, coopDir?: string): Promise<string[]> {
  const dir = coopDir ?? getCoopDir();
  const fullDir = resolveSafePath(dir, subdir);
  try {
    const entries = await fs.readdir(fullDir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => {
        const parent = e.parentPath ?? e.path;
        return path.relative(dir, path.join(parent, e.name));
      });
  } catch {
    return [];
  }
}

export async function listFilesWithSuffix(
  subdir: string,
  suffix: string,
  coopDir?: string,
): Promise<string[]> {
  const dir = coopDir ?? getCoopDir();
  const fullDir = resolveSafePath(dir, subdir);
  try {
    const entries = await fs.readdir(fullDir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => {
        const parent = entry.parentPath ?? entry.path;
        return path.relative(dir, path.join(parent, entry.name));
      });
  } catch {
    return [];
  }
}

export async function listCoopFiles(kind: "tasks" | "messages", coopDir?: string): Promise<string[]> {
  return listFiles(`cooperation/${kind}`, coopDir);
}
