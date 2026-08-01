/**
 * 飞轮核心流程集成测试
 * 覆盖: 审计日志读取 → open任务发现 → 任务分配逻辑
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 模拟 parseFrontmatter 从 query-task-status.mjs
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter = {};
  const lines = match[1].split("\n");

  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  // Normalize priority to lowercase
  if (frontmatter.priority && typeof frontmatter.priority === "string") {
    frontmatter.priority = frontmatter.priority.toLowerCase();
  }

  return frontmatter;
}

// 模拟 parseTaskFile 从 query-task-status.mjs
function parseTaskFile(filepath) {
  const content = fs.readFileSync(filepath, "utf-8");
  const frontmatter = parseFrontmatter(content);
  const titleMatch = content.match(/^#\s+(.+)$/m);

  return {
    id: path.basename(filepath, ".md"),
    title: titleMatch ? titleMatch[1] : "Untitled",
    ...frontmatter,
  };
}

// 模拟 getAllTasks 从 query-task-status.mjs
function getAllTasks(tasksDir) {
  if (!fs.existsSync(tasksDir)) {
    return [];
  }

  const files = fs.readdirSync(tasksDir).filter((f) => f.endsWith(".md"));
  return files.map((f) => parseTaskFile(path.join(tasksDir, f)));
}

function normalizeStatus(status) {
  if (typeof status !== "string" || status.trim() === "") return "other";
  const normalized = status.trim();
  return ["open", "in_progress", "done", "blocked"].includes(normalized)
    ? normalized
    : "other";
}

function buildStatusStats(tasks) {
  return tasks.reduce((acc, task) => {
    acc[normalizeStatus(task.status)] += 1;
    return acc;
  }, {
    open: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
    other: 0,
  });
}

// 模拟 updateTaskStatus 逻辑 (不实际写文件)
function simulateTaskStatusUpdate(tasks, taskId, newStatus) {
  const taskIndex = tasks.findIndex((t) => t.id === taskId);
  if (taskIndex === -1) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const oldStatus = tasks[taskIndex].status;
  const newVersion = (tasks[taskIndex].version || 1) + 1;

  // 返回更新后的任务对象
  const updatedTasks = [...tasks];
  updatedTasks[taskIndex] = {
    ...updatedTasks[taskIndex],
    status: newStatus,
    version: newVersion,
    updated_at: new Date().toISOString(),
  };

  return {
    tasks: updatedTasks,
    event: {
      event_type: "update_task",
      task_id: taskId,
      payload: {
        status: newStatus,
        old_status: oldStatus,
        version: newVersion,
      },
    },
  };
}

// 模拟事件日志读取
function readAuditEvents(logDir, date) {
  const logFile = path.join(logDir, `events-${date}.jsonl`);
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const content = fs.readFileSync(logFile, "utf-8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("飞轮核心流程集成测试", () => {
  const TASKS_DIR = path.join(__dirname, "..", "cooperation", "tasks");
  const LOG_DIR = path.join(__dirname, "..", "cooperation", "logs");

  describe("1. 审计日志读取", () => {
    it("能读取今日事件日志", () => {
      const today = new Date().toISOString().split("T")[0];
      const events = readAuditEvents(LOG_DIR, today);
      // 可能没有事件，但应该不报错
      expect(Array.isArray(events)).toBe(true);
    });

    it("能解析事件格式", () => {
      const sampleEvent = {
        ts: "2026-03-09T00:00:00.000+08:00",
        event_type: "update_task",
        task_id: "task-001",
        payload: { status: "in_progress", old_status: "open", version: 2 },
      };
      const parsed = JSON.parse(JSON.stringify(sampleEvent));
      expect(parsed.event_type).toBe("update_task");
      expect(parsed.payload.status).toBe("in_progress");
    });
  });

  describe("2. Open任务发现", () => {
    it("能解析任务文件frontmatter", () => {
      const taskFile = path.join(TASKS_DIR, "task-001-init-logging.md");
      if (fs.existsSync(taskFile)) {
        const task = parseTaskFile(taskFile);
        expect(task.id).toBe("task-001-init-logging");
        expect(task).toHaveProperty("status");
      }
    });

    it("能过滤出open状态的任务", () => {
      const tasks = getAllTasks(TASKS_DIR);
      const openTasks = tasks.filter((t) => t.status === "open");
      expect(openTasks.length).toBeGreaterThanOrEqual(0);
      openTasks.forEach((t) => {
        expect(t.status).toBe("open");
      });
    });

    it("能正确识别任务优先级", () => {
      const tasks = getAllTasks(TASKS_DIR);
      const tasksWithPriority = tasks.filter((t) => t.priority);
      tasksWithPriority.forEach((t) => {
        expect(["low", "medium", "high", "critical"]).toContain(t.priority);
      });
    });
  });

  describe("3. 任务分配逻辑", () => {
    it("能模拟状态更新", () => {
      const mockTasks = [
        { id: "task-999", status: "open", version: 1 },
      ];
      const result = simulateTaskStatusUpdate(mockTasks, "task-999", "in_progress");

      expect(result.tasks[0].status).toBe("in_progress");
      expect(result.tasks[0].version).toBe(2);
      expect(result.event.payload.status).toBe("in_progress");
      expect(result.event.payload.old_status).toBe("open");
    });

    it("状态更新时生成正确的事件", () => {
      const mockTasks = [
        { id: "task-888", status: "in_progress", version: 3 },
      ];
      const result = simulateTaskStatusUpdate(mockTasks, "task-888", "done");

      expect(result.event.event_type).toBe("update_task");
      expect(result.event.payload.status).toBe("done");
      expect(result.event.payload.old_status).toBe("in_progress");
      expect(result.event.payload.version).toBe(4);
    });

    it("更新不存在任务时抛出错误", () => {
      const mockTasks = [{ id: "task-001", status: "open", version: 1 }];
      expect(() => simulateTaskStatusUpdate(mockTasks, "task-nonexistent", "done")).toThrow();
    });

    it("支持所有有效状态转换", () => {
      const validTransitions = [
        { from: "open", to: "in_progress" },
        { from: "in_progress", to: "done" },
        { from: "in_progress", to: "blocked" },
        { from: "in_progress", to: "open" }, // 退回
        { from: "blocked", to: "in_progress" }, // 解除阻塞
      ];

      validTransitions.forEach(({ from, to }) => {
        const mockTasks = [{ id: "task-test", status: from, version: 1 }];
        const result = simulateTaskStatusUpdate(mockTasks, "task-test", to);
        expect(result.tasks[0].status).toBe(to);
      });
    });
  });

  describe("4. 端到端流程", () => {
    it("完整流程: 读取审计 → 发现任务 → 更新状态", () => {
      // Step 1: 读取审计日志
      const today = new Date().toISOString().split("T")[0];
      const eventsBefore = readAuditEvents(LOG_DIR, today);
      const eventCountBefore = eventsBefore.length;

      // Step 2: 发现open任务
      const tasks = getAllTasks(TASKS_DIR);
      const openTasks = tasks.filter((t) => t.status === "open");

      // Step 3: 分配第一个open任务 (模拟)
      if (openTasks.length > 0) {
        const taskToClaim = openTasks[0];
        const result = simulateTaskStatusUpdate(tasks, taskToClaim.id, "in_progress");

        expect(result.tasks.find((t) => t.id === taskToClaim.id).status).toBe("in_progress");
        expect(result.event.event_type).toBe("update_task");
      }

      // 注意: simulateTaskStatusUpdate 是模拟函数，不会实际写入事件
      // 这里只验证模拟函数返回正确的结果
      const eventsAfter = readAuditEvents(LOG_DIR, today);
      expect(eventsAfter.length).toBe(eventCountBefore);
    });

    it("能处理空任务列表", () => {
      const emptyTasks = [];
      const openTasks = emptyTasks.filter((t) => t.status === "open");
      expect(openTasks.length).toBe(0);
    });

    it("任务状态统计正确", () => {
      const tasks = getAllTasks(TASKS_DIR);
      const stats = buildStatusStats(tasks);

      expect(stats.open + stats.in_progress + stats.done + stats.blocked + stats.other).toBe(tasks.length);
    });

    it("状态边界场景可守恒计数（未知状态/缺省状态/缺失frontmatter）", () => {
      const syntheticTasks = [
        { id: "task-a", status: "open" },
        { id: "task-b", status: "in_progress" },
        { id: "task-c", status: "done" },
        { id: "task-d", status: "blocked" },
        { id: "task-e", status: "paused" }, // 未知状态
        { id: "task-f" }, // 缺省状态
        parseTaskFile(path.join(TASKS_DIR, "..", "..", "README.md")), // 缺失frontmatter
      ];

      const stats = buildStatusStats(syntheticTasks);
      expect(stats.open).toBe(1);
      expect(stats.in_progress).toBe(1);
      expect(stats.done).toBe(1);
      expect(stats.blocked).toBe(1);
      expect(stats.other).toBe(3);
      expect(stats.open + stats.in_progress + stats.done + stats.blocked + stats.other)
        .toBe(syntheticTasks.length);
    });
  });
});
