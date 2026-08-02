import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coopClaimTask, coopInit, coopPostTask } from "../src/core/index.js";

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const roots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("canonical mutation serialization", () => {
  it("serializes commits for different tasks in the same checkout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-canonical-lock-"));
    roots.push(root);
    process.env.AGENT_COOP_DIR = root;
    await coopInit({});

    const first = JSON.parse(await coopPostTask({
      title: "First concurrent task",
      body: "one",
      source: "codex",
    }));
    const second = JSON.parse(await coopPostTask({
      title: "Second concurrent task",
      body: "two",
      source: "claude-code",
    }));

    const [firstClaim, secondClaim] = await Promise.all([
      coopClaimTask({ task_id: first.id, assignee: "codex", expected_version: 1 }),
      coopClaimTask({ task_id: second.id, assignee: "claude-code", expected_version: 1 }),
    ]).then((values) => values.map((value) => JSON.parse(value)));

    expect(firstClaim).toMatchObject({ status: "in_progress", assignee: "codex", version: 2 });
    expect(secondClaim).toMatchObject({ status: "in_progress", assignee: "claude-code", version: 2 });
    expect((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim()).toBe("");

    const commitCount = Number.parseInt(
      (await exec("git", ["rev-list", "--count", "HEAD"], { cwd: root })).stdout.trim(),
      10,
    );
    expect(commitCount).toBe(5);
  });
});
