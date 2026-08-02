# OPERATIONS

## Current operating model

This repo now operates as a **fresh-start coop kernel**.

### Daily loop

1. Fetch/fast-forward the dedicated coordination branch
2. Workers drain real tasks
3. Observer runs one round
4. Publish only when needed
5. Run quality gate on meaningful changes

---

## Observer

Run:

```bash
npm run coop:min:run
```

Publish only if `decision=continue`:

```bash
npm run coop:min:publish
```

Rules:
- max 2 tasks per publish
- no synthetic maintenance tasks
- no publish just to keep motion alive

---

## Workers

- compare `canonical_revision` with the last seen commit
- claim an open task with `expected_version`
- execute real work
- update status honestly
- block when blocked, do not fake throughput

All local Git mutations are serialized by a repository-wide lock. Across
machines, a rejected push means the worker must inspect the local candidate,
discard it only when it contains cooperation state exclusively, fetch, re-read
the task and retry the decision.

```bash
coop reconcile --coop-dir /path/to/coop-worktree
coop reconcile --coop-dir /path/to/coop-worktree \
  --discard-local-candidate \
  --expected-local-revision <sha>
```

Automatic discard refuses dirty worktrees and commits that contain business
files. Coordination decisions are never silently rebased.

---

## Global state

```bash
npm run coop:state -- --coop-dir /path/to/coop-worktree
npm run coop:watch -- --coop-dir /path/to/coop-worktree --interval-ms 5000
```

- `canonical_revision`: durable global cursor
- `changed_tasks`: tasks changed since `last_seen_commit`
- `local_is_current`: whether the worktree matches the remote branch
- `worktree_dirty`: uncommitted canonical state that must be resolved

Use a webhook to wake the watcher quickly, but retain polling as the repair path.

---

## Agent mailbox

- use typed messages only for help, clarification, review, handoff, cancellation
  requests, decisions and escalation
- bind task-related messages to `task_id` plus `expected_task_version`
- use a stable `dedupe_key` when retrying delivery
- append `read`, `ack` or `reject` receipts; never edit the original message
- after receiving a message, refresh Git state and validate the task again
- do not use messages for claims, completion, heartbeats or synthetic activity
- if `coop_check_inbox` reports `sync_required`, sync before acting

## Client installation health

```bash
coop doctor \
  --client both \
  --project-dir /path/to/business-repo \
  --coop-dir /path/to/coop-worktree
```

Run this after installation, after moving a checkout, or when either client
cannot see MCP tools.

---

## Hard rules

- task files are source of truth
- no automatic self-healing loop
- no automatic rebalance / seed / wakeup machinery
- if stable, stop

---

## Intent

We are not preserving the old flywheel as the default model.
We are rebuilding coop first, then future iteration/flywheel logic can be added back intentionally on top of a clean core.
