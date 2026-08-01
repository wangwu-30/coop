#!/usr/bin/env node
/**
 * Worker Health Report Automation
 *
 * Generates periodic health reports for all workers.
 * Can be run as a cron job or triggered manually.
 *
 * Usage:
 *   node scripts/worker-health-report.ts          # Generate report now
 *   node scripts/worker-health-report.ts --watch  # Watch mode (periodic)
 *
 * Output:
 *   - Console: Human-readable health summary
 *   - JSON: Machine-readable report at cooperation/runtime/worker-health-report.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import path from "node:path";

const WORK_DIR = process.cwd();
const RUNTIME_DIR = path.join(WORK_DIR, "cooperation", "runtime");
const LOGS_DIR = path.join(WORK_DIR, "cooperation", "logs");
const CONFIG_PATH = path.join(WORK_DIR, "config.yaml");

interface WorkerHealth {
  worker_id: string;
  status: string;
  throughput_signals: number;
  last_activity_at: string | null;
  last_activity_ago_minutes: number | null;
  inactive_reason: string | null;
}

interface HealthReport {
  generated_at: string;
  total_workers: number;
  active_workers: number;
  inactive_workers: number;
  active_worker_ids: string[];
  inactive_worker_ids: string[];
  workers: WorkerHealth[];
  summary: string;
}

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return parseYaml(raw);
  } catch {
    return {};
  }
}

async function getTodayEvents(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const eventFile = path.join(LOGS_DIR, `events-${today}.jsonl`);

  try {
    const content = await readFile(eventFile, "utf-8");
    return content.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function parseActivityFromEvents(events: string[]): Map<string, number> {
  const workerActivity = new Map<string, number>();
  const now = new Date();

  for (const line of events) {
    try {
      const event = JSON.parse(line);
      const eventType = event.event_type;

      // Count throughput signals (claim_task, done_task)
      if (eventType === "claim_task" || eventType === "done_task") {
        const actor = event.actor || event.payload?.actor;
        if (actor && actor.startsWith("coop-worker")) {
          const current = workerActivity.get(actor) || 0;
          workerActivity.set(actor, current + 1);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return workerActivity;
}

function getWorkerIds(): string[] {
  // Known workers from the coop system
  return ["coop-worker-1", "coop-worker-2", "coop-worker-3"];
}

async function generateReport(): Promise<HealthReport> {
  const now = new Date();
  const events = await getTodayEvents();
  const activity = parseActivityFromEvents(events);
  const config = await loadConfig();

  const healthConfig = config?.workerHealth || {};
  const throughputMin = healthConfig.throughput_min || 1;
  const inactivityThreshold = healthConfig.inactivity_threshold_minutes || 45;

  const workers: WorkerHealth[] = [];
  const activeWorkerIds: string[] = [];
  const inactiveWorkerIds: string[] = [];

  for (const workerId of getWorkerIds()) {
    const signals = activity.get(workerId) || 0;
    const isActive = signals >= throughputMin;

    const worker: WorkerHealth = {
      worker_id: workerId,
      status: isActive ? "active" : "inactive",
      throughput_signals: signals,
      last_activity_at: null,
      last_activity_ago_minutes: null,
      inactive_reason: isActive ? null : `throughput_below_min (${signals} < ${throughputMin})`
    };

    workers.push(worker);

    if (isActive) {
      activeWorkerIds.push(workerId);
    } else {
      inactiveWorkerIds.push(workerId);
    }
  }

  const activeCount = activeWorkerIds.length;
  const inactiveCount = inactiveWorkerIds.length;

  const summary = inactiveCount === 0
    ? "所有 Worker 活跃"
    : `${inactiveCount} 个 Worker 不活跃: ${inactiveWorkerIds.join(", ")}`;

  const report: HealthReport = {
    generated_at: now.toISOString(),
    total_workers: workers.length,
    active_workers: activeCount,
    inactive_workers: inactiveCount,
    active_worker_ids: activeWorkerIds,
    inactive_worker_ids: inactiveWorkerIds,
    workers,
    summary
  };

  return report;
}

function formatReport(report: HealthReport): string {
  const lines = [
    "=".repeat(50),
    "       Worker Health Report",
    "=".repeat(50),
    `生成时间: ${new Date(report.generated_at).toLocaleString("zh-CN")}`,
    "",
    `总计 Workers: ${report.total_workers}`,
    `活跃: ${report.active_workers} (${report.active_worker_ids.join(", ") || "无"})`,
    `不活跃: ${report.inactive_workers} (${report.inactive_worker_ids.join(", ") || "无"})`,
    "",
    "详细状态:",
    "-".repeat(50),
  ];

  for (const w of report.workers) {
    const statusIcon = w.status === "active" ? "✅" : "❌";
    lines.push(`  ${statusIcon} ${w.worker_id}: ${w.status}`);
    lines.push(`      信号数: ${w.throughput_signals}`);
    if (w.inactive_reason) {
      lines.push(`      原因: ${w.inactive_reason}`);
    }
  }

  lines.push("");
  lines.push("摘要: " + report.summary);
  lines.push("=".repeat(50));

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes("--watch") || args.includes("-w");

  // Ensure runtime directory exists
  if (!existsSync(RUNTIME_DIR)) {
    await mkdir(RUNTIME_DIR, { recursive: true });
  }

  const generate = async () => {
    console.log("\n🔄 生成 Worker 健康报告...\n");

    const report = await generateReport();

    // Save JSON report
    const jsonPath = path.join(RUNTIME_DIR, "worker-health-report.json");
    await writeFile(jsonPath, JSON.stringify(report, null, 2));

    // Print human-readable report
    console.log(formatReport(report));
    console.log(`\n📄 JSON报告已保存: ${jsonPath}`);

    return report;
  };

  if (watchMode) {
    console.log("🔁 开启监控模式，每60分钟生成一次报告...");
    console.log("按 Ctrl+C 停止\n");

    await generate();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
      await generate();
    }
  } else {
    await generate();
  }
}

main().catch(console.error);
