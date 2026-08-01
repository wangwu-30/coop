import * as fs from "node:fs/promises";
import { saveConfig, loadConfig, type CoopConfig, getCoopDir } from "../config.js";
import { ensureDirectoryStructure } from "../storage/fs.js";
import { gitInit, gitRemoteAdd, gitAddAndCommit, isGitRepo } from "../storage/git.js";

export interface InitInput {
  remote?: string;
  enable_memory_bridge?: boolean;
  memory_dir?: string;
  enable_chat_bridge?: boolean;
  chat_outbox_dir?: string;
}

export async function coopInit(input: InitInput): Promise<string> {
  const coopDir = getCoopDir();
  await fs.mkdir(coopDir, { recursive: true });
  await ensureDirectoryStructure(coopDir);

  let configExists = true;
  try {
    await fs.access(`${coopDir}/config.yaml`);
  } catch {
    configExists = false;
  }

  const config: CoopConfig = configExists ? await loadConfig(coopDir) : {
    version: "0.1.0",
    agents: ["claude-code", "cursor", "codex", "openclaw"],
    remote: input.remote,
    memoryBridge: {
      enabled: input.enable_memory_bridge ?? false,
      dir: input.memory_dir,
    },
    chatBridge: {
      enabled: input.enable_chat_bridge ?? false,
      adapter: "file",
      outboxDir: input.chat_outbox_dir,
    },
  };

  let configChanged = !configExists;
  if (input.remote !== undefined && config.remote !== input.remote) {
    config.remote = input.remote;
    configChanged = true;
  }
  if (input.enable_memory_bridge !== undefined && config.memoryBridge.enabled !== input.enable_memory_bridge) {
    config.memoryBridge.enabled = input.enable_memory_bridge;
    configChanged = true;
  }
  if (input.memory_dir !== undefined && config.memoryBridge.dir !== input.memory_dir) {
    config.memoryBridge.dir = input.memory_dir;
    configChanged = true;
  }
  if (input.enable_chat_bridge !== undefined && config.chatBridge.enabled !== input.enable_chat_bridge) {
    config.chatBridge.enabled = input.enable_chat_bridge;
    configChanged = true;
  }
  if (input.chat_outbox_dir !== undefined && config.chatBridge.outboxDir !== input.chat_outbox_dir) {
    config.chatBridge.outboxDir = input.chat_outbox_dir;
    configChanged = true;
  }

  if (configChanged) await saveConfig(config, coopDir);
  if (!(await isGitRepo(coopDir))) await gitInit(coopDir);
  if (input.remote) await gitRemoteAdd("origin", input.remote, coopDir);

  if (configChanged) await gitAddAndCommit(["config.yaml"], "init: initialize agent cooperation", coopDir);
  return `${configExists ? "Reused" : "Initialized"} cooperation repo at ${coopDir}${input.remote ? ` with remote: ${input.remote}` : ""}`;
}
