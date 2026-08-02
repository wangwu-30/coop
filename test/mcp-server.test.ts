import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const originalAgentId = process.env.AGENT_COOP_AGENT_ID;

afterEach(() => {
  process.env.AGENT_COOP_AGENT_ID = originalAgentId;
});

describe("MCP adapter", () => {
  it("advertises safe workflow instructions and the core cooperation tools", async () => {
    process.env.AGENT_COOP_AGENT_ID = "codex-test";
    const server = createServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      expect(client.getInstructions()).toContain("codex-test");
      expect(client.getInstructions()).toContain("Do not start business work unless pushed=true");
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("coop_claim_task");
      expect(names).toContain("coop_send_message");
      expect(names).toContain("coop_get_global_state");
      expect(names).toContain("coop_reconcile");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
