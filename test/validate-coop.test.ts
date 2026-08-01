import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateCoopFrontmatter } from "../scripts/validate-coop-frontmatter.mjs";

const validTask = `---
status: open
priority: medium
created_by: openclaw
assignee: null
created: "2026-03-06T00:00:00.000Z"
updated: "2026-03-06T00:00:00.000Z"
tags: []
depends_on: []
version: 1
---
# Sample Task

Body
`;

describe("validate:coop script", () => {
  it("checks .agent-coop/cooperation/tasks automatically", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-validate-"));
    try {
      const taskDir = path.join(tmp, ".agent-coop", "cooperation", "tasks");
      await mkdir(taskDir, { recursive: true });
      await writeFile(path.join(taskDir, "task-ok.md"), validTask, "utf8");

      const result = await validateCoopFrontmatter(tmp);
      expect(result.errors).toEqual([]);
      expect(result.filesChecked).toBe(1);
      expect(result.tasksDir).toBe(taskDir);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails in strict mode when task directory exists but has zero files", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-validate-"));
    try {
      const taskDir = path.join(tmp, ".agent-coop", "cooperation", "tasks");
      await mkdir(taskDir, { recursive: true });

      const result = await validateCoopFrontmatter(tmp, { strictZeroFiles: true });
      expect(result.filesChecked).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("strict-zero-files");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("passes when required frontmatter fields exist", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-validate-"));
    try {
      const taskDir = path.join(tmp, "cooperation", "tasks");
      await mkdir(taskDir, { recursive: true });
      await writeFile(path.join(taskDir, "task-ok.md"), validTask, "utf8");

      const result = await validateCoopFrontmatter(tmp, { strictZeroFiles: true });
      expect(result.errors).toEqual([]);
      expect(result.filesChecked).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails when required fields are missing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-validate-"));
    try {
      const taskDir = path.join(tmp, "cooperation", "tasks");
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        path.join(taskDir, "task-bad.md"),
        `---\nstatus: open\npriority: high\n---\n# Broken\n`,
        "utf8",
      );

      const result = await validateCoopFrontmatter(tmp);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("missing required fields");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails when filename worker marker conflicts with assignee", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-validate-"));
    try {
      const taskDir = path.join(tmp, "cooperation", "tasks");
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        path.join(taskDir, "task-20260311-1548-worker1-conflict.md"),
        validTask.replace("assignee: null", "assignee: coop-worker-3"),
        "utf8",
      );

      const result = await validateCoopFrontmatter(tmp, { strictZeroFiles: true });
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("task-id/filename implies coop-worker-1 but assignee=coop-worker-3"))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
