#!/usr/bin/env node
/**
 * 任务状态查询脚本
 * 查询 cooperation/tasks 目录下的任务状态
 *
 * 用法: node scripts/query-task-status.js [status]
 *
 * 示例:
 *   node scripts/query-task-status.js           # 查询所有任务
 *   node scripts/query-task-status.js open       # 只查询 open 状态的任务
 *   node scripts/query-task-status.js in_progress
 *   node scripts/query-task-status.js done
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = path.join(__dirname, '..', 'cooperation', 'tasks');

// 解析 YAML frontmatter
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // 处理 YAML 布尔值和引号字符串
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  return frontmatter;
}

// 解析任务文件
function parseTaskFile(filename) {
  const filepath = path.join(TASKS_DIR, filename);
  const content = fs.readFileSync(filepath, 'utf-8');
  const frontmatter = parseFrontmatter(content);

  // 提取标题
  const titleMatch = content.match(/^#\s+(.+)$/m);

  return {
    id: filename.replace('.md', ''),
    title: titleMatch ? titleMatch[1] : 'Untitled',
    ...frontmatter
  };
}

// 获取所有任务
function getAllTasks() {
  if (!fs.existsSync(TASKS_DIR)) {
    console.error('Tasks directory not found:', TASKS_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.md'));
  return files.map(parseTaskFile);
}

// 过滤任务
function filterTasks(tasks, status) {
  if (!status) return tasks;
  return tasks.filter(t => t.status === status);
}

// 主函数
function main() {
  const statusFilter = process.argv[2];
  const tasks = getAllTasks();
  const filtered = filterTasks(tasks, statusFilter);

  if (filtered.length === 0) {
    console.log(`No tasks found${statusFilter ? ` with status "${statusFilter}"` : ''}.`);
    return;
  }

  console.log(`\n=== Tasks${statusFilter ? ` (status: ${statusFilter})` : ''} ===\n`);

  for (const task of filtered) {
    console.log(`📋 ${task.id}`);
    console.log(`   Title: ${task.title}`);
    console.log(`   Status: ${task.status || 'unknown'}`);
    console.log(`   Assignee: ${task.assignee || 'unassigned'}`);
    if (task.created_at) console.log(`   Created: ${task.created_at}`);
    if (task.updated_at) console.log(`   Updated: ${task.updated_at}`);
    if (task.depends_on) console.log(`   Depends on: ${task.depends_on}`);
    console.log('');
  }

  // 统计
  const stats = {
    open: tasks.filter(t => t.status === 'open').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    total: tasks.length
  };

  console.log('--- Summary ---');
  console.log(`Open: ${stats.open} | In Progress: ${stats.in_progress} | Done: ${stats.done} | Blocked: ${stats.blocked}`);
  console.log(`Total: ${stats.total}`);
}

main();
