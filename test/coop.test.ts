import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { coopInit } from "../src/tools/init.js";
import {
  coopPostTask,
  coopClaimTask,
  coopUpdateTask,
  coopGetTask,
  coopLogMilestone,
  coopRecommendAgents,
  coopSendMessage,
  coopAcknowledgeMessage,
  coopReadMessages,
  coopCheckInbox,
} from "../src/tools/coop.js";
import { coopConfigureMemory } from "../src/tools/configure.js";
import { parseMessage, parseTask } from "../src/schema/coop.js";
import { ingestChatDecision } from "../src/tools/chat-bridge.js";
import { loadConfig } from "../src/config.js";

let tmpDir: string;
const origEnv = process.env.AGENT_COOP_DIR;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-test-"));
  process.env.AGENT_COOP_DIR = tmpDir;
  await coopInit({});
});

afterEach(async () => {
  process.env.AGENT_COOP_DIR = origEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("coop tasks", () => {
  it("should post and claim a task with version", async () => {
    const postResult = JSON.parse(
      await coopPostTask({ title: "Fix bug", body: "Fix the login bug.", source: "claude-code" }),
    );
    expect(postResult.version).toBe(1);

    const claimResult = JSON.parse(
      await coopClaimTask({ task_id: postResult.id, assignee: "openclaw", expected_version: 1 }),
    );
    expect(claimResult.status).toBe("in_progress");
    expect(claimResult.assignee).toBe("openclaw");
    expect(claimResult.version).toBe(2);
  });

  it("should write event_id for post_task events", async () => {
    const postResult = JSON.parse(
      await coopPostTask({ title: "Event id", body: "ensure post_task has id", source: "claude-code" }),
    );

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const events = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const postEvent = events.find((event) => event.event_type === "post_task" && event.task_id === postResult.id);

    expect(postEvent).toBeDefined();
    expect(typeof postEvent.event_id).toBe("string");
    expect(postEvent.event_id.length).toBeGreaterThan(0);
  });

  it("should reject invalid status transitions", async () => {
    const postResult = JSON.parse(
      await coopPostTask({ title: "Direct done", body: "Try skipping", source: "claude-code" }),
    );

    const badUpdate = JSON.parse(
      await coopUpdateTask({ task_id: postResult.id, status: "done", expected_version: 1 }),
    );

    expect(badUpdate.error).toBe("invalid_status_transition");
    expect(badUpdate.from).toBe("open");
    expect(badUpdate.to).toBe("done");
  });

  it("should reject stale expected_version", async () => {
    const postResult = JSON.parse(
      await coopPostTask({ title: "Race", body: "simulate race", source: "claude-code" }),
    );
    await coopClaimTask({ task_id: postResult.id, assignee: "openclaw", expected_version: 1 });

    const stale = JSON.parse(
      await coopUpdateTask({ task_id: postResult.id, status: "done", expected_version: 1 }),
    );

    expect(stale.error).toBe("version_conflict");
    expect(stale.actual_version).toBe(2);
  });

  it("should serialize concurrent claims so exactly one wins", async () => {
    const task = JSON.parse(
      await coopPostTask({ title: "Concurrent claim", body: "only one owner", source: "claude-code" }),
    );

    const results = await Promise.all([
      coopClaimTask({ task_id: task.id, assignee: "coop-worker-1", expected_version: 1 }),
      coopClaimTask({ task_id: task.id, assignee: "coop-worker-2", expected_version: 1 }),
    ]).then((items) => items.map((item) => JSON.parse(item)));

    expect(results.filter((result) => result.status === "in_progress")).toHaveLength(1);
    expect(results.filter((result) => result.error === "version_conflict")).toHaveLength(1);
    const loaded = JSON.parse(await coopGetTask({ task_id: task.id }));
    expect(loaded.version).toBe(2);
  });

  it("should block marking done when dependencies are unresolved", async () => {
    const dependency = JSON.parse(
      await coopPostTask({ title: "Dep", body: "must finish first", source: "claude-code" }),
    );
    const task = JSON.parse(
      await coopPostTask({ title: "Main", body: "depends on dep", source: "claude-code" }),
    );

    const withDependency = JSON.parse(
      await coopUpdateTask({
        task_id: task.id,
        depends_on: [dependency.id],
        expected_version: 1,
      }),
    );
    expect(withDependency.version).toBe(2);

    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 2 });

    const blockedDone = JSON.parse(
      await coopUpdateTask({ task_id: task.id, status: "done", expected_version: 3 }),
    );

    expect(blockedDone.error).toBe("unmet_dependencies");
    expect(blockedDone.unresolved).toEqual([dependency.id]);
  });



  it("should skip no-op updates without bumping version or logging update_task", async () => {
    const task = JSON.parse(
      await coopPostTask({ title: "No-op update", body: "keep lean logs", source: "claude-code" }),
    );

    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });

    const noop = JSON.parse(
      await coopUpdateTask({
        task_id: task.id,
        status: "in_progress",
        assignee: "openclaw",
        expected_version: 2,
      }),
    );

    expect(noop.no_op).toBe(true);
    expect(noop.version).toBe(2);

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const events = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    const taskEvents = events.filter((event) => event.task_id === task.id);
    expect(taskEvents.map((event) => event.event_type)).toEqual(["post_task", "claim_task"]);
  });

  it("should append milestone events without mutating task version", async () => {
    const task = JSON.parse(
      await coopPostTask({ title: "Milestone event", body: "capture progress", source: "claude-code" }),
    );

    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });

    const milestone = JSON.parse(
      await coopLogMilestone({
        task_id: task.id,
        actor: "openclaw",
        milestone: "Design completed",
        expected_version: 2,
      }),
    );

    expect(milestone.version).toBe(2);

    const loaded = JSON.parse(await coopGetTask({ task_id: task.id }));
    expect(loaded.version).toBe(2);
    expect(loaded.status).toBe("in_progress");

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const events = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

    const milestoneEvent = events.find((event) => event.event_type === "milestone" && event.task_id === task.id);
    expect(milestoneEvent).toBeDefined();
    expect(milestoneEvent.payload.milestone).toBe("Design completed");
  });

  it("should normalize depends_on and allow done when all dependencies are done", async () => {
    const depA = JSON.parse(
      await coopPostTask({ title: "Dep A", body: "first", source: "claude-code" }),
    );
    const depB = JSON.parse(
      await coopPostTask({ title: "Dep B", body: "second", source: "claude-code" }),
    );
    const task = JSON.parse(
      await coopPostTask({ title: "Main 2", body: "depends on A+B", source: "claude-code" }),
    );

    await coopClaimTask({ task_id: depA.id, assignee: "openclaw", expected_version: 1 });
    await coopUpdateTask({ task_id: depA.id, status: "done", expected_version: 2 });
    await coopClaimTask({ task_id: depB.id, assignee: "openclaw", expected_version: 1 });
    await coopUpdateTask({ task_id: depB.id, status: "done", expected_version: 2 });

    const update = JSON.parse(
      await coopUpdateTask({
        task_id: task.id,
        depends_on: [depA.id, ` ${depA.id} `, "", depB.id, "   "],
        expected_version: 1,
      }),
    );
    expect(update.version).toBe(2);

    const rawTask = await fs.readFile(path.join(tmpDir, task.id), "utf8");
    const parsedTask = parseTask(rawTask, task.id);
    expect(parsedTask.frontmatter.depends_on).toEqual([depA.id, depB.id]);

    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 2 });
    const done = JSON.parse(
      await coopUpdateTask({ task_id: task.id, status: "done", expected_version: 3 }),
    );
    expect(done.status).toBe("done");
  });
});


