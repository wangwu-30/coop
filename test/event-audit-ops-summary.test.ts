import { describe, it, expect } from "vitest";
import { summarizeEvents } from "../scripts/event-audit-ops-summary.mjs";

describe("event-audit-ops-summary", () => {
  it("marks observer-only risk when no worker activity exists", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:30:00.000Z", event_type: "post_task", actor: "observer-pm" },
      { ts: "2026-03-08T09:40:00.000Z", event_type: "update_task", actor: "coop-leader", payload: { status: "open" } },
    ];

    const report = summarizeEvents(events, now, 120);
    expect(report.summary.event_type_counts.post_task).toBe(1);
    expect(report.summary.event_type_counts.done_task).toBe(0);
    expect(report.summary.observer_only_active).toBe(true);
    expect(report.risks[0]?.code).toBe("observer_only_activity");
  });

  it("flags worker throughput risk when worker signals are below threshold", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:30:00.000Z", event_type: "post_task", actor: "coop-leader" },
      { ts: "2026-03-08T09:40:00.000Z", event_type: "claim_task", actor: "coop-worker-3" },
    ];

    const report = summarizeEvents(events, now, 120, 2);
    expect(report.summary.worker_throughput_signals).toBe(1);
    expect(report.summary.worker_throughput_min).toBe(2);
    expect(report.summary.actor_contribution_share["coop-leader"]).toBe(0.5);
    expect(report.summary.actor_contribution_share["coop-worker-3"]).toBe(0.5);
    expect(report.risks[0]?.code).toBe("worker_throughput_below_min");
  });

  it("does not flag throughput risk when worker signals meet threshold", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:30:00.000Z", event_type: "claim_task", actor: "coop-worker-3" },
      { ts: "2026-03-08T09:40:00.000Z", event_type: "update_task", actor: "coop-worker-3", payload: { status: "done" } },
    ];

    const report = summarizeEvents(events, now, 120, 2);
    expect(report.summary.event_type_counts.claim_task).toBe(1);
    expect(report.summary.event_type_counts.done_task).toBe(1);
    expect(report.summary.observer_only_active).toBe(false);
    expect(report.risks.some((risk) => risk.code === "worker_throughput_below_min")).toBe(false);
  });

  it("flags evidence-chain blind spot and recovers historical chain by task", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T07:00:00.000Z", event_type: "post_task", actor: "coop-leader", task_id: "task-1" },
      { ts: "2026-03-08T09:30:00.000Z", event_type: "claim_task", actor: "coop-worker-3", task_id: "task-1" },
      { ts: "2026-03-08T09:40:00.000Z", event_type: "done_task", actor: "coop-worker-3", task_id: "task-1" },
    ];

    const report = summarizeEvents(events, now, 120, 2);
    expect(report.summary.event_type_counts.post_task).toBe(0);
    expect(report.summary.chain_visibility.signal_task_count).toBe(1);
    expect(report.summary.chain_visibility.signal_without_window_chain).toBe(1);
    expect(report.summary.chain_visibility.signal_recovered_by_history).toBe(1);
    expect(report.summary.chain_visibility.signal_unrecovered_missing_chain).toBe(0);
    expect(report.summary.chain_visibility.root_cause_breakdown.normal_old_task_processing).toBe(1);
    expect(report.risks.some((risk) => risk.code === "evidence_chain_window_blind_spot")).toBe(true);
  });

  it("normalizes generic coop-worker actor for claim/done contribution share", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      {
        ts: "2026-03-08T09:30:00.000Z",
        event_type: "claim_task",
        actor: "coop-worker",
        task_id: "task-1773120103831-worker3-actor-normalization-guardrail",
        payload: { assignee: "coop-worker-3" },
      },
      {
        ts: "2026-03-08T09:40:00.000Z",
        event_type: "done_task",
        actor: "coop-worker",
        task_id: "task-1773120103831-worker3-actor-normalization-guardrail",
      },
    ];

    const report = summarizeEvents(events, now, 120, 2);
    expect(report.summary.actor_counts_raw["coop-worker"]).toBe(2);
    expect(report.summary.actor_counts_normalized["coop-worker-3"]).toBe(2);
    expect(report.summary.actor_contribution_share["coop-worker-3"]).toBe(1);
    expect(report.summary.actor_contribution_share["coop-worker"]).toBeUndefined();
  });

  it("escalates chain blind spot when unrecovered missing chain stays high", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:10:00.000Z", event_type: "claim_task", actor: "coop-worker-1", task_id: "task-a" },
      { ts: "2026-03-08T09:20:00.000Z", event_type: "claim_task", actor: "coop-worker-2", task_id: "task-b" },
      { ts: "2026-03-08T09:30:00.000Z", event_type: "done_task", actor: "coop-worker-3", task_id: "task-c" },
    ];

    const report = summarizeEvents(events, now, 120, 2);
    const blindSpotRisk = report.risks.find((risk) => risk.code === "evidence_chain_window_blind_spot");
    expect(report.summary.chain_visibility.signal_without_window_chain).toBe(3);
    expect(report.summary.chain_visibility.signal_recovered_by_history).toBe(0);
    expect(report.summary.chain_visibility.signal_unrecovered_missing_chain).toBe(3);
    expect(report.summary.chain_visibility.high_blind_spot).toBe(true);
    expect(blindSpotRisk?.level).toBe("high");
  });

  it("emits actor_skew when some workers have zero contribution", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:10:00.000Z", event_type: "claim_task", actor: "coop-worker-1", task_id: "task-a" },
      { ts: "2026-03-08T09:20:00.000Z", event_type: "done_task", actor: "coop-worker-1", task_id: "task-a" },
      { ts: "2026-03-08T09:30:00.000Z", event_type: "post_task", actor: "coop-leader" },
    ];

    const report = summarizeEvents(events, now, 120, 1, 0.6);
    expect(report.summary.actor_skew.triggered).toBe(true);
    expect(report.summary.actor_skew.zero_contribution_workers).toContain("coop-worker-2");
    expect(report.summary.actor_skew.zero_contribution_workers).toContain("coop-worker-3");
    expect(report.risks.some((risk) => risk.code === "actor_skew")).toBe(true);
  });

  it("emits actor_skew when dominant worker share exceeds threshold", () => {
    const now = "2026-03-08T10:00:00.000Z";
    const events = [
      { ts: "2026-03-08T09:00:00.000Z", event_type: "claim_task", actor: "coop-worker-1", task_id: "task-a" },
      { ts: "2026-03-08T09:05:00.000Z", event_type: "done_task", actor: "coop-worker-1", task_id: "task-a" },
      { ts: "2026-03-08T09:10:00.000Z", event_type: "claim_task", actor: "coop-worker-2", task_id: "task-b" },
      { ts: "2026-03-08T09:15:00.000Z", event_type: "done_task", actor: "coop-worker-1", task_id: "task-c" },
    ];

    const report = summarizeEvents(events, now, 120, 1, 0.7);
    expect(report.summary.actor_skew.max_worker).toBe("coop-worker-1");
    expect(report.summary.actor_skew.max_worker_share).toBe(0.75);
    expect(report.summary.actor_skew.triggered).toBe(true);
    const skewRisk = report.risks.find((risk) => risk.code === "actor_skew");
    expect(skewRisk?.evidence?.recommended_rebalance?.length).toBeGreaterThan(0);
  });

});
