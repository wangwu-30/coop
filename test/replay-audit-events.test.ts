import { describe, it, expect } from "vitest";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReplayOrAudit } from "../scripts/replay-audit-events.mjs";

describe("replay/audit events script", () => {
  it("accepts typed message receipt events", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-replay-message-receipts-"));
    try {
      const filePath = path.join(tmp, "events-2026-03-06.jsonl");
      const events = ["message_read", "message_ack", "message_reject"].map((event_type, index) => ({
        ts: `2026-03-06T01:0${index}:00.000Z`,
        event_id: `evt-receipt-${index}`,
        schema_version: 2,
        event_type,
        actor: "openclaw",
        message_id: "cooperation/messages/review.md",
        payload: { status: event_type.replace("message_", "") },
      }));
      await writeFile(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

      const audit = await runReplayOrAudit({ file: filePath, mode: "audit" });
      expect(audit.issues.filter((issue) => issue.type === "unknown_event_type")).toEqual([]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("replays task summaries with latest status/version/actors", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-replay-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const filePath = path.join(logsDir, "events-2026-03-06.jsonl");

      const lines = [
        {
          ts: "2026-03-06T01:00:00.000Z",
          event_id: "evt-1",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-1.md",
          actor: "lead",
          payload: { title: "Task 1" },
        },
        {
          ts: "2026-03-06T01:01:00.000Z",
          event_id: "evt-2",
          schema_version: 2,
          event_type: "claim_task",
          task_id: "cooperation/tasks/task-1.md",
          actor: "worker",
          payload: { status: "in_progress", current_version: 2 },
        },
        {
          ts: "2026-03-06T01:01:30.000Z",
          event_id: "evt-2b",
          schema_version: 2,
          event_type: "milestone",
          task_id: "cooperation/tasks/task-1.md",
          actor: "worker",
          payload: { milestone: "halfway", status: "in_progress", current_version: 2 },
        },
        {
          // backward-compatible legacy event (version without schema_version)
          ts: "2026-03-06T01:02:00.000Z",
          event_id: "evt-3",
          event_type: "update_task",
          task_id: "cooperation/tasks/task-1.md",
          actor: "worker",
          payload: { status: "done", current_version: 3, comment: "done" },
          version: 1,
        },
      ];

      await writeFile(filePath, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

      const replay = await runReplayOrAudit({ file: filePath, mode: "replay", runtimeBaselineFile: null });
      expect(replay.task_count).toBe(1);
      expect(replay.tasks[0].latest_status).toBe("done");
      expect(replay.tasks[0].latest_version).toBe(3);
      expect(replay.tasks[0].actors.sort()).toEqual(["lead", "worker"]);
      expect(replay.tasks[0].key_milestones).toHaveLength(4);
      expect(replay.tasks[0].milestone_timeline).toHaveLength(1);
      expect(replay.tasks[0].milestone_timeline[0].milestone).toBe("halfway");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("audits missing/duplicate event ids, malformed actor, and out-of-order task versions", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const filePath = path.join(logsDir, "events-2026-03-06.jsonl");

      const lines = [
        {
          ts: "2026-03-06T01:00:00.000Z",
          event_id: "dup-1",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-2.md",
          actor: "lead",
          payload: { title: "Task 2" },
        },
        {
          ts: "2026-03-06T01:01:00.000Z",
          event_id: "dup-1",
          schema_version: 2,
          event_type: "update_task",
          task_id: "cooperation/tasks/task-2.md",
          actor: "worker",
          payload: { status: "in_progress", current_version: 3 },
        },
        {
          ts: "2026-03-06T01:02:00.000Z",
          // missing event_id on purpose
          schema_version: 2,
          event_type: "update_task",
          task_id: "cooperation/tasks/task-2.md",
          actor: "Bad Actor",
          payload: { status: "blocked", current_version: 2 },
        },
        {
          ts: "2026-03-06T01:03:00.000Z",
          event_id: "evt-unknown",
          schema_version: 2,
          event_type: "mystery_event",
          actor: "nobody",
          payload: {},
        },
        {
          ts: "2026-03-06T01:04:00.000Z",
          event_id: "evt-msg",
          schema_version: 2,
          event_type: "send_message",
          actor: "lead",
          payload: { to: "worker" },
        },
      ];

      await writeFile(filePath, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

      const audit = await runReplayOrAudit({ file: filePath, mode: "audit" });
      const issueTypes = audit.issues.map((issue) => issue.type);

      expect(issueTypes).toContain("out_of_order_task_version");
      expect(issueTypes).toContain("unknown_event_type");
      expect(issueTypes).toContain("duplicate_event_id");
      expect(issueTypes).toContain("malformed_actor");
      expect(
        audit.issues.some((issue) => issue.type === "missing_required_field" && issue.field === "event_id"),
      ).toBe(true);
      expect(
        audit.issues.some((issue) => issue.type === "missing_required_field" && issue.field === "message_id"),
      ).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("separates legacy issues from current issues with baseline and passes current quality", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-baseline-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const filePath = path.join(logsDir, "events-2026-03-06.jsonl");

      const lines = [
        {
          ts: "2026-03-05T23:59:00.000Z",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-legacy.md",
          actor: "lead",
          payload: { title: "legacy" },
          // missing event_id on purpose (legacy noise)
        },
        {
          ts: "2026-03-06T02:00:00.000Z",
          event_id: "evt-new-1",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-new.md",
          actor: "lead",
          payload: { title: "new task" },
        },
        {
          ts: "2026-03-06T02:01:00.000Z",
          event_id: "evt-new-2",
          schema_version: 2,
          event_type: "update_task",
          task_id: "cooperation/tasks/task-new.md",
          actor: "worker",
          payload: { status: "done", current_version: 2 },
        },
      ];

      await writeFile(filePath, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

      const audit = await runReplayOrAudit({
        file: filePath,
        mode: "audit",
        baseline: { ts: "2026-03-06T00:00:00.000Z" },
      });

      expect(audit.pass_current).toBe(true);
      expect(audit.current_issue_count).toBe(0);
      expect(audit.legacy_issue_count).toBeGreaterThan(0);
      expect(
        audit.legacy_issues.some((issue) => issue.type === "missing_required_field" && issue.field === "event_id"),
      ).toBe(true);

      const replay = await runReplayOrAudit({
        file: filePath,
        mode: "replay",
        baseline: { ts: "2026-03-06T00:00:00.000Z" },
      });

      expect(replay.event_count).toBe(2);
      expect(replay.total_event_count).toBe(3);
      expect(replay.task_count).toBe(1);
      expect(replay.tasks[0].task_id).toBe("cooperation/tasks/task-new.md");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reports unauthorized_attempts from sidecar log", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-unauth-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const eventsPath = path.join(logsDir, "events-2026-03-06.jsonl");
      const unauthorizedPath = path.join(logsDir, "unauthorized-attempts-2026-03-06.jsonl");

      await writeFile(eventsPath, `${JSON.stringify({
        ts: "2026-03-06T01:00:00.000Z",
        event_id: "evt-ok",
        schema_version: 2,
        event_type: "post_task",
        task_id: "cooperation/tasks/task-ok.md",
        actor: "trusted",
        payload: { title: "ok" },
      })}
`, "utf8");

      await writeFile(
        unauthorizedPath,
        [
          JSON.stringify({ ts: "2026-03-06T01:02:00.000Z", code: "unauthorized_actor" }),
          JSON.stringify({ ts: "2026-03-06T01:03:00.000Z", code: "disallowed_event_type" }),
        ].join("\n") + "\n",
        "utf8",
      );

      const audit = await runReplayOrAudit({ file: eventsPath, mode: "audit" });
      expect(audit.unauthorized_attempts).toBe(2);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("drops invalid/future/out-of-order timestamps and keeps replay aggregation sane", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-ts-guard-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const filePath = path.join(logsDir, "events-2026-03-10.jsonl");

      const lines = [
        {
          ts: "2026-03-10T02:10:00.000Z",
          event_id: "evt-claim",
          schema_version: 2,
          event_type: "claim_task",
          task_id: "cooperation/tasks/task-ts.md",
          actor: "worker",
          payload: { status: "in_progress", current_version: 2 },
        },
        {
          ts: "2026-03-10T02:00:00.000Z",
          event_id: "evt-post",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-ts.md",
          actor: "lead",
          payload: { title: "Task ts" },
        },
        {
          ts: "not-a-date",
          event_id: "evt-bad-ts",
          schema_version: 2,
          event_type: "update_task",
          task_id: "cooperation/tasks/task-ts.md",
          actor: "worker",
          payload: { status: "blocked", current_version: 3 },
        },
        {
          ts: "2026-03-10T04:00:00.000Z",
          event_id: "evt-future",
          schema_version: 2,
          event_type: "update_task",
          task_id: "cooperation/tasks/task-ts.md",
          actor: "worker",
          payload: { status: "done", current_version: 4 },
        },
      ];

      await writeFile(filePath, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

      const replay = await runReplayOrAudit({
        file: filePath,
        mode: "replay",
        runtimeBaselineFile: null,
        now: "2026-03-10T02:20:00.000Z",
      });

      expect(replay.task_count).toBe(1);
      expect(replay.tasks[0].latest_status).toBe("in_progress");
      expect(replay.event_count).toBe(1);
      expect(replay.timestamp_sanity.dropped_event_count).toBe(3);
      expect(replay.timestamp_sanity.invalid_timestamp_count).toBe(1);
      expect(replay.timestamp_sanity.future_timestamp_count).toBe(1);
      expect(replay.timestamp_sanity.out_of_order_timestamp_count).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps slightly out-of-order events within backward-skew tolerance", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-ts-guard-boundary-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const filePath = path.join(logsDir, "events-2026-03-10.jsonl");

      const lines = [
        {
          ts: "2026-03-10T02:10:00.000Z",
          event_id: "evt-claim",
          schema_version: 2,
          event_type: "claim_task",
          task_id: "cooperation/tasks/task-ts-boundary.md",
          actor: "worker",
          payload: { status: "in_progress", current_version: 2 },
        },
        {
          ts: "2026-03-10T02:06:00.000Z",
          event_id: "evt-post-within-skew",
          schema_version: 2,
          event_type: "post_task",
          task_id: "cooperation/tasks/task-ts-boundary.md",
          actor: "lead",
          payload: { title: "Task ts boundary" },
        },
      ];

      await writeFile(filePath, `${lines.map((x) => JSON.stringify(x)).join("\n")}\n`, "utf8");

      const replay = await runReplayOrAudit({
        file: filePath,
        mode: "replay",
        runtimeBaselineFile: null,
        now: "2026-03-10T02:20:00.000Z",
      });

      expect(replay.event_count).toBe(2);
      expect(replay.timestamp_sanity.out_of_order_timestamp_count).toBe(0);
      expect(replay.tasks[0].latest_status).toBe("in_progress");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("bootstraps missing today events file for midnight audit cutover", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "coop-audit-midnight-bootstrap-"));
    try {
      const logsDir = path.join(tmp, "logs");
      await mkdir(logsDir, { recursive: true });
      const today = "2026-03-11";
      const filePath = path.join(logsDir, `events-${today}.jsonl`);

      const audit = await runReplayOrAudit({
        file: filePath,
        mode: "audit",
        runtimeBaselineFile: null,
        now: `${today}T00:01:00.000Z`,
      });

      await access(filePath);
      expect(audit.pass_current).toBe(true);
      expect(audit.event_count).toBe(0);
      expect(audit.current_issue_count).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

});
