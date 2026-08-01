import { describe, it, expect } from "vitest";
import { detectRuntimeBoundaryViolations } from "../scripts/check-runtime-boundary.mjs";

describe("runtime artifact boundary", () => {
  it("flags tracked runtime artifacts", () => {
    const files = [
      "src/index.ts",
      ".agent-coop/config.yaml",
      ".agent-coop/cooperation/tasks/task-a.md",
      "next-round.json",
      "examples/next-round.sample.json",
    ];

    expect(detectRuntimeBoundaryViolations(files)).toEqual([
      ".agent-coop/config.yaml",
      ".agent-coop/cooperation/tasks/task-a.md",
      "next-round.json",
    ]);
  });

  it("allows source and examples", () => {
    const files = ["README.md", "examples/trust-policy.minimal.yaml", "src/tools/coop.ts"];
    expect(detectRuntimeBoundaryViolations(files)).toEqual([]);
  });
});
