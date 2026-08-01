#!/usr/bin/env node
/**
 * Batch Task Creation Mechanism
 *
 * 实现批量创建策略，根据任务池状态动态调整创建数量
 * - 每次迭代创建 5-10 个任务
 * - 基于任务池状态的触发阈值
 * - 迭代效率判断 (避免无意义迭代)
 * - 预填充机制
 *
 * Usage:
 *   node scripts/batch-task-creation.mjs [--min-tasks N] [--max-tasks N] [--prefill-threshold N]
 */

import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    minTasks: 5,
    maxTasks: 10,
    prefillThreshold: 15,  // 当 open 任务少于这个值时触发预填充
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--min-tasks") args.minTasks = Number(argv[++i]);
    else if (token === "--max-tasks") args.maxTasks = Number(argv[++i]);
    else if (token === "--prefill-threshold") args.prefillThreshold = Number(argv[++i]);
    else if (token === "--dry-run") args.dryRun = true;
  }

  return args;
}

function parseFrontmatterStatus(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const statusLine = match[1]
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("status:"));
  if (!statusLine) return null;
  return statusLine.slice("status:".length).trim();
}

async function getTaskStats(tasksDir) {
  const byStatus = { open: 0, in_progress: 0, done: 0, blocked: 0, cancelled: 0 };
  let totalCount = 0;

  try {
    const files = await readdir(tasksDir, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      totalCount++;
      const raw = await readFile(path.join(tasksDir, entry.name), "utf8");
      const status = parseFrontmatterStatus(raw);
      if (status && Object.hasOwn(byStatus, status)) {
        byStatus[status]++;
      }
    }
  } catch (e) {
    console.error("Error reading tasks dir:", e.message);
  }

  return { byStatus, totalCount };
}

// 扩展任务目录 - 为批量创建添加更多任务模板
const EXTENDED_TASK_TEMPLATES = {
  // A lane - Stability issues (扩展到多个)
  A1: {
    lane: "stability",
    title: "Address current high-priority issues and quality blockers",
    when: "current_issues > 0 or quality gate failed",
  },
  A2: {
    lane: "stability",
    title: "Fix critical defects in recent deployments",
    when: "critical defects detected in audit",
  },
  A3: {
    lane: "stability",
    title: "Resolve worker health alerts",
    when: "worker health check shows degraded performance",
  },
  // B lane - Efficiency (扩展到多个)
  B1: {
    lane: "efficiency",
    title: "Reduce redundant coordination churn",
    when: "quality gate passed and redundancy gain above threshold",
  },
  B2: {
    lane: "efficiency",
    title: "Optimize task assignment latency",
    when: "task claim latency above baseline",
  },
  B3: {
    lane: "efficiency",
    title: "Improve worker load balancing",
    when: "load imbalance detected between workers",
  },
  B4: {
    lane: "efficiency",
    title: "Optimize flywheel iteration frequency",
    when: "iteration frequency too high relative to task completion",
  },
  // C lane - Monitoring & Maintenance
  C1: {
    lane: "maintenance",
    title: "Update system health dashboard",
    when: "monitoring gaps identified",
  },
  C2: {
    lane: "maintenance",
    title: "Clean up stale in-progress tasks",
    when: "stale tasks detected (超过24小时)",
  },
};

function calculateBatchSize(stats, args) {
  const { open, in_progress } = stats.byStatus;
  const total = stats.totalCount;

  // 基础批量大小
  let batchSize = args.minTasks;

  // 如果 open 任务很少，增加批量大小进行预填充
  if (open < args.prefillThreshold) {
    batchSize = args.maxTasks;  // 预填充模式
  }

  // 如果有很多 in_progress 任务，减少创建数量（让 worker 消化）
  if (in_progress > 10) {
    batchSize = Math.max(3, Math.floor(batchSize * 0.5));
  }

  // 如果 total 任务很多，减少创建
  if (total > 200) {
    batchSize = Math.max(3, Math.floor(batchSize * 0.7));
  }

  return Math.min(batchSize, args.maxTasks);
}

// 判断是否应该跳过迭代（效率判断）
function shouldSkipIteration(stats, args) {
  const { open, in_progress, done } = stats.byStatus;

  // 如果没有待完成的任务，跳过
  if (open === 0 && in_progress === 0) {
    return { skip: true, reason: "no_pending_tasks" };
  }

  // 如果 done 任务很少，说明 worker 可能在处理复杂任务，稍后迭代
  if (done < 5 && in_progress > 15) {
    return { skip: true, reason: "workers_busy_with_long_tasks" };
  }

  return { skip: false, reason: null };
}

async function main() {
  const args = parseArgs(process.argv);
  const tasksDir = path.join(process.cwd(), "cooperation/tasks");

  console.log("[BatchTaskCreation] Starting batch task creation analysis...");
  console.log("[BatchTaskCreation] Config:", JSON.stringify(args));

  // 获取任务池状态
  const stats = await getTaskStats(tasksDir);
  console.log("[BatchTaskCreation] Current stats:", JSON.stringify(stats.byStatus));

  // 效率判断：是否应该跳过这次迭代
  const skipCheck = shouldSkipIteration(stats, args);
  if (skipCheck.skip) {
    console.log(`[BatchTaskCreation] Skip iteration: ${skipCheck.reason}`);
    console.log("[BatchTaskCreation] => SKIP");
    return { action: "skip", reason: skipCheck.reason, stats };
  }

  // 计算批量大小
  const batchSize = calculateBatchSize(stats, args);
  console.log(`[BatchTaskCreation] Calculated batch size: ${batchSize}`);

  // 选择任务模板
  const templates = Object.values(EXTENDED_TASK_TEMPLATES);
  const selectedTemplates = templates.slice(0, batchSize);

  console.log(`[BatchTaskCreation] Selected ${selectedTemplates.length} task templates:`);
  selectedTemplates.forEach((t, i) => {
    console.log(`  ${i + 1}. [${t.lane}] ${t.title}`);
  });

  if (args.dryRun) {
    console.log("[BatchTaskCreation] Dry run - no tasks created");
    return { action: "dry_run", batchSize, templates: selectedTemplates, stats };
  }

  // 生成任务创建指令
  const result = {
    action: "create",
    batchSize,
    templates: selectedTemplates,
    stats,
    timestamp: new Date().toISOString(),
  };

  console.log("[BatchTaskCreation] => PROCEED");
  return result;
}

main().then(result => {
  console.log("\n[BatchTaskCreation] Result:", JSON.stringify(result, null, 2));
}).catch(err => {
  console.error("[BatchTaskCreation] Error:", err);
  process.exit(1);
});
