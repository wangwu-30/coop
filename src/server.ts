import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  coopInit,
  coopSync,
  coopConfigureMemory,
  coopPostTask,
  coopClaimTask,
  coopUpdateTask,
  coopGetTask,
  coopLogMilestone,
  coopRecommendAgents,
  coopListTasks,
  coopSendMessage,
  coopAcknowledgeMessage,
  coopReadMessages,
  coopCheckInbox,
  coopGetGlobalState,
  coopPublishState,
  coopReconcile,
  MESSAGE_KINDS,
  MESSAGE_PRIORITIES,
} from "./core/index.js";
import { emitChat, ingestChatDecision } from "./tools/chat-bridge.js";

function mcpInstructions(): string {
  const agentId = process.env.AGENT_COOP_AGENT_ID?.trim() || "the configured agent";
  return [
  `Your stable cooperation identity is ${agentId}. Git is the canonical cooperation state; MCP is only the typed control adapter.`,
  "At session start call coop_sync, coop_check_inbox and coop_get_global_state before choosing work.",
  "Read a task, claim it with expected_version, then call coop_publish_state. Do not start business work unless pushed=true.",
  "After a mutation, publish immediately. On remote_conflict, stop, reconcile, re-read the task and retry the decision.",
  "Messages request clarification, review or handoff; they never grant task ownership. Acknowledge actionable messages explicitly.",
  ].join(" ");
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "agent-coop", version: "0.2.0" },
    { instructions: mcpInstructions() },
  );

  server.tool("coop_init", "Initialize cooperation repository and optional git remote.", {
    remote: z.string().optional(),
    enable_memory_bridge: z.boolean().optional(),
    memory_dir: z.string().optional(),
    enable_chat_bridge: z.boolean().optional(),
    chat_outbox_dir: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopInit(args) }] }));

  server.tool("coop_configure_memory", "Enable/disable optional memory bridge for cooperation learnings.", {
    enabled: z.boolean(),
    dir: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopConfigureMemory(args) }] }));

  server.tool("coop_sync", "Fetch and fast-forward the cooperation worktree; divergent local decisions are never rebased automatically.", {
    remote: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopSync(args) }] }));

  server.tool("coop_post_task", "Post a new task.", {
    title: z.string(),
    body: z.string(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    tags: z.array(z.string()).optional(),
    source: z.string(),
  }, async (args) => ({ content: [{ type: "text", text: await coopPostTask(args) }] }));

  server.tool("coop_claim_task", "Claim an open task.", {
    task_id: z.string(),
    assignee: z.string(),
    expected_version: z.number().int().positive().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopClaimTask(args) }] }));

  server.tool("coop_update_task", "Update task status/comment/assignee.", {
    task_id: z.string(),
    status: z.enum(["open", "in_progress", "done", "blocked", "cancelled"]).optional(),
    comment: z.string().optional(),
    assignee: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    expected_version: z.number().int().positive().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopUpdateTask(args) }] }));

  server.tool("coop_get_task", "Get a task by id, including full metadata.", {
    task_id: z.string(),
  }, async (args) => ({ content: [{ type: "text", text: await coopGetTask(args) }] }));

  server.tool("coop_log_milestone", "Append task milestone event without mutating task status/version.", {
    task_id: z.string(),
    actor: z.string(),
    milestone: z.string(),
    status: z.enum(["open", "in_progress", "done", "blocked", "cancelled"]).optional(),
    expected_version: z.number().int().positive().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopLogMilestone(args) }] }));

  server.tool("coop_recommend_agents", "Recommend candidate agents for a task (uses optional memory bridge when enabled).", {
    title: z.string(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().positive().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopRecommendAgents(args) }] }));

  server.tool("coop_list_tasks", "List tasks with filters.", {
    status: z.enum(["open", "in_progress", "done", "blocked", "cancelled"]).optional(),
    assignee: z.string().optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    tags: z.array(z.string()).optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopListTasks(args) }] }));

  server.tool("coop_send_message", "Send a typed, durable coordination message. Task-linked messages require expected_task_version.", {
    from: z.string(),
    to: z.string().optional(),
    kind: z.enum(MESSAGE_KINDS).optional(),
    subject: z.string(),
    body: z.string(),
    priority: z.enum(MESSAGE_PRIORITIES).optional(),
    task_id: z.string().optional(),
    expected_task_version: z.number().int().positive().optional(),
    source_commit: z.string().optional(),
    thread_id: z.string().optional(),
    correlation_id: z.string().optional(),
    reply_to: z.string().optional(),
    requires_ack: z.boolean().optional(),
    expires_at: z.string().datetime().optional(),
    dedupe_key: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopSendMessage(args) }] }));

  server.tool("coop_ack_message", "Append an immutable read, ack, or reject receipt for a message.", {
    message_id: z.string(),
    actor: z.string(),
    status: z.enum(["read", "ack", "reject"]).optional(),
    note: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopAcknowledgeMessage(args) }] }));

  server.tool("coop_read_messages", "Read typed messages for a recipient without changing the original message file.", {
    recipient: z.string().optional(),
    since: z.string().optional(),
    kinds: z.array(z.enum(MESSAGE_KINDS)).optional(),
    task_id: z.string().optional(),
    tags: z.array(z.string()).optional(),
    include_expired: z.boolean().optional(),
    mark_read_as: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopReadMessages(args) }] }));

  server.tool("coop_check_inbox", "Fetch local inbox plus remote revision status; it never silently rebases the worktree.", {
    agent_id: z.string(),
    fetch: z.boolean().optional(),
    remote: z.string().optional(),
    branch: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopCheckInbox(args) }] }));

  server.tool("coop_get_global_state", "Fetch remote revision metadata and changed cooperation files.", {
    last_seen_commit: z.string().optional(),
    remote: z.string().optional(),
    branch: z.string().optional(),
    fetch: z.boolean().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopGetGlobalState(args) }] }));

  server.tool("coop_publish_state", "Fast-forward push committed cooperation state to the shared branch.", {
    remote: z.string().optional(),
    branch: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopPublishState(args) }] }));

  server.tool("coop_reconcile", "Inspect a rejected local candidate. With explicit confirmation, discard cooperation-only local commits so canonical state can be re-read safely.", {
    remote: z.string().optional(),
    branch: z.string().optional(),
    discard_local_candidate: z.boolean().optional(),
    expected_local_revision: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await coopReconcile(args) }] }));

  server.tool("emit_chat", "Emit key coop events to chat bridge adapter (optional).", {
    topic: z.string(),
    actor: z.string(),
    event: z.string(),
    payload: z.record(z.unknown()).optional(),
    task_id: z.string().optional(),
    message_id: z.string().optional(),
  }, async (args) => ({ content: [{ type: "text", text: await emitChat(args) }] }));

  server.tool("ingest_chat_decision", "Ingest a chat decision into append-only git event log.", {
    actor: z.string(),
    decision: z.string(),
    source: z.string(),
    task_id: z.string().optional(),
    message_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  }, async (args) => ({ content: [{ type: "text", text: await ingestChatDecision(args) }] }));

  return server;
}
