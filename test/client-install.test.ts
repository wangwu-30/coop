import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { installClientAdapters } from "../src/adapters/client-install.js";
import { runDoctor } from "../src/adapters/doctor.js";
import { coopInit } from "../src/core/index.js";

const exec = promisify(execFile);
const originalCoopDir = process.env.AGENT_COOP_DIR;
const roots: string[] = [];

afterEach(async () => {
  process.env.AGENT_COOP_DIR = originalCoopDir;
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("Codex and Claude adapter installation", () => {
  it("installs idempotent client config while preserving existing project content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-client-install-"));
    roots.push(root);
    const projectDir = path.join(root, "business");
    const coopDir = path.join(root, "coop-state");
    const remote = path.join(root, "remote.git");
    const serverEntry = path.join(root, "server.mjs");
    await Promise.all([
      fs.mkdir(path.join(projectDir, ".codex"), { recursive: true }),
      fs.mkdir(coopDir, { recursive: true }),
      exec("git", ["init", "--bare", remote]),
      fs.writeFile(serverEntry, "// fixture\n", "utf8"),
    ]);
    await fs.writeFile(path.join(projectDir, ".codex", "config.toml"), "model = \"fixture\"\n", "utf8");
    await fs.writeFile(path.join(projectDir, ".mcp.json"), JSON.stringify({
      mcpServers: { existing: { type: "stdio", command: "true", args: [] } },
    }, null, 2), "utf8");
    await fs.writeFile(path.join(projectDir, "AGENTS.md"), "# Existing Codex guidance\n", "utf8");
    await fs.writeFile(path.join(projectDir, "CLAUDE.md"), "# Existing Claude guidance\n", "utf8");

    process.env.AGENT_COOP_DIR = coopDir;
    await coopInit({ remote });
    const first = await installClientAdapters({
      client: "both",
      projectDir,
      coopDir,
      serverEntry,
    });
    expect(first.files.filter((file) => file.action === "created" || file.action === "updated")).toHaveLength(4);

    const second = await installClientAdapters({
      client: "both",
      projectDir,
      coopDir,
      serverEntry,
    });
    expect(second.files.every((file) => file.action === "unchanged")).toBe(true);

    const codexConfig = await fs.readFile(path.join(projectDir, ".codex", "config.toml"), "utf8");
    expect(codexConfig).toContain("model = \"fixture\"");
    expect(codexConfig.match(/\[mcp_servers\.agent_coop\]/g)).toHaveLength(1);
    expect(codexConfig).toContain("AGENT_COOP_AGENT_ID = \"codex\"");

    const claudeConfig = JSON.parse(await fs.readFile(path.join(projectDir, ".mcp.json"), "utf8"));
    expect(claudeConfig.mcpServers.existing).toBeTruthy();
    expect(claudeConfig.mcpServers["agent-coop"].env.AGENT_COOP_AGENT_ID).toBe("claude-code");

    const agents = await fs.readFile(path.join(projectDir, "AGENTS.md"), "utf8");
    const claude = await fs.readFile(path.join(projectDir, "CLAUDE.md"), "utf8");
    expect(agents).toContain("# Existing Codex guidance");
    expect(claude).toContain("# Existing Claude guidance");
    expect(agents.match(/agent-coop managed instructions/g)).toHaveLength(2);
    expect(claude.match(/agent-coop managed instructions/g)).toHaveLength(2);

    const doctor = await runDoctor({ client: "both", projectDir, coopDir, serverEntry });
    expect(doctor.ok).toBe(true);
    expect(doctor.checks.every((check) => check.ok)).toBe(true);
  });

  it("refuses to overwrite malformed Claude configuration", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-coop-client-invalid-"));
    roots.push(root);
    const projectDir = path.join(root, "business");
    const coopDir = path.join(root, "coop-state");
    const serverEntry = path.join(root, "server.mjs");
    await Promise.all([
      fs.mkdir(projectDir, { recursive: true }),
      fs.mkdir(coopDir, { recursive: true }),
      fs.writeFile(serverEntry, "// fixture\n", "utf8"),
    ]);
    await fs.writeFile(path.join(projectDir, ".mcp.json"), "{invalid", "utf8");

    await expect(installClientAdapters({
      client: "claude",
      projectDir,
      coopDir,
      serverEntry,
    })).rejects.toThrow("Cannot update invalid JSON");
    expect(await fs.readFile(path.join(projectDir, ".mcp.json"), "utf8")).toBe("{invalid");
  });
});
