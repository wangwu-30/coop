import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getCurrentBranch,
  gitHasRemote,
  isGitRepo,
  isGitWorktreeDirty,
} from "../storage/git.js";
import { type AgentClient, defaultServerEntry, managedInstructionMarkers } from "./client-install.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  severity: "error" | "warning";
  detail: string;
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
  } catch {
    return "";
  }
}

export async function runDoctor(input: {
  projectDir: string;
  coopDir: string;
  client?: AgentClient;
  serverEntry?: string;
  remote?: string;
}): Promise<{
  schema: "agent-coop.doctor.v1";
  ok: boolean;
  checks: DoctorCheck[];
}> {
  const projectDir = path.resolve(input.projectDir);
  const coopDir = path.resolve(input.coopDir);
  const serverEntry = path.resolve(input.serverEntry ?? defaultServerEntry());
  const client = input.client ?? "both";
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, severity: DoctorCheck["severity"] = "error") => {
    checks.push({ name, ok, detail, severity });
  };

  add("node_runtime", Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 18, `Node ${process.versions.node}`);
  add("project_directory", await exists(projectDir), projectDir);
  add("server_entry", await exists(serverEntry), serverEntry);
  add("cooperation_directory", await exists(coopDir), coopDir);

  const gitRepo = await isGitRepo(coopDir);
  add("cooperation_git_repo", gitRepo, gitRepo ? coopDir : "Run coop init first.");
  if (gitRepo) {
    const branch = await getCurrentBranch(coopDir);
    add("coordination_branch", Boolean(branch), branch ?? "Detached HEAD is not publishable.");
    const remote = input.remote ?? "origin";
    const hasRemote = await gitHasRemote(remote, coopDir);
    add("coordination_remote", hasRemote, hasRemote ? remote : `Missing remote ${remote}.`);
    const dirty = await isGitWorktreeDirty(coopDir);
    add("canonical_state_clean", !dirty, dirty ? "Commit or reconcile canonical files." : "clean");
  }

  add(
    "cooperation_config",
    await exists(path.join(coopDir, "config.yaml")),
    path.join(coopDir, "config.yaml"),
  );

  if (client === "codex" || client === "both") {
    const config = await readText(path.join(projectDir, ".codex", "config.toml"));
    add("codex_mcp_config", config.includes("[mcp_servers.agent_coop]"), "Expected managed agent_coop MCP entry.");
    const instructions = await readText(path.join(projectDir, "AGENTS.md"));
    add("codex_instructions", instructions.includes(managedInstructionMarkers.start), "Expected managed AGENTS.md protocol.");
  }
  if (client === "claude" || client === "both") {
    const configPath = path.join(projectDir, ".mcp.json");
    let hasServer = false;
    try {
      const parsed = JSON.parse(await readText(configPath)) as { mcpServers?: Record<string, unknown> };
      hasServer = Boolean(parsed.mcpServers?.["agent-coop"]);
    } catch {}
    add("claude_mcp_config", hasServer, "Expected agent-coop entry in .mcp.json.");
    const instructions = await readText(path.join(projectDir, "CLAUDE.md"));
    add("claude_instructions", instructions.includes(managedInstructionMarkers.start), "Expected managed CLAUDE.md protocol.");
  }

  return {
    schema: "agent-coop.doctor.v1",
    ok: checks.every((check) => check.ok || check.severity === "warning"),
    checks,
  };
}
