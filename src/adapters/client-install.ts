import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentClient = "codex" | "claude" | "both";

export interface InstallClientInput {
  client: AgentClient;
  projectDir: string;
  coopDir: string;
  serverEntry?: string;
  codexAgentId?: string;
  claudeAgentId?: string;
  dryRun?: boolean;
}

export interface InstalledFile {
  path: string;
  action: "created" | "updated" | "unchanged" | "planned";
}

const CODEX_CONFIG_START = "# >>> agent-coop managed config";
const CODEX_CONFIG_END = "# <<< agent-coop managed config";
const INSTRUCTIONS_START = "<!-- >>> agent-coop managed instructions -->";
const INSTRUCTIONS_END = "<!-- <<< agent-coop managed instructions -->";

export function defaultServerEntry(): string {
  return fileURLToPath(new URL("../index.js", import.meta.url));
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readText(target: string): Promise<string> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function replaceManagedBlock(
  current: string,
  startMarker: string,
  endMarker: string,
  body: string,
): string {
  const start = current.indexOf(startMarker);
  const end = current.indexOf(endMarker);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    throw new Error(`Malformed managed block: ${startMarker}`);
  }

  const block = `${startMarker}\n${body.trim()}\n${endMarker}`;
  if (start >= 0) {
    const after = end + endMarker.length;
    return `${current.slice(0, start)}${block}${current.slice(after)}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  }

  const prefix = current.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${block}\n`;
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, target);
}

async function planWrite(target: string, content: string, dryRun: boolean): Promise<InstalledFile> {
  const current = await readText(target);
  if (current === content) return { path: target, action: "unchanged" };
  if (dryRun) return { path: target, action: "planned" };
  await writeAtomic(target, content);
  return { path: target, action: current ? "updated" : "created" };
}

function behaviorInstructions(agentId: string): string {
  return [
    "## Agent cooperation protocol",
    "",
    `Your stable cooperation identity is \`${agentId}\`.`,
    "",
    "- At session start call `coop_sync`, `coop_check_inbox`, `coop_get_global_state`, then `coop_list_tasks`.",
    "- Read the selected task and claim it with `expected_version`; immediately call `coop_publish_state`.",
    "- Do not start business work unless publication returns `pushed=true`.",
    "- After every task/message mutation, publish immediately.",
    "- On `remote_conflict`, call `coop_reconcile` in inspect mode. Discard only a cooperation-only candidate with the observed local revision, then re-read state and retry the decision.",
    "- Use messages for blocking questions, review and handoff. Messages never grant task ownership; acknowledge actionable messages explicitly.",
    "- Git is the source of truth. Never silently rebase or overwrite canonical cooperation state.",
  ].join("\n");
}

async function installCodex(input: {
  projectDir: string;
  coopDir: string;
  serverEntry: string;
  agentId: string;
  dryRun: boolean;
}): Promise<InstalledFile[]> {
  const configPath = path.join(input.projectDir, ".codex", "config.toml");
  const currentConfig = await readText(configPath);
  const withoutManagedBlock = currentConfig.replace(
    new RegExp(`${CODEX_CONFIG_START}[\\s\\S]*?${CODEX_CONFIG_END}`, "g"),
    "",
  );
  if (/\[mcp_servers\.(agent-coop|agent_coop)\]/.test(withoutManagedBlock)) {
    throw new Error(`Codex config already defines agent-coop outside the managed block: ${configPath}`);
  }
  const configBody = [
    "[mcp_servers.agent_coop]",
    "command = \"node\"",
    `args = [${tomlString(input.serverEntry)}]`,
    `env = { AGENT_COOP_DIR = ${tomlString(input.coopDir)}, AGENT_COOP_AGENT_ID = ${tomlString(input.agentId)} }`,
    "required = true",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60",
  ].join("\n");
  const nextConfig = replaceManagedBlock(currentConfig, CODEX_CONFIG_START, CODEX_CONFIG_END, configBody);

  const instructionsPath = path.join(input.projectDir, "AGENTS.md");
  const nextInstructions = replaceManagedBlock(
    await readText(instructionsPath),
    INSTRUCTIONS_START,
    INSTRUCTIONS_END,
    behaviorInstructions(input.agentId),
  );
  return Promise.all([
    planWrite(configPath, nextConfig, input.dryRun),
    planWrite(instructionsPath, nextInstructions, input.dryRun),
  ]);
}

