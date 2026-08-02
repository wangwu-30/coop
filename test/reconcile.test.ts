import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { coopInit, coopPostTask, coopPublishState, coopReconcile } from "../src/core/index.js";

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const roots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function createDivergence() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-reconcile-"));
  roots.push(root);
  const remote = path.join(root, "remote.git");
  const local = path.join(root, "local");
  const peer = path.join(root, "peer");
  await fs.mkdir(local, { recursive: true });
  await exec("git", ["init", "--bare", remote]);

  process.env.AGENT_COOP_DIR = local;
  await coopInit({ remote });
  expect(JSON.parse(await coopPublishState()).pushed).toBe(true);
  await exec("git", ["clone", remote, peer]);

  process.env.AGENT_COOP_DIR = peer;
  const peerTask = JSON.parse(await coopPostTask({
    title: "Canonical peer task",
    body: "accepted first",
    source: "claude-code",
  }));
  await exec("git", ["push", "origin", "main"], { cwd: peer });

  process.env.AGENT_COOP_DIR = local;
  const localTask = JSON.parse(await coopPostTask({
    title: "Rejected local candidate",
    body: "must be reconsidered",
    source: "codex",
  }));
  return { local, peerTask, localTask };
}

describe("coordination reconciliation", () => {
  it("inspects and explicitly discards a cooperation-only rejected candidate", async () => {
    const { local, peerTask, localTask } = await createDivergence();
    const rejected = JSON.parse(await coopPublishState());
    expect(rejected).toMatchObject({ error: "remote_conflict", reconciliation_required: true });

    const inspection = JSON.parse(await coopReconcile());
    expect(inspection).toMatchObject({
      status: "diverged",
      ahead: 1,
      behind: 1,
      candidate_is_cooperation_only: true,
      can_discard_local_candidate: true,
    });

    const result = JSON.parse(await coopReconcile({
      discard_local_candidate: true,
      expected_local_revision: inspection.local_revision,
    }));
    expect(result).toMatchObject({ reconciled: true, status: "candidate_discarded" });
    await expect(fs.access(path.join(local, localTask.id))).rejects.toThrow();
    await expect(fs.access(path.join(local, peerTask.id))).resolves.toBeUndefined();
  });

  it("refuses to discard a candidate containing business files", async () => {
    const { local } = await createDivergence();
    await fs.writeFile(path.join(local, "business-change.txt"), "do not discard\n", "utf8");
    await exec("git", ["add", "business-change.txt"], { cwd: local });
    await exec("git", ["commit", "-m", "business: local work"], { cwd: local });

    const inspection = JSON.parse(await coopReconcile());
    expect(inspection.candidate_is_cooperation_only).toBe(false);
    expect(inspection.non_cooperation_paths).toContain("business-change.txt");

    const result = JSON.parse(await coopReconcile({
      discard_local_candidate: true,
      expected_local_revision: inspection.local_revision,
    }));
    expect(result.error).toBe("unsafe_candidate_scope");
    await expect(fs.access(path.join(local, "business-change.txt"))).resolves.toBeUndefined();
  });
});