describe("trust policy enforcement", () => {
  it("should remain backward-compatible when policy is missing", async () => {
    const post = JSON.parse(await coopPostTask({ title: "No policy", body: "compat", source: "any-agent" }));
    expect(post.status).toBe("open");
  });

  it("should allow writes for allowlisted actor and allowed event type", async () => {
    await fs.writeFile(
      path.join(tmpDir, "policy.yaml"),
      [
        "allowlist_actors:",
        "  - trusted-agent",
        "allowed_event_types:",
        "  - post_task",
      ].join("\n"),
      "utf8",
    );

    const post = JSON.parse(await coopPostTask({
      title: "Allowed",
      body: "trust policy pass",
      source: "trusted-agent",
    }));

    expect(post.status).toBe("open");
  });

  it("should reject unauthorized actor with structured error", async () => {
    await fs.writeFile(
      path.join(tmpDir, "policy.yaml"),
      [
        "allowlist_actors:",
        "  - trusted-agent",
        "allowed_event_types:",
        "  - post_task",
      ].join("\n"),
      "utf8",
    );

    const post = JSON.parse(await coopPostTask({
      title: "Blocked",
      body: "trust policy fail",
      source: "intruder",
    }));

    expect(post.error).toBe("unauthorized_actor");
    expect(post.actor).toBe("intruder");
    const taskFiles = await fs.readdir(path.join(tmpDir, "cooperation", "tasks"));
    expect(taskFiles).toEqual([]);
  });

  it("should leave an existing task unchanged when claim authorization fails", async () => {
    const task = JSON.parse(await coopPostTask({ title: "Protected claim", body: "stay open", source: "trusted-agent" }));
    await fs.writeFile(
      path.join(tmpDir, "policy.yaml"),
      [
        "allowlist_actors:",
        "  - trusted-agent",
        "allowed_event_types:",
        "  - claim_task",
      ].join("\n"),
      "utf8",
    );

    const rejected = JSON.parse(await coopClaimTask({
      task_id: task.id,
      assignee: "intruder",
      expected_version: 1,
    }));
    const loaded = JSON.parse(await coopGetTask({ task_id: task.id }));

    expect(rejected.error).toBe("unauthorized_actor");
    expect(loaded.status).toBe("open");
    expect(loaded.assignee).toBeNull();
    expect(loaded.version).toBe(1);
  });

  it("should reject disallowed event type with structured error", async () => {
    await fs.writeFile(
      path.join(tmpDir, "policy.yaml"),
      [
        "allowlist_actors:",
        "  - trusted-agent",
        "allowed_event_types:",
        "  - post_task",
      ].join("\n"),
      "utf8",
    );

    const message = JSON.parse(await coopSendMessage({
      from: "trusted-agent",
      to: "openclaw",
      subject: "Nope",
      body: "send_message blocked",
    }));

    expect(message.error).toBe("disallowed_event_type");
    expect(message.event_type).toBe("send_message");
    const messageFiles = await fs.readdir(path.join(tmpDir, "cooperation", "messages"));
    expect(messageFiles).toEqual([]);
  });
});

