import * as path from "node:path";

export interface CoopContext {
  rootDir: string;
  tasksDir: string;
  messagesDir: string;
  messageReceiptsDir: string;
  logsDir: string;
  runtimeDir: string;
  observerStateDir: string;
}

export interface CoopContextInput {
  rootDir?: string;
  cwd?: string;
}

/**
 * Resolve the one canonical cooperation root for the current process.
 *
 * AGENT_COOP_DIR is the explicit deployment override. When it is absent, the
 * current working directory is the root. Falling back to a home-directory
 * repository made the observer and MCP tools silently operate on different
 * task pools, so there is intentionally no HOME fallback here.
 */
export function resolveCoopRoot(input: CoopContextInput = {}): string {
  const configured = input.rootDir ?? process.env.AGENT_COOP_DIR;
  return path.resolve(configured ?? input.cwd ?? process.cwd());
}

export function createCoopContext(input: CoopContextInput = {}): CoopContext {
  const rootDir = resolveCoopRoot(input);
  return {
    rootDir,
    tasksDir: path.join(rootDir, "cooperation", "tasks"),
    messagesDir: path.join(rootDir, "cooperation", "messages"),
    messageReceiptsDir: path.join(rootDir, "cooperation", "message-receipts"),
    logsDir: path.join(rootDir, "logs"),
    runtimeDir: path.join(rootDir, ".agent-coop-runtime"),
    observerStateDir: path.join(rootDir, "coop-min", "state"),
  };
}