async function installClaude(input: {
  projectDir: string;
  coopDir: string;
  serverEntry: string;
  agentId: string;
  dryRun: boolean;
}): Promise<InstalledFile[]> {
  const configPath = path.join(input.projectDir, ".mcp.json");
  const current = await readText(configPath);
  let parsed: Record<string, unknown> = {};
  if (current.trim()) {
    try {
      parsed = JSON.parse(current) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot update invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const existingServers = parsed.mcpServers;
  if (existingServers !== undefined && (typeof existingServers !== "object" || existingServers === null || Array.isArray(existingServers))) {
    throw new Error(`mcpServers must be an object in ${configPath}`);
  }
  const mcpServers = { ...(existingServers as Record<string, unknown> | undefined) };
  mcpServers["agent-coop"] = {
    type: "stdio",
    command: "node",
    args: [input.serverEntry],
    env: {
      AGENT_COOP_DIR: input.coopDir,
      AGENT_COOP_AGENT_ID: input.agentId,
    },
  };
  const nextConfig = `${JSON.stringify({ ...parsed, mcpServers }, null, 2)}\n`;

  const instructionsPath = path.join(input.projectDir, "CLAUDE.md");
  const nextInstructions = replaceManagedBlock(
    await readText(instructionsPath),
    INSTRUCTIONS_START,
    INSTRUCTIONS_END,
    behaviorInstructions(input.agentId),
  );
  return Promise.all([
    planWrite(configPath, nextConfig, input.dryRun),
    planWrite(instructionsPath, nextInstructions, input.dryRun),
  ]);
}

export async function installClientAdapters(input: InstallClientInput): Promise<{
  installed: true;
  client: AgentClient;
  project_dir: string;
  coop_dir: string;
  server_entry: string;
  files: InstalledFile[];
  warnings: string[];
}> {
  const projectDir = path.resolve(input.projectDir);
  const coopDir = path.resolve(input.coopDir);
  const serverEntry = path.resolve(input.serverEntry ?? defaultServerEntry());
  if (!(await exists(projectDir))) throw new Error(`Project directory does not exist: ${projectDir}`);
  if (!(await exists(coopDir))) throw new Error(`Cooperation directory does not exist: ${coopDir}`);
  if (!(await exists(serverEntry))) throw new Error(`Built MCP server entry does not exist: ${serverEntry}`);

  const files: InstalledFile[] = [];
  if (input.client === "codex" || input.client === "both") {
    files.push(...await installCodex({
      projectDir,
      coopDir,
      serverEntry,
      agentId: input.codexAgentId ?? "codex",
      dryRun: input.dryRun ?? false,
    }));
  }
  if (input.client === "claude" || input.client === "both") {
    files.push(...await installClaude({
      projectDir,
      coopDir,
      serverEntry,
      agentId: input.claudeAgentId ?? "claude-code",
      dryRun: input.dryRun ?? false,
    }));
  }

  return {
    installed: true,
    client: input.client,
    project_dir: projectDir,
    coop_dir: coopDir,
    server_entry: serverEntry,
    files,
    warnings: [
      "Generated MCP paths are machine-local; rerun install on each developer machine.",
      "Claude Code requires explicit approval for project-scoped .mcp.json servers.",
    ],
  };
}

export const managedInstructionMarkers = {
  start: INSTRUCTIONS_START,
  end: INSTRUCTIONS_END,
};
