import { describe, it, expect } from "vitest";
import { normalizeActor } from "../scripts/generic-actor-enforcer.mjs";

describe("generic-actor-enforcer", () => {
  it("normalizes generic coop-worker actor to assignee or task worker", () => {
    expect(
      normalizeActor({
        actor: "coop-worker",
        task_id: "cooperation/tasks/task-1773120604536-worker3-actor-normalization-enforcer.md",
        payload: { assignee: "coop-worker-3" },
      }),
    ).toBe("coop-worker-3");

    expect(
      normalizeActor({
        actor: "coop-worker",
        task_id: "cooperation/tasks/task-1773120604535-worker2-stagnation-auto-nudge.md",
      }),
    ).toBe("coop-worker-2");
  });
});
