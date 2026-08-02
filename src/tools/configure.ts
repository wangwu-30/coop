import { getCoopDir, loadConfig, saveConfig } from "../config.js";
import { gitAddAndCommit } from "../storage/git.js";
import { appendEventLog, trustPolicyErrorToResult } from "../storage/events.js";
import { withCanonicalMutationLock } from "../storage/fs.js";


export async function coopConfigureMemory(input: {
  enabled: boolean;
  dir?: string;
}): Promise<string> {
  const coopDir = getCoopDir();
  return withCanonicalMutationLock(async () => {
    const config = await loadConfig(coopDir);

    config.memoryBridge = {
      enabled: input.enabled,
      dir: input.dir,
    };

    await saveConfig(config, coopDir);

    let eventLogPath: string;
    try {
      eventLogPath = await appendEventLog({
        event_type: "configure_memory",
        actor: "system",
        payload: {
          enabled: input.enabled,
          dir: input.dir,
        },
      }, coopDir);
    } catch (error) {
      const policyError = trustPolicyErrorToResult(error);
      if (policyError) return policyError;
      throw error;
    }

    await gitAddAndCommit(["config.yaml", eventLogPath], `coop: configure memory bridge (${input.enabled ? "enable" : "disable"})`, coopDir);

    return JSON.stringify({
      memory_bridge: config.memoryBridge,
      note: "Memory bridge is optional and does not replace git as source-of-truth.",
    });
  }, coopDir);
}
