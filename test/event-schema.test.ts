import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { coopInit } from "../src/tools/init.js";
import { coopPostTask } from "../src/tools/coop.js";
import { emitChat, ingestChatDecision } from "../src/tools/chat-bridge.js";
import { appendEventLog } from "../src/storage/events.js";

let tmpDir: string;
const origEnv = process.env.AGENT_COOP_DIR;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-event-schema-"));
  process.env.AGENT_COOP_DIR = tmpDir;
  await coopInit({ enable_chat_bridge: true, chat_outbox_dir: "chat/outbox" });
});

afterEach(async () => {
  process.env.AGENT_COOP_DIR = origEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("unified event schema", () => {
  it("uses the same required fields in coop event log and chat outbox", async () => {
    const task = JSON.parse(await coopPostTask({ title: "Schema", body: "check", source: "coop-leader" }));
    await emitChat({ topic: "tasks", actor: "coop-leader", event: "post_task", task_id: task.id, payload: { extra: true } });
    await ingestChatDecision({ actor: "coop-leader", source: "telegram", decision: "approved", task_id: task.id });

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const outboxPath = path.join(tmpDir, "chat", "outbox", `events-${date}.jsonl`);

    const logEvent = JSON.parse((await fs.readFile(logPath, "utf8")).trim().split("\n")[0]);
    const outboxEvent = JSON.parse((await fs.readFile(outboxPath, "utf8")).trim().split("\n")[0]);

    for (const event of [logEvent, outboxEvent]) {
      expect(typeof event.ts).toBe("string");
      expect(typeof event.event_id).toBe("string");
      expect(typeof event.event_type).toBe("string");
      expect(typeof event.actor).toBe("string");
      expect(typeof event.schema_version).toBe("number");
      expect(typeof event.payload).toBe("object");
    }

    expect(outboxEvent.task_id).toBe(task.id);
  });

  it("rejects malformed events before append", async () => {
    await expect(
      appendEventLog({
        event_type: "post_task",
        actor: "coop-leader",
        payload: null as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow();

    await expect(
      emitChat({
        topic: "tasks",
        actor: "",
        event: "post_task",
        payload: {},
      }),
    ).rejects.toThrow();
  });

  it("normalizes actor slug and keeps backward-compatible version optional", async () => {
    const relativePath = await appendEventLog({
      event_type: "post_task",
      actor: "  COOP worker 1  ",
      version: 1,
      payload: { title: "x" },
    });

    const date = new Date().toISOString().slice(0, 10);
    expect(relativePath).toBe(path.join("logs", `events-${date}.jsonl`));

    const logPath = path.join(tmpDir, relativePath);
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const event = JSON.parse(lines.at(-1) as string);

    expect(event.actor).toBe("coop-worker-1");
    expect(typeof event.event_id).toBe("string");
    expect(event.version).toBe(1);
    expect(event.schema_version).toBeGreaterThan(0);
  });

  it("hard-rejects non-core actors and records source attribution", async () => {
    await expect(
      appendEventLog({
        event_type: "milestone",
        actor: "coop-worker",
        payload: { source_module: "dispatcher", caller: "loop.once" },
      }),
    ).rejects.toThrow(/hard allowlist/);

    await expect(
      appendEventLog({
        event_type: "milestone",
        actor: "COOP WORKER 99",
        payload: { source_module: "dispatcher", caller: "loop.once" },
      }),
    ).rejects.toThrow(/hard allowlist/);

    await expect(
      appendEventLog({
        event_type: "milestone",
        actor: "",
        payload: { source_module: "dispatcher", caller: "loop.once" },
      }),
    ).rejects.toThrow();

    const date = new Date().toISOString().slice(0, 10);
    const unauthorizedLog = path.join(tmpDir, "logs", `unauthorized-attempts-${date}.jsonl`);
    const rows = (await fs.readFile(unauthorizedLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const latest = rows.at(-1);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(latest.source_module).toBe("dispatcher");
    expect(latest.caller).toBe("loop.once");

    await expect(
      appendEventLog({
        event_type: "milestone",
        actor: "coop-worker",
        payload: { source_module: "dispatcher", caller: "loop.once" },
      }),
    ).rejects.toThrow(/top_sources=/);
  });

  it("clamps future timestamp and enforces monotonic writes", async () => {
    const now = Date.now();

    await appendEventLog({
      event_type: "milestone",
      actor: "observer-pm",
      payload: { milestone: "t1" },
      ts: new Date(now + 60 * 60 * 1000).toISOString(),
      task_id: "task-ts-1",
    });

    await appendEventLog({
      event_type: "milestone",
      actor: "observer-pm",
      payload: { milestone: "t2" },
      ts: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
      task_id: "task-ts-2",
    });

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
    const [first, second] = lines.slice(-2).map((line) => JSON.parse(line));

    const firstTs = Date.parse(first.ts);
    const secondTs = Date.parse(second.ts);

    expect(firstTs).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(secondTs).toBeGreaterThan(firstTs);
  });
});