describe("optional memory bridge", () => {
  it("should write completion memory and use it for recommendations when enabled", async () => {
    await coopConfigureMemory({ enabled: true });

    const task = JSON.parse(
      await coopPostTask({
        title: "OAuth review",
        body: "review oauth flow",
        source: "claude-code",
        tags: ["auth", "review"],
      }),
    );

    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });
    await coopUpdateTask({
      task_id: task.id,
      status: "done",
      expected_version: 2,
      comment: "Completed with test coverage.",
    });

    const memoryDir = path.join(tmpDir, "memory");
    const files = await fs.readdir(memoryDir);
    expect(files.length).toBeGreaterThan(0);

    const recommended = JSON.parse(
      await coopRecommendAgents({ title: "OAuth review", tags: ["auth"], limit: 2 }),
    );
    expect(recommended.recommended_agents).toContain("openclaw");
  });
});

describe("coop messages", () => {
  it("should send and read a direct message", async () => {
    await coopSendMessage({ from: "claude-code", to: "openclaw", subject: "Review complete", body: "The auth module looks good.", tags: ["review"] });
    const msgs = JSON.parse(await coopReadMessages({ recipient: "openclaw" }));
    expect(msgs.count).toBe(1);
    expect(msgs.messages[0].subject).toBe("Review complete");
  });

  it("should persist send_message events with event_id for schema safety", async () => {
    const message = JSON.parse(
      await coopSendMessage({
        from: "claude-code",
        to: "openclaw",
        subject: "Schema guard",
        body: "verify event_id presence",
      }),
    );

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const raw = await fs.readFile(logPath, "utf8");
    const events = raw
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const sendMessageEvent = events.find(
      (event) => event.event_type === "send_message" && event.message_id === message.id,
    );

    expect(sendMessageEvent).toBeDefined();
    expect(typeof sendMessageEvent.event_id).toBe("string");
    expect(sendMessageEvent.event_id.length).toBeGreaterThan(0);
    expect(typeof sendMessageEvent.schema_version).toBe("number");
  });

  it("should deduplicate task-linked typed messages", async () => {
    const task = JSON.parse(await coopPostTask({
      title: "Need review",
      body: "review this change",
      source: "claude-code",
    }));
    const input = {
      from: "claude-code",
      to: "openclaw",
      kind: "review_request" as const,
      subject: "Review task",
      body: "Please review the proposed change.",
      task_id: task.id,
      expected_task_version: 1,
      requires_ack: true,
      dedupe_key: "review-task-v1",
    };

    const first = JSON.parse(await coopSendMessage(input));
    const second = JSON.parse(await coopSendMessage(input));
    const files = await fs.readdir(path.join(tmpDir, "cooperation", "messages"));

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    expect(files).toHaveLength(1);
    const parsed = parseMessage(await fs.readFile(path.join(tmpDir, first.id), "utf8"), first.id);
    expect(parsed.frontmatter.kind).toBe("review_request");
    expect(parsed.frontmatter.task_id).toBe(task.id);
    expect(parsed.frontmatter.expected_task_version).toBe(1);
    expect(parsed.frontmatter.source_commit).toBeTruthy();
  });

  it("should reject a task-linked message without a current expected version", async () => {
    const task = JSON.parse(await coopPostTask({
      title: "Version bound",
      body: "message must name the observed version",
      source: "claude-code",
    }));
    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });

    const missing = JSON.parse(await coopSendMessage({
      from: "claude-code",
      to: "openclaw",
      kind: "clarification_request",
      subject: "Missing version",
      body: "This must be rejected.",
      task_id: task.id,
    }));
    const stale = JSON.parse(await coopSendMessage({
      from: "claude-code",
      to: "openclaw",
      kind: "clarification_request",
      subject: "Stale version",
      body: "This must also be rejected.",
      task_id: task.id,
      expected_task_version: 1,
    }));

    expect(missing.error).toBe("missing_expected_task_version");
    expect(stale.error).toBe("version_conflict");
    expect(await fs.readdir(path.join(tmpDir, "cooperation", "messages"))).toEqual([]);
  });

  it("should append immutable read and ack receipts without rewriting the message", async () => {
    const sent = JSON.parse(await coopSendMessage({
      from: "claude-code",
      to: "openclaw",
      kind: "help_request",
      subject: "Need context",
      body: "Please send the missing context.",
      requires_ack: true,
      dedupe_key: "help-context",
    }));
    const messagePath = path.join(tmpDir, sent.id);
    const before = await fs.readFile(messagePath, "utf8");

    const marked = JSON.parse(await coopReadMessages({ recipient: "openclaw", mark_read_as: "openclaw" }));
    const ack = JSON.parse(await coopAcknowledgeMessage({
      message_id: sent.id,
      actor: "openclaw",
      status: "ack",
      note: "I will handle it.",
    }));
    const duplicateAck = JSON.parse(await coopAcknowledgeMessage({
      message_id: sent.id,
      actor: "openclaw",
      status: "ack",
    }));
    const after = await fs.readFile(messagePath, "utf8");
    const reread = JSON.parse(await coopReadMessages({ recipient: "openclaw" }));
    const receiptFiles = await fs.readdir(path.join(tmpDir, "cooperation", "message-receipts"));

    expect(marked.messages[0].is_read).toBe(true);
    expect(ack.already_recorded).toBe(false);
    expect(duplicateAck.already_recorded).toBe(true);
    expect(before).toBe(after);
    expect(receiptFiles).toHaveLength(2);
    expect(reread.messages[0].receipt_statuses).toEqual(["ack", "read"]);
  });

  it("should reject an ack when its task version has become stale", async () => {
    const task = JSON.parse(await coopPostTask({
      title: "Stale message task",
      body: "advance after message",
      source: "claude-code",
    }));
    const sent = JSON.parse(await coopSendMessage({
      from: "claude-code",
      to: "openclaw",
      kind: "handoff",
      subject: "Take over",
      body: "Take over this task.",
      task_id: task.id,
      expected_task_version: 1,
      requires_ack: true,
    }));
    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });

    const stale = JSON.parse(await coopAcknowledgeMessage({
      message_id: sent.id,
      actor: "openclaw",
      status: "ack",
    }));

    expect(stale.error).toBe("stale_message");
    expect(stale.actual_version).toBe(2);
    expect(await fs.readdir(path.join(tmpDir, "cooperation", "message-receipts"))).toEqual([]);
  });

  it("inbox summary works", async () => {
    const task = JSON.parse(await coopPostTask({ title: "Claimed task", body: "Doing this", source: "claude-code" }));
    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });
    await coopSendMessage({ from: "claude-code", to: "openclaw", subject: "Hey", body: "Check this out." });

    const inbox = JSON.parse(await coopCheckInbox({ agent_id: "openclaw" }));
    expect(inbox.summary.my_active_tasks).toBe(1);
    expect(inbox.summary.unread_messages).toBe(1);
  });
});

