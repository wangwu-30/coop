#!/usr/bin/env node
/**
 * Quality Gate Automation Script
 *
 * 自动化质量门禁检查：
 * 1. 运行 frontmatter 验证
 * 2. 运行测试检查
 * 3. 检查审计事件
 * 4. 生成质量报告和趋势分析
 * 5. 阈值告警
 *
 * 使用: node scripts/quality-gate-automation.mjs [--json] [--alerts-only]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TASKS_DIR = path.join(ROOT, 'cooperation', 'tasks');
const RUNTIME_DIR = path.join(ROOT, '.agent-coop', 'runtime');

// 质量阈值配置
const THRESHOLDS = {
  frontmatterErrors: { warning: 10, critical: 50 },
  testFailures: { warning: 0, critical: 1 },
  auditErrors: { warning: 10, critical: 50 },
  staleTasksHours: { warning: 48, critical: 72 }
};

// 质量历史记录文件
const QUALITY_HISTORY_FILE = path.join(RUNTIME_DIR, 'quality-gate-history.json');

function parseArgs(argv) {
  const out = { json: false, alertsOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    if (a === '--alerts-only') out.alertsOnly = true;
  }
  return out;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  try {
    return parseYaml(m[1]) || {};
  } catch {
    return {};
  }
}

function loadTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md'));
  return files.map((filename) => {
    const full = path.join(TASKS_DIR, filename);
    const content = fs.readFileSync(full, 'utf8');
    const fm = parseFrontmatter(content);
    return {
      id: filename.replace('.md', ''),
      status: fm.status,
      priority: fm.priority,
      assignee: fm.assignee,
      updated: fm.updated,
      created: fm.created,
      version: fm.version,
      tags: fm.tags,
      depends_on: fm.depends_on,
      created_by: fm.created_by,
    };
  });
}

function validateFrontmatter(tasks) {
  const errors = [];
  const requiredFields = ['status', 'priority', 'created_by', 'assignee', 'created', 'updated', 'depends_on', 'version', 'tags'];

  for (const task of tasks) {
    for (const field of requiredFields) {
      if (task[field] === undefined || task[field] === null) {
        errors.push({ task: task.id, error: `missing required field: ${field}` });
      }
    }
    // 检查字段类型
    if (task.depends_on !== null && task.depends_on !== undefined && !Array.isArray(task.depends_on)) {
      errors.push({ task: task.id, error: 'depends_on must be an array' });
    }
    if (task.tags !== null && task.tags !== undefined && !Array.isArray(task.tags)) {
      errors.push({ task: task.id, error: 'tags must be an array' });
    }
    if (task.version !== null && task.version !== undefined && typeof task.version !== 'number') {
      errors.push({ task: task.id, error: 'version must be a number' });
    }
  }
  return errors;
}

function getTaskStats(tasks) {
  const stats = { open: 0, in_progress: 0, done: 0, blocked: 0 };
  for (const task of tasks) {
    const status = task.status || 'open';
    if (stats[status] !== undefined) {
      stats[status]++;
    }
  }
  return stats;
}

function findStaleTasks(tasks, thresholdHours) {
  const now = Date.now();
  const stale = [];
  const thresholdMs = thresholdHours * 3600000;

  for (const task of tasks) {
    if (task.status === 'in_progress' && task.updated) {
      const updated = Date.parse(task.updated);
      if (now - updated > thresholdMs) {
        stale.push({
          id: task.id,
          hoursStale: Math.round((now - updated) / 3600000),
          updated: task.updated
        });
      }
    }
  }
  return stale;
}

function checkThresholds(results) {
  const alerts = [];

  // Frontmatter errors
  if (results.frontmatterErrors > THRESHOLDS.frontmatterErrors.critical) {
    alerts.push({ level: 'critical', type: 'frontmatter', message: `${results.frontmatterErrors} 个 frontmatter 错误 (超过临界值 ${THRESHOLDS.frontmatterErrors.critical})` });
  } else if (results.frontmatterErrors > THRESHOLDS.frontmatterErrors.warning) {
    alerts.push({ level: 'warning', type: 'frontmatter', message: `${results.frontmatterErrors} 个 frontmatter 错误 (超过警告值 ${THRESHOLDS.frontmatterErrors.warning})` });
  }

  // Test failures
  if (results.testFailures > THRESHOLDS.testFailures.critical) {
    alerts.push({ level: 'critical', type: 'tests', message: `${results.testFailures} 个测试失败 (超过临界值 ${THRESHOLDS.testFailures.critical})` });
  } else if (results.testFailures > THRESHOLDS.testFailures.warning) {
    alerts.push({ level: 'warning', type: 'tests', message: `${results.testFailures} 个测试失败 (超过警告值 ${THRESHOLDS.testFailures.warning})` });
  }

  // Stale tasks
  if (results.staleTasks.length > 0) {
    const criticalStale = results.staleTasks.filter(t => t.hoursStale > THRESHOLDS.staleTasksHours.critical);
    const warningStale = results.staleTasks.filter(t => t.hoursStale > THRESHOLDS.staleTasksHours.warning && t.hoursStale <= THRESHOLDS.staleTasksHours.critical);

    if (criticalStale.length > 0) {
      alerts.push({ level: 'critical', type: 'stale', message: `${criticalStale.length} 个任务停滞超过 ${THRESHOLDS.staleTasksHours.critical} 小时` });
    }
    if (warningStale.length > 0) {
      alerts.push({ level: 'warning', type: 'stale', message: `${warningStale.length} 个任务停滞超过 ${THRESHOLDS.staleTasksHours.warning} 小时` });
    }
  }

  return alerts;
}

function loadQualityHistory() {
  if (!fs.existsSync(QUALITY_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(QUALITY_HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveQualityHistory(history) {
  // 只保留最近30条记录
  const trimmed = history.slice(-30);
  fs.writeFileSync(QUALITY_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
}

function runQualityChecks() {
  console.log('🔍 Running quality gate checks...\n');

  const tasks = loadTasks();
  const stats = getTaskStats(tasks);

  // Frontmatter 验证
  console.log('📋 Checking frontmatter validation...');
  const frontmatterErrors = validateFrontmatter(tasks);
  console.log(`   Found ${frontmatterErrors.length} frontmatter errors`);

  // 测试检查 (简单运行 test 并捕获结果)
  console.log('🧪 Checking tests...');
  let testFailures = 0;
  let testOutput = '';
  try {
    testOutput = execSync('npm run test 2>&1', {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000
    });
    // 检查是否有失败
    const failedMatch = testOutput.match(/(\d+) failed/);
    if (failedMatch) {
      testFailures = parseInt(failedMatch[1], 10);
    }
  } catch (e) {
    testOutput = e.stdout || e.message;
    const failedMatch = testOutput.match(/(\d+) failed/);
    if (failedMatch) {
      testFailures = parseInt(failedMatch[1], 10);
    }
  }
  console.log(`   Found ${testFailures} test failures`);

  // 检查停滞任务
  console.log('⏰ Checking stale tasks...');
  const staleTasks = findStaleTasks(tasks, THRESHOLDS.staleTasksHours.warning);
  console.log(`   Found ${staleTasks.length} stale in-progress tasks`);

  // 生成结果
  const results = {
    timestamp: new Date().toISOString(),
    taskStats: stats,
    totalTasks: tasks.length,
    frontmatterErrors: frontmatterErrors.length,
    frontmatterErrorDetails: frontmatterErrors.slice(0, 10), // 只保留前10个详情
    testFailures,
    staleTasks: staleTasks.length,
    staleTaskDetails: staleTasks.slice(0, 5),
    alerts: [],
    passed: false
  };

  // 检查阈值
  results.alerts = checkThresholds(results);

  // 质量门禁通过条件
  results.passed = results.frontmatterErrors === 0 &&
                   results.testFailures === 0 &&
                   results.alerts.filter(a => a.level === 'critical').length === 0;

  // 保存到历史
  const history = loadQualityHistory();
  history.push({
    timestamp: results.timestamp,
    frontmatterErrors: results.frontmatterErrors,
    testFailures: results.testFailures,
    staleTasks: results.staleTasks,
    passed: results.passed
  });
  saveQualityHistory(history);

  return results;
}

function formatReport(results) {
  const lines = [];
  lines.push('═══════════════════════════════════════');
  lines.push('     质量门禁检查报告');
  lines.push('═══════════════════════════════════════');
  lines.push(`生成时间: ${results.timestamp}`);
  lines.push('');

  // 任务统计
  lines.push('📊 任务统计:');
  lines.push(`   开放: ${results.taskStats.open}`);
  lines.push(`   进行中: ${results.taskStats.in_progress}`);
  lines.push(`   已完成: ${results.taskStats.done}`);
  lines.push(`   阻塞: ${results.taskStats.blocked}`);
  lines.push(`   总计: ${results.totalTasks}`);
  lines.push('');

  // 质量指标
  lines.push('🔍 质量指标:');
  lines.push(`   Frontmatter 错误: ${results.frontmatterErrors} ${results.frontmatterErrors > 0 ? '❌' : '✅'}`);
  lines.push(`   测试失败: ${results.testFailures} ${results.testFailures > 0 ? '❌' : '✅'}`);
  lines.push(`   停滞任务: ${results.staleTasks} ${results.staleTasks > 0 ? '⚠️' : '✅'}`);
  lines.push('');

  // 告警
  if (results.alerts.length > 0) {
    lines.push('⚠️ 告警:');
    for (const alert of results.alerts) {
      const icon = alert.level === 'critical' ? '🔴' : '🟡';
      lines.push(`   ${icon} [${alert.level.toUpperCase()}] ${alert.message}`);
    }
    lines.push('');
  }

  // 总体状态
  lines.push('═══════════════════════════════════════');
  lines.push(`总体状态: ${results.passed ? '✅ 通过' : '❌ 未通过'}`);
  lines.push('═══════════════════════════════════════');

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);

  // 确保运行时目录存在
  if (!fs.existsSync(RUNTIME_DIR)) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  const results = runQualityChecks();

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else if (args.alertsOnly) {
    if (results.alerts.length > 0) {
      console.log(JSON.stringify(results.alerts, null, 2));
    } else {
      console.log('No alerts');
    }
  } else {
    const report = formatReport(results);
    console.log(report);

    // 保存质量门禁状态快照
    const statusFile = path.join(RUNTIME_DIR, 'quality-gate-status.json');
    fs.writeFileSync(statusFile, JSON.stringify(results, null, 2));
    console.log(`\n📁 状态已保存到: ${statusFile}`);
  }

  // 返回退出码
  process.exit(results.passed ? 0 : 1);
}

main();
