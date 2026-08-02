import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveCoopRoot } from "./context.js";

export interface MemoryBridgeConfig {
  enabled: boolean;
  dir?: string;
}

export interface ChatBridgeConfig {
  enabled: boolean;
  adapter?: "file";
  outboxDir?: string;
}

export interface WorkerHealthConfig {
  enabled: boolean;
  window_minutes: number;
  inactivity_threshold_minutes: number;
  throughput_min: number;
  stale_task_threshold_minutes: number;
  auto_notify: boolean;
  auto_redistribute: boolean;
}

export interface TrustPolicyConfig {
  allowlist_actors?: string[];
  allowed_event_types?: string[];
}

export interface CoopConfig {
  version: string;
  remote?: string;
  agents: string[];
  memoryBridge: MemoryBridgeConfig;
  chatBridge: ChatBridgeConfig;
  workerHealth?: WorkerHealthConfig;
}

const DEFAULT_CONFIG: CoopConfig = {
  version: "0.2.0",
  agents: ["claude-code", "cursor", "codex", "openclaw"],
  memoryBridge: {
    enabled: false,
  },
  chatBridge: {
    enabled: false,
    adapter: "file",
    outboxDir: "chat/outbox",
  },
  workerHealth: {
    enabled: true,
    window_minutes: 120,
    inactivity_threshold_minutes: 180,
    throughput_min: 2,
    stale_task_threshold_minutes: 45,
    auto_notify: true,
    auto_redistribute: false,
  },
};

function normalizeStringList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const deduped = Array.from(
    new Set(
      input
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
        .filter(Boolean),
    ),
  );
  return deduped;
}

export function getCoopDir(): string {
  return resolveCoopRoot();
}

export async function loadConfig(coopDir?: string): Promise<CoopConfig> {
  const dir = coopDir ?? getCoopDir();
  const cfgPath = path.join(dir, "config.yaml");

  try {
    const raw = await fs.readFile(cfgPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<CoopConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      memoryBridge: {
        ...DEFAULT_CONFIG.memoryBridge,
        ...(parsed.memoryBridge ?? {}),
      },
      chatBridge: {
        ...DEFAULT_CONFIG.chatBridge,
        ...(parsed.chatBridge ?? {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// Trust policy 缓存 (5分钟过期)
let _trustPolicyCache: { policy: TrustPolicyConfig | null; expires: number; dir: string } | null = null;
const TRUST_POLICY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function loadTrustPolicy(coopDir?: string, useCache = true): Promise<TrustPolicyConfig | null> {
  const dir = coopDir ?? getCoopDir();
  const policyPath = path.join(dir, "policy.yaml");

  // 使用缓存 (仅当目录匹配时)
  if (useCache && _trustPolicyCache && Date.now() < _trustPolicyCache.expires && _trustPolicyCache.dir === dir) {
    return _trustPolicyCache.policy;
  }

  try {
    const raw = await fs.readFile(policyPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const policy = {
      allowlist_actors: normalizeStringList(parsed?.allowlist_actors),
      allowed_event_types: normalizeStringList(parsed?.allowed_event_types),
    };
    // 更新缓存
    _trustPolicyCache = { policy, expires: Date.now() + TRUST_POLICY_CACHE_TTL, dir };
    return policy;
  } catch {
    return null;
  }
}

/**
 * 清除信任策略缓存 (用于测试或配置更改后)
 */
export function clearTrustPolicyCache(): void {
  _trustPolicyCache = null;
}

export async function saveConfig(config: CoopConfig, coopDir?: string): Promise<void> {
  const dir = coopDir ?? getCoopDir();
  const cfgPath = path.join(dir, "config.yaml");
  await fs.writeFile(cfgPath, stringifyYaml(config), "utf-8");
}

export async function updateWorkerHealthConfig(updates: Partial<WorkerHealthConfig>, coopDir?: string): Promise<CoopConfig> {
  const config = await loadConfig(coopDir);
  const defaultHealth = DEFAULT_CONFIG.workerHealth ?? {
    enabled: true,
    window_minutes: 120,
    inactivity_threshold_minutes: 180,
    throughput_min: 2,
    stale_task_threshold_minutes: 45,
    auto_notify: true,
    auto_redistribute: false,
  };
  config.workerHealth = {
    ...defaultHealth,
    ...config.workerHealth,
    ...updates,
    enabled: updates.enabled ?? config.workerHealth?.enabled ?? defaultHealth.enabled,
  };
  await saveConfig(config, coopDir);
  return config;
}

export function getWorkerHealthConfig(config: CoopConfig): WorkerHealthConfig {
  const defaultHealth = DEFAULT_CONFIG.workerHealth ?? {
    enabled: true,
    window_minutes: 120,
    inactivity_threshold_minutes: 180,
    throughput_min: 2,
    stale_task_threshold_minutes: 45,
    auto_notify: true,
    auto_redistribute: false,
  };
  return {
    enabled: config.workerHealth?.enabled ?? defaultHealth.enabled,
    window_minutes: config.workerHealth?.window_minutes ?? defaultHealth.window_minutes,
    inactivity_threshold_minutes: config.workerHealth?.inactivity_threshold_minutes ?? defaultHealth.inactivity_threshold_minutes,
    throughput_min: config.workerHealth?.throughput_min ?? defaultHealth.throughput_min,
    stale_task_threshold_minutes: config.workerHealth?.stale_task_threshold_minutes ?? defaultHealth.stale_task_threshold_minutes,
    auto_notify: config.workerHealth?.auto_notify ?? defaultHealth.auto_notify,
    auto_redistribute: config.workerHealth?.auto_redistribute ?? defaultHealth.auto_redistribute,
  };
}