describe("chat bridge", () => {
  it("should stay disabled by default and not emit chat outbox entries", async () => {
    const config = await loadConfig(tmpDir);
    expect(config.chatBridge.enabled).toBe(false);

    await coopPostTask({ title: "No chat emission", body: "default-off", source: "claude-code" });

    const outboxDir = path.join(tmpDir, "chat", "outbox");
    await expect(fs.readdir(outboxDir)).rejects.toThrow();
  });

  it("should emit key events to file-backed outbox when enabled", async () => {
    await coopInit({ enable_chat_bridge: true, chat_outbox_dir: "chat/outbox" });

    await coopPostTask({ title: "Emit me", body: "chat bridge on", source: "claude-code" });

    const date = new Date().toISOString().slice(0, 10);
    const outboxPath = path.join(tmpDir, "chat", "outbox", `events-${date}.jsonl`);
    const raw = await fs.readFile(outboxPath, "utf8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line));

    expect(events.some((event) => event.event_type === "post_task")).toBe(true);
    expect(events.every((event) => typeof event.schema_version === "number")).toBe(true);
    expect(events.every((event) => typeof event.event_id === "string")).toBe(true);
  });

  it("should ingest chat decisions into append-only git event log", async () => {
    await ingestChatDecision({
      actor: "openclaw",
      source: "telegram:group:ops",
      decision: "Approve rollout to production",
      metadata: { decision_id: "dec-001", confidence: 0.9 },
    });

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const raw = await fs.readFile(logPath, "utf8");
    const events = raw.trim().split("\n").map((line) => JSON.parse(line));

    const decisionEvent = events.find((event) => event.event_type === "ingest_chat_decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent.payload.source).toBe("telegram:group:ops");
    expect(decisionEvent.payload.decision).toBe("Approve rollout to production");
  });
});

describe("event logs", () => {
  it("should append parseable JSONL events for collaboration actions", async () => {
    const task = JSON.parse(
      await coopPostTask({ title: "Evented task", body: "Track actions", source: "claude-code" }),
    );
    await coopClaimTask({ task_id: task.id, assignee: "openclaw", expected_version: 1 });
    await coopUpdateTask({
      task_id: task.id,
      status: "blocked",
      comment: "Waiting for dependency",
      expected_version: 2,
    });

    const message = JSON.parse(
      await coopSendMessage({
        from: "claude-code",
        to: "openclaw",
        subject: "Event log check",
        body: "Please verify logs",
      }),
    );

    await coopConfigureMemory({ enabled: true, dir: "memory" });

    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(tmpDir, "logs", `events-${date}.jsonl`);
    const raw = await fs.readFile(logPath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThanOrEqual(5);

    const events = lines.map((line) => JSON.parse(line));
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("post_task");
    expect(eventTypes).toContain("claim_task");
    expect(eventTypes).toContain("update_task");
    expect(eventTypes).toContain("send_message");
    expect(eventTypes).toContain("configure_memory");

    for (const event of events) {
      expect(typeof event.ts).toBe("string");
      expect(typeof event.event_type).toBe("string");
      expect(typeof event.actor).toBe("string");
      expect(typeof event.payload).toBe("object");
      expect(event.schema_version).toBeGreaterThan(0);
      expect(typeof event.event_id).toBe("string");
    }

    expect(events.some((e) => e.task_id === task.id)).toBe(true);
    expect(events.some((e) => e.message_id === message.id)).toBe(true);
  });
});
