import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type TaskStatus = "open" | "in_progress" | "done" | "blocked" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export const MESSAGE_KINDS = [
  "notice",
  "help_request",
  "clarification_request",
  "review_request",
  "handoff",
  "dependency_ready",
  "cancel_request",
  "decision",
  "escalation",
] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];
export const MESSAGE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type MessagePriority = typeof MESSAGE_PRIORITIES[number];

export interface TaskFrontmatter {
  status: TaskStatus;
  priority: TaskPriority;
  created_by: string;
  assignee: string | null;
  created: string;
  updated: string;
  tags: string[];
  depends_on: string[];
  version: number;
}

export interface CoopTask {
  frontmatter: TaskFrontmatter;
  title: string;
  body: string;
  filePath: string;
}

export interface MessageFrontmatter {
  message_id: string;
  kind: MessageKind;
  from: string;
  to: string | null;
  created: string;
  expires_at: string | null;
  priority: MessagePriority;
  task_id: string | null;
  expected_task_version: number | null;
  source_commit: string | null;
  thread_id: string;
  correlation_id: string | null;
  reply_to: string | null;
  requires_ack: boolean;
  dedupe_key: string;
  tags: string[];
  /** Legacy read compatibility. New readers use append-only receipts. */
  read_by: string[];
}

export interface CoopMessage {
  frontmatter: MessageFrontmatter;
  subject: string;
  body: string;
  filePath: string;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function parseTask(raw: string, filePath: string): CoopTask {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Invalid task format (no frontmatter): ${filePath}`);
  const frontmatter = parseYaml(match[1]) as TaskFrontmatter;
  frontmatter.tags = frontmatter.tags ?? [];
  frontmatter.depends_on = frontmatter.depends_on ?? [];
  frontmatter.version = Number.isFinite(frontmatter.version) ? frontmatter.version : 1;
  // Normalize priority to lowercase
  if (frontmatter.priority) {
    frontmatter.priority = frontmatter.priority.toLowerCase() as TaskPriority;
  }
  const body = match[2].trim();
  const titleMatch = body.match(/^#\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : filePath;
  const content = titleMatch ? body.slice(titleMatch[0].length).trim() : body;
  return { frontmatter, title, body: content, filePath };
}

export function serializeTask(task: Omit<CoopTask, "filePath">): string {
  const fm = stringifyYaml(task.frontmatter, { lineWidth: 0 }).trim();
  return `---\n${fm}\n---\n# ${task.title}\n\n${task.body}\n`;
}

export function parseMessage(raw: string, filePath: string): CoopMessage {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) throw new Error(`Invalid message format (no frontmatter): ${filePath}`);
  const frontmatter = parseYaml(match[1]) as MessageFrontmatter;
  frontmatter.message_id = frontmatter.message_id ?? filePath;
  frontmatter.kind = MESSAGE_KINDS.includes(frontmatter.kind) ? frontmatter.kind : "notice";
  frontmatter.priority = MESSAGE_PRIORITIES.includes(frontmatter.priority) ? frontmatter.priority : "normal";
  frontmatter.expires_at = frontmatter.expires_at ?? null;
  frontmatter.task_id = frontmatter.task_id ?? null;
  frontmatter.expected_task_version = Number.isInteger(frontmatter.expected_task_version)
    ? Number(frontmatter.expected_task_version)
    : null;
  frontmatter.source_commit = frontmatter.source_commit ?? null;
  frontmatter.thread_id = frontmatter.thread_id ?? frontmatter.task_id ?? frontmatter.message_id;
  frontmatter.correlation_id = frontmatter.correlation_id ?? null;
  frontmatter.reply_to = frontmatter.reply_to ?? null;
  frontmatter.requires_ack = frontmatter.requires_ack === true;
  frontmatter.dedupe_key = frontmatter.dedupe_key ?? frontmatter.message_id;
  frontmatter.tags = frontmatter.tags ?? [];
  frontmatter.read_by = frontmatter.read_by ?? [];
  const body = match[2].trim();
  const titleMatch = body.match(/^#\s+(.+)/m);
  const subject = titleMatch ? titleMatch[1].trim() : filePath;
  const content = titleMatch ? body.slice(titleMatch[0].length).trim() : body;
  return { frontmatter, subject, body: content, filePath };
}

export function serializeMessage(msg: Omit<CoopMessage, "filePath">): string {
  const fm = stringifyYaml(msg.frontmatter, { lineWidth: 0 }).trim();
  return `---\n${fm}\n---\n# ${msg.subject}\n\n${msg.body}\n`;
}
