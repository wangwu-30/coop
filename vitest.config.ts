import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These suites cover the retired self-healing flywheel kept under legacy/.
    // The active quality gate exercises the new cooperation kernel only.
    exclude: [
      "test/flywheel-audit-dedupe.test.ts",
      "test/loop-run-once.test.ts",
      "test/next-round-to-dispatch.test.ts",
      "test/open-queue-seeding-guard.test.ts",
      "test/open-task-default-paths.test.ts",
      "test/open-task-progress-heartbeat.test.ts",
      "test/optimizer-loop.test.ts",
    ],
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "json", "html"],
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.d.ts"],
    all: true,
  },
});
