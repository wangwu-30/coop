import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("core transport boundary", () => {
  it("does not import MCP or client-specific adapters", async () => {
    const source = await fs.readFile(path.join(root, "src", "core", "index.ts"), "utf8");
    expect(source).not.toContain("@modelcontextprotocol");
    expect(source).not.toMatch(/from ["']\.\.\/server/);
    expect(source).not.toMatch(/from ["']\.\.\/adapters/);
  });
});
