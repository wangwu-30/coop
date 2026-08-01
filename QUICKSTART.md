# Quickstart

## 1. Install and build

```bash
npm install
npm run build
```

## 2. Choose one canonical cooperation root

For a small single-branch experiment, the business repository itself can be
the root. For normal multi-agent work, use a dedicated branch/worktree in the
same remote:

```bash
git branch coop-state
git worktree add ../my-project-coop coop-state
```

Every Agent must point to that same logical root:

```bash
export AGENT_COOP_DIR=/absolute/path/to/my-project-coop
```

An explicit `--coop-dir` takes precedence. If neither is provided, the current
working directory is used. The system never silently falls back to a home
directory repository.

## 3. Initialize

```bash
npm run coop:init -- --coop-dir "$AGENT_COOP_DIR"
```

With a shared remote:

```bash
npm run coop:init -- --coop-dir "$AGENT_COOP_DIR" --remote <git-remote-url>
```

When installed as an MCP server, call `coop_init` instead. Start the MCP stdio
server with `npm start` or the `agent-coop` binary.

## 4. Produce fresh quality evidence

```bash
npm run quality:gate
```

The Observer fails closed when quality evidence is missing, invalid or older
than 24 hours. Commit the generated
`cooperation/runtime/quality-gate-status.json` on the coordination branch before
running the Observer; an uncommitted canonical state is intentionally rejected.

## 5. Observer loop

```bash
npm run coop:min:run -- --coop-dir "$AGENT_COOP_DIR"
npm run coop:min:publish -- --coop-dir "$AGENT_COOP_DIR"
```

Publication is idempotent: a stable `dispatch_id` and a tracked receipt prevent
the same observation from creating duplicate tasks.

## 6. Worker loop

Use MCP tools to:

1. `coop_list_tasks`
2. `coop_claim_task` with `expected_version`
3. execute the business change in a feature worktree
4. `coop_update_task` to `done` or `blocked`
5. `coop_publish_state` (or `npm run coop:push`) and require `pushed=true`

Local concurrent mutations are serialized. Across machines, the shared remote
branch is the final compare-and-swap boundary. A local claim is only a candidate;
do not start business work until its fast-forward push succeeds. On
`remote_conflict`, fetch, re-read the task and retry the decision.

## 7. Agent coordination messages

Use `coop_send_message` for blocking questions, reviews and handoffs. A message
linked to a task must include the task version that the sender observed:

```json
{
  "from": "coop-worker-1",
  "to": "coop-worker-2",
  "kind": "review_request",
  "subject": "Review task result",
  "body": "Please review the attached evidence.",
  "task_id": "cooperation/tasks/task-123.md",
  "expected_task_version": 2,
  "requires_ack": true,
  "dedupe_key": "task-123-review-v2"
}
```

The recipient calls `coop_ack_message` with `read`, `ack` or `reject`. Receipts
are immutable files; reading a broadcast never rewrites the original message.
Before acknowledging an actionable task-linked message, the current task
version is checked again. Messages request action but never grant task
ownership—claim/publish rules still apply.

`coop_check_inbox` fetches remote revision metadata but does not silently
rebase. If it reports `sync_required=true`, sync the coordination worktree and
re-read the inbox before acting.

## 8. Global update awareness

One-shot state:

```bash
npm run coop:state -- --coop-dir "$AGENT_COOP_DIR"
```

Continuous polling:

```bash
npm run coop:watch -- --coop-dir "$AGENT_COOP_DIR" --interval-ms 5000
```

Agents store `canonical_revision` as `last_seen_commit`. On change, the result
contains the affected task files. A Git webhook can trigger this check sooner;
polling remains the recovery path when webhook delivery is lost.

## 9. Validate and audit

```bash
npm run validate:coop -- --strict-zero-files
npm run replay:events -- --file logs/events-YYYY-MM-DD.jsonl
npm run audit:events -- --file logs/events-YYYY-MM-DD.jsonl
```
