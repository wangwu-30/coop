#!/usr/bin/env node
import {
  coopAcknowledgeMessage,
  coopCheckInbox,
  coopClaimTask,
  coopGetGlobalState,
  coopGetTask,
  coopInit,
  coopListTasks,
  coopPostTask,
  coopPublishState,
  coopReadMessages,
  coopReconcile,
  coopSendMessage,
  coopSync,
  coopUpdateTask,
  type MessageKind,
  type MessagePriority,
  type MessageReceiptStatus,
  type TaskPriority,
  type TaskStatus,
} from "./core/index.js";
import { installClientAdapters, type AgentClient } from "./adapters/client-install.js";
import { runDoctor } from "./adapters/doctor.js";

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function requireOption(name: string): string {
  const value = readOption(name)?.trim();
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function readList(name: string): string[] | undefined {
  const value = readOption(name);
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readPositiveInteger(name: string): number | undefined {
  const value = readOption(name);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function printResult(result: string | Record<string, unknown>): void {
  if (typeof result !== "string") {
    console.log(JSON.stringify(result, null, 2));
    if ("error" in result || result.ok === false) process.exitCode = 1;
    return;
  }
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    console.log(JSON.stringify(parsed, null, 2));
    if (parsed.error) process.exitCode = 1;
  } catch {
    console.log(result);
  }
}

function usage(): string {
  return [
    "Usage:",
    "  coop init --coop-dir <path> [--remote <url>]",
    "  coop sync --coop-dir <path> [--remote <name>]",
    "  coop state --coop-dir <path> [--last-seen <sha>] [--no-fetch]",
    "  coop push --coop-dir <path> [--remote <name>] [--branch <name>]",
    "  coop reconcile --coop-dir <path> [--discard-local-candidate --expected-local-revision <sha>]",
    "  coop install --client codex|claude|both --project-dir <path> --coop-dir <path> [--dry-run]",
    "  coop doctor --client codex|claude|both --project-dir <path> --coop-dir <path>",
    "",
    "  coop task list [--status <status>] [--assignee <id>] [--priority <priority>] [--tags a,b]",
    "  coop task get --task-id <path>",
    "  coop task post --title <text> --body <text> --source <agent> [--priority <priority>] [--tags a,b]",
    "  coop task claim --task-id <path> --assignee <agent> --expected-version <n>",
    "  coop task update --task-id <path> --expected-version <n> [--status <status>] [--comment <text>]",
    "",
    "  coop message send --from <agent> --to <agent> --subject <text> --body <text> [--kind <kind>]",
    "  coop message inbox --agent-id <agent> [--no-fetch]",
    "  coop message read [--recipient <agent>] [--since <iso>] [--kinds a,b]",
    "  coop message ack --message-id <path> --actor <agent> [--status read|ack|reject]",
    "",
    "Run `agent-coop` to start the MCP stdio server.",
  ].join("\n");
}

async function runTaskCommand(action: string | undefined): Promise<string> {
  if (action === "list") {
    return coopListTasks({
      status: readOption("--status") as TaskStatus | undefined,
      assignee: readOption("--assignee"),
      priority: readOption("--priority") as TaskPriority | undefined,
      tags: readList("--tags"),
    });
  }
  if (action === "get") return coopGetTask({ task_id: requireOption("--task-id") });
  if (action === "post") {
    return coopPostTask({
      title: requireOption("--title"),
      body: requireOption("--body"),
      source: requireOption("--source"),
      priority: readOption("--priority") as TaskPriority | undefined,
      tags: readList("--tags"),
    });
  }
  if (action === "claim") {
    return coopClaimTask({
      task_id: requireOption("--task-id"),
      assignee: requireOption("--assignee"),
      expected_version: readPositiveInteger("--expected-version"),
    });
  }
  if (action === "update") {
    return coopUpdateTask({
      task_id: requireOption("--task-id"),
      status: readOption("--status") as TaskStatus | undefined,
      comment: readOption("--comment"),
      assignee: readOption("--assignee"),
      depends_on: readList("--depends-on"),
      expected_version: readPositiveInteger("--expected-version"),
    });
  }
  throw new Error(`Unknown task action: ${action ?? "<missing>"}`);
}

async function runMessageCommand(action: string | undefined): Promise<string> {
  if (action === "send") {
    return coopSendMessage({
      from: requireOption("--from"),
      to: readOption("--to"),
      kind: readOption("--kind") as MessageKind | undefined,
      subject: requireOption("--subject"),
      body: requireOption("--body"),
      priority: readOption("--priority") as MessagePriority | undefined,
      task_id: readOption("--task-id"),
      expected_task_version: readPositiveInteger("--expected-task-version"),
      source_commit: readOption("--source-commit"),
      thread_id: readOption("--thread-id"),
      correlation_id: readOption("--correlation-id"),
      reply_to: readOption("--reply-to"),
      requires_ack: hasFlag("--requires-ack"),
      expires_at: readOption("--expires-at"),
      dedupe_key: readOption("--dedupe-key"),
      tags: readList("--tags"),
    });
  }
  if (action === "inbox") {
    return coopCheckInbox({
      agent_id: requireOption("--agent-id"),
      fetch: !hasFlag("--no-fetch"),
      remote: readOption("--remote"),
      branch: readOption("--branch"),
    });
  }
  if (action === "read") {
    return coopReadMessages({
      recipient: readOption("--recipient"),
      since: readOption("--since"),
      kinds: readList("--kinds") as MessageKind[] | undefined,
      task_id: readOption("--task-id"),
      tags: readList("--tags"),
      include_expired: hasFlag("--include-expired"),
      mark_read_as: readOption("--mark-read-as"),
    });
  }
  if (action === "ack") {
    return coopAcknowledgeMessage({
      message_id: requireOption("--message-id"),
      actor: requireOption("--actor"),
      status: readOption("--status") as MessageReceiptStatus | undefined,
      note: readOption("--note"),
    });
  }
  throw new Error(`Unknown message action: ${action ?? "<missing>"}`);
}

async function main() {
  const coopDir = readOption("--coop-dir");
  if (coopDir) process.env.AGENT_COOP_DIR = coopDir;
  const command = process.argv[2] ?? "help";

  if (command === "init") {
    printResult(await coopInit({ remote: readOption("--remote") }));
    return;
  }
  if (command === "sync") {
    printResult(await coopSync({ remote: readOption("--remote") }));
    return;
  }
  if (command === "state") {
    printResult(await coopGetGlobalState({
      last_seen_commit: readOption("--last-seen"),
      remote: readOption("--remote"),
      branch: readOption("--branch"),
      fetch: !hasFlag("--no-fetch"),
    }));
    return;
  }
  if (command === "push") {
    printResult(await coopPublishState({
      remote: readOption("--remote"),
      branch: readOption("--branch"),
    }));
    return;
  }
  if (command === "reconcile") {
    printResult(await coopReconcile({
      remote: readOption("--remote"),
      branch: readOption("--branch"),
      discard_local_candidate: hasFlag("--discard-local-candidate"),
      expected_local_revision: readOption("--expected-local-revision"),
    }));
    return;
  }
  if (command === "install") {
    const client = requireOption("--client") as AgentClient;
    if (!new Set(["codex", "claude", "both"]).has(client)) throw new Error(`Unsupported client: ${client}`);
    const result = await installClientAdapters({
      client,
      projectDir: readOption("--project-dir") ?? process.cwd(),
      coopDir: requireOption("--coop-dir"),
      serverEntry: readOption("--server-entry"),
      codexAgentId: readOption("--codex-agent-id"),
      claudeAgentId: readOption("--claude-agent-id"),
      dryRun: hasFlag("--dry-run"),
    });
    printResult(result as unknown as Record<string, unknown>);
    return;
  }
  if (command === "doctor") {
    const result = await runDoctor({
      client: (readOption("--client") ?? "both") as AgentClient,
      projectDir: readOption("--project-dir") ?? process.cwd(),
      coopDir: requireOption("--coop-dir"),
      serverEntry: readOption("--server-entry"),
      remote: readOption("--remote"),
    });
    printResult(result as unknown as Record<string, unknown>);
    return;
  }
  if (command === "task") {
    printResult(await runTaskCommand(process.argv[3]));
    return;
  }
  if (command === "message") {
    printResult(await runMessageCommand(process.argv[3]));
    return;
  }

  console.log(usage());
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: "cli_error",
    message: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
