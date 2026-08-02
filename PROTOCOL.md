# agent-coop Protocol (MVP)

## 1) Source of truth: Git

All collaboration state lives in this repository as versioned files.

- Tasks: `cooperation/tasks/*.md`
- Messages: `cooperation/messages/*.md`
- Message receipts: `cooperation/message-receipts/*.json`
- Config: `config.yaml`

If memory or runtime caches disagree with files in Git, **Git wins**.

All processes must use one canonical root. Resolution order is explicit
`--coop-dir`, then `AGENT_COOP_DIR`, then the current working directory. HOME is
never an implicit second repository.

## 2) Local/Remote topology

### Local workspace
Each Agent uses a business-code worktree plus a coordination checkout. Agents
on one machine may share the coordination checkout because Git mutations are
serialized repository-wide. Agents on different machines use independent
checkouts of the same branch.

### Remote workspace (shared)
A shared Git remote is used to exchange state across agents/machines.

Default topology: the business remote owns a dedicated `coop-state` branch.
Use a separate cooperation repository only for multi-repository coordination
or a distinct permission/retention boundary.

Typical loop:
1. fetch and fast-forward from remote
2. write/update task or message files
3. commit
4. push

This keeps coordination deterministic and auditable.

`coop_sync` never rebases divergent local coordination commits. Divergence
means a provisional local decision lost the global race and requires explicit
reconciliation. `coop_reconcile` may discard a rejected candidate only after
verifying its exact revision and proving every changed path belongs to
canonical cooperation state. Candidates containing business files require
manual handling.

## 3) Task lifecycle

Task files are markdown with YAML frontmatter. Minimal status flow:

`open -> in_progress -> done`

`blocked` and `cancelled` are allowed terminal/side states.

Use `version` to reject stale local writes. A repository-wide lock serializes
all writers and Git commits inside one checkout; a fast-forward-only push to
the shared coordination branch is the cross-machine compare-and-swap boundary.

A local claim is provisional. It becomes globally accepted only after
`coop_publish_state` reports `pushed=true`. A rejected push requires a fetch and
fresh task decision; the worker must not begin work from the rejected claim.

Authorization and event validation happen before a task is changed. A task and
its event evidence are committed together. Rejected authorization must leave
the task byte-for-byte unchanged.

## 4) Typed coordination mailbox

Messages are durable requests and explanations, not task state. Supported
message kinds are:

- `notice`
- `help_request`
- `clarification_request`
- `review_request`
- `handoff`
- `dependency_ready`
- `cancel_request`
- `decision`
- `escalation`

Every new message has a stable `message_id`, `kind`, sender, recipient or
broadcast, priority, thread, dedupe key and optional expiration. A task-linked
message must also carry `task_id`, `expected_task_version` and `source_commit`.
The sender is rejected if the observed task version is already stale.

Delivery is at-least-once. `dedupe_key` is scoped to the sender: retrying the
same payload returns the existing message, while reusing the key for different
content returns `dedupe_conflict`.

Readers never modify a message. Read, ack and reject are stored as immutable
receipt files and append-only `message_read`, `message_ack` or
`message_reject` events. A task-linked ack re-checks the referenced task
version; a stale message cannot authorize action. The recipient must still
claim the task and publish that claim successfully before starting work.

Expired messages are hidden by default and cannot be acknowledged as current.
Messages and notification delivery are not correctness dependencies: after a
message arrives, fetch Git state and validate the task again.

## 5) Optional memory bridge

`memoryBridge.enabled` is optional and defaults to `false`.

When enabled, memory may store lightweight completion hints for routing/recommendation. It must **never** overwrite canonical task state.

- Truth fields (status/depends_on/version/etc.): Git task files
- Advisory hints: memory bridge

## 6) Event log policy (append-only)

Collaboration events are persisted as append-only JSONL logs:
- `logs/events-YYYY-MM-DD.jsonl`

Writers append new lines only. Existing lines should not be rewritten.

Trust policy (`policy.yaml`) can be optionally enabled to enforce:
- `allowlist_actors`
- `allowed_event_types`

Projects using typed receipts should allow `send_message`, `message_read`,
`message_ack` and `message_reject` for the relevant actors.

If policy is absent, legacy task publication remains open while state-changing
events use the built-in core actor set. Install `policy.yaml` to define the
project-specific actor and event allowlists.
Rejected writes return structured errors and are recorded in:
- `logs/unauthorized-attempts-YYYY-MM-DD.jsonl`

## 7) Unified event schema contract (coop + chat bridge)

Core coop logging and chat bridge ingestion/emission use the same event schema.

Required fields:

- `ts` (ISO-8601 timestamp)
- `event_type` (string)
- `actor` (string)
- `version` (integer, current default: `1`)
- `payload` (object)

Optional fields:

- `task_id` (string)
- `message_id` (string)

Validation is mandatory before append. Malformed events must be rejected.

Example (task update event):

```json
{
  "ts": "2026-03-06T04:58:12.123Z",
  "event_type": "update_task",
  "actor": "openclaw",
  "version": 1,
  "task_id": "cooperation/tasks/openclaw-fix-bug-123.md",
  "payload": {
    "status": "blocked",
    "assignee": "openclaw"
  }
}
```

Example (chat outbox event):

```json
{
  "ts": "2026-03-06T04:58:14.456Z",
  "event_type": "send_message",
  "actor": "openclaw",
  "version": 1,
  "message_id": "cooperation/messages/openclaw-review-123.md",
  "payload": {
    "topic": "messages",
    "to": "peer-reviewer",
    "subject": "Schema ready for review"
  }
}
```

## 8) Audit baseline cut-point (legacy vs current)

Long-running repos may contain historical events that predate stricter schema enforcement (for example, old lines missing `event_id`).

Use a baseline cut-point when replaying/auditing logs:
- `--baseline-ts <ISO-8601>`
- `--baseline-line <jsonl-line-number>`
- `--baseline-schema-version <n>`

Behavior:
- Replay uses only events in the current scope (at/after baseline filter).
- Audit reports both `legacy_issues` and `current_issues`.
- `pass_current=true` means current events pass strict checks even if legacy issues remain.

## 9) Operational guardrails

- One project should use one coop truth repo.
- Keep commits small and descriptive for traceability.
- Prefer append-only collaboration artifacts over hidden state.
- Use the Git commit SHA as the global state cursor.
- Webhooks are notification hints; fetch/poll is the correctness path.
- Dispatch publication must be idempotent by `dispatch_id`.
- Heartbeats and high-frequency presence are ephemeral and must not become Git truth.
- Messages cannot mutate task status, assignee or version.
- Message files are immutable; receipts are separate append-only artifacts.
