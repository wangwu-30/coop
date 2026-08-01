/**
 * Worker 负载均衡测试
 * 覆盖: worker 负载计算、任务分配、负载均衡逻辑
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 模拟 worker 负载计算逻辑
function calculateWorkerLoad(tasks, workerId) {
  const workerTasks = tasks.filter((t) => t.assignee === workerId);
  return {
    workerId,
    open: workerTasks.filter((t) => t.status === "open").length,
    in_progress: workerTasks.filter((t) => t.status === "in_progress").length,
    done: workerTasks.filter((t) => t.status === "done").length,
    total: workerTasks.length,
  };
}

// 模拟负载均衡分配逻辑
function rebalanceTasks(tasks, workers) {
  const openTasks = tasks.filter((t) => t.status === "open");

  // 按 worker 当前负载排序
  const workerLoads = workers.map((w) => ({
    workerId: w,
    load: calculateWorkerLoad(tasks, w).in_progress,
  }));

  workerLoads.sort((a, b) => a.load - b.load);

  // 将 open 任务分配给负载最低的 worker
  const result = [...tasks];
  let workerIndex = 0;

  openTasks.forEach((task) => {
    const targetWorker = workerLoads[workerIndex].workerId;
    const taskIndex = result.findIndex((t) => t.id === task.id);
    if (taskIndex !== -1) {
      result[taskIndex] = { ...result[taskIndex], assignee: targetWorker };
    }
    workerLoads[workerIndex].load++;
    workerLoads.sort((a, b) => a.load - b.load);
  });

  return result;
}

// 模拟检测负载不均衡
function detectLoadImbalance(tasks, workers, threshold = 2) {
  const loads = workers.map((w) => calculateWorkerLoad(tasks, w));
  const inProgressLoads = loads.map((l) => l.in_progress);
  const maxLoad = Math.max(...inProgressLoads);
  const minLoad = Math.min(...inProgressLoads);

  return {
    imbalanced: maxLoad - minLoad > threshold,
    maxLoad,
    minLoad,
    loads,
  };
}

describe("Worker 负载均衡测试", () => {
  const TASKS_DIR = path.join(__dirname, "..", "cooperation", "tasks");

  // 辅助函数：获取所有任务
  function getAllTasks() {
    if (!fs.existsSync(TASKS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith(".md"));
    return files.map((f) => {
      const content = fs.readFileSync(path.join(TASKS_DIR, f), "utf-8");
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return { id: f.replace(".md", "") };

      const frontmatter = {};
      fmMatch[1].split("\n").forEach((line) => {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) return;
        const key = line.slice(0, colonIndex).trim();
        let value = line.slice(colonIndex + 1).trim();
        if (value === "true") value = true;
        else if (value === "false") value = false;
        frontmatter[key] = value;
      });

      return { id: f.replace(".md", ""), ...frontmatter };
    });
  }

  describe("1. Worker 负载计算", () => {
    it("能计算单个 worker 的负载", () => {
      const tasks = [
        { id: "task-1", status: "in_progress", assignee: "worker-1" },
        { id: "task-2", status: "in_progress", assignee: "worker-1" },
        { id: "task-3", status: "open", assignee: "worker-1" },
        { id: "task-4", status: "done", assignee: "worker-1" },
      ];

      const load = calculateWorkerLoad(tasks, "worker-1");

      expect(load.workerId).toBe("worker-1");
      expect(load.in_progress).toBe(2);
      expect(load.open).toBe(1);
      expect(load.done).toBe(1);
      expect(load.total).toBe(4);
    });

    it("worker 无任务时返回零负载", () => {
      const tasks = [
        { id: "task-1", status: "in_progress", assignee: "worker-1" },
      ];

      const load = calculateWorkerLoad(tasks, "worker-nonexistent");

      expect(load.in_progress).toBe(0);
      expect(load.open).toBe(0);
      expect(load.done).toBe(0);
      expect(load.total).toBe(0);
    });
  });

  describe("2. 负载不均衡检测", () => {
    it("能检测负载不均衡情况", () => {
      const tasks = [
        { id: "task-1", status: "in_progress", assignee: "worker-1" },
        { id: "task-2", status: "in_progress", assignee: "worker-1" },
        { id: "task-3", status: "in_progress", assignee: "worker-1" },
        { id: "task-4", status: "in_progress", assignee: "worker-2" },
      ];

      const result = detectLoadImbalance(tasks, ["worker-1", "worker-2"], 1);

      expect(result.imbalanced).toBe(true);
      expect(result.maxLoad).toBe(3);
      expect(result.minLoad).toBe(1);
    });

    it("负载均衡时不触发警告", () => {
      const tasks = [
        { id: "task-1", status: "in_progress", assignee: "worker-1" },
        { id: "task-2", status: "in_progress", assignee: "worker-2" },
      ];

      const result = detectLoadImbalance(tasks, ["worker-1", "worker-2"], 1);

      expect(result.imbalanced).toBe(false);
    });
  });

  describe("3. 任务分配逻辑", () => {
    it("能将 open 任务分配给负载最低的 worker", () => {
      const tasks = [
        { id: "task-1", status: "in_progress", assignee: "worker-1" },
        { id: "task-2", status: "open", assignee: "" },
        { id: "task-3", status: "open", assignee: "" },
      ];

      const result = rebalanceTasks(tasks, ["worker-1", "worker-2"]);

      const worker2Tasks = result.filter((t) => t.assignee === "worker-2");
      expect(worker2Tasks.length).toBe(2);
    });

    it("保持已完成任务不变", () => {
      const tasks = [
        { id: "task-1", status: "done", assignee: "worker-1" },
        { id: "task-2", status: "open", assignee: "" },
      ];

      const result = rebalanceTasks(tasks, ["worker-1", "worker-2"]);

      const doneTask = result.find((t) => t.id === "task-1");
      expect(doneTask.assignee).toBe("worker-1");
    });
  });

  describe("4. 实际任务数据负载分析", () => {
    it("能分析实际任务的 worker 分布", () => {
      const tasks = getAllTasks();
      const workers = ["coop-worker-1", "coop-worker-2", "coop-worker-3"];

      const loads = workers.map((w) => calculateWorkerLoad(tasks, w));

      loads.forEach((load) => {
        expect(load).toHaveProperty("workerId");
        expect(load).toHaveProperty("in_progress");
        expect(load).toHaveProperty("open");
        expect(load).toHaveProperty("done");
        expect(load).toHaveProperty("total");
      });
    });

    it("能检测当前是否有负载不均衡", () => {
      const tasks = getAllTasks();
      const workers = ["coop-worker-1", "coop-worker-2", "coop-worker-3"];

      const result = detectLoadImbalance(tasks, workers, 3);

      expect(typeof result.imbalanced).toBe("boolean");
      expect(typeof result.maxLoad).toBe("number");
      expect(typeof result.minLoad).toBe("number");
    });
  });
});
