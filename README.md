# agent-coop

A Git-native cooperation core for Codex, Claude Code, OpenClaw and other
Agent clients. MCP is the default typed adapter; the same core is also exposed
through a CLI.

```text
Codex / Claude Code / CI -> MCP or CLI -> agent-coop core -> Git
```

See [QUICKSTART.md](QUICKSTART.md) for installation and
[ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and failure handling.

## What this is now

这是一次**从头重做**的 coop，不是旧 flywheel 的修补版。

核心模型只有四件事：

- **Observer**：观察任务池和质量状态，只在必要时发布少量真实任务
- **Workers**：领取、执行、回写任务
- **Task files**：作为唯一真相源
- **Typed mailbox**：仅处理阻塞、澄清、评审和交接，不代替任务状态

系统目标：

> 先把 coop 做简单、清晰、可解释；
> 再在这个干净内核上重新长出飞轮迭代能力。

不是继续背着旧 flywheel 的历史包袱跑。

---

## Core principles

1. **Task files are truth**
2. **Observer only observes and publishes**
3. **Workers only execute and report**
4. **Quality gate verifies, it does not self-heal the system**
5. **No automatic rebalance / seed / activation / stale-heal**
6. **If system is stable, it should stop**
7. **Messages request action; task state authorizes action**
8. **MCP is replaceable; Git and core invariants are not**

---

## Deployment topology

All processes resolve one canonical cooperation root:

1. explicit `--coop-dir`
2. `AGENT_COOP_DIR`
3. current working directory

There is no implicit `~/.agent-coop` fallback. Observer, MCP tools, tasks,
messages, events and dispatch receipts therefore operate on the same root.

One machine may run Codex and Claude Code against the same physical checkout:
all Git mutations are repository-wide serialized. Across machines, use
independent checkouts of the same remote branch.

For a business repository, the recommended default is one Git remote with a
dedicated `coop-state` branch and worktree. Business changes stay on feature
branches; coordination changes stay on `coop-state`.

Use a separate cooperation repository only for multi-repository coordination
or when access and retention policies must differ from the business code.

---

## Install Codex and Claude Code

```bash
npm install -g github:wangwu-30/coop

coop init --coop-dir /path/to/coop-state --remote <git-url>
coop push --coop-dir /path/to/coop-state
coop install --client both --project-dir /path/to/business-repo --coop-dir /path/to/coop-state
coop doctor --client both --project-dir /path/to/business-repo --coop-dir /path/to/coop-state
```

The installer preserves existing `.codex/config.toml`, `.mcp.json`,
`AGENTS.md` and `CLAUDE.md` content and owns only marked sections or the
`agent-coop` MCP entry.

## Current commands

Build:

```bash
npm run build
```

Observer run:

```bash
npm run coop:min:run
```

Observer publish tasks:

```bash
npm run coop:min:publish
```

Read the global Git cursor once, or watch it continuously:

```bash
npm run coop:state -- --coop-dir /path/to/coop-worktree
npm run coop:watch -- --coop-dir /path/to/coop-worktree --interval-ms 5000
coop task list --coop-dir /path/to/coop-worktree --status open
coop message inbox --coop-dir /path/to/coop-worktree --agent-id codex
```

`canonical_revision` is the global cursor. Webhooks may wake agents faster,
but Git remains authoritative and polling repairs missed notifications.

Quality gate:

```bash
npm run quality:gate
```

---

## Runtime and canonical outputs

- `coop-min/state/observer-summary.json`
- `coop-min/state/dispatch.json`

These two planner outputs are ignored local runtime data. Published tasks,
messages, receipts, quality evidence and event logs are canonical Git state.

If publish happens, task files are written to:
- `cooperation/tasks/`

Idempotent publish receipts are written to:
- `cooperation/dispatch-receipts/`

Typed coordination messages and immutable receipts are written to:
- `cooperation/messages/`
- `cooperation/message-receipts/`

---

## Current workflow

### Observer
1. Run `npm run coop:min:run`
2. Inspect summary + dispatch
3. If and only if needed, run `npm run coop:min:publish`

### Worker
1. Read open tasks
2. Claim task
3. Execute
4. Update to `done` or `blocked`

Use `coop_send_message` only for exceptional coordination such as help,
clarification, review, handoff or escalation. Use `coop_ack_message` to append a
read/ack/reject receipt. A message never changes task ownership or status.

---

## Scope boundary

This repo is now centered on the new cooperation kernel in:

- `src/coop-min/*`
- `src/core/*`
- `src/adapters/*`
- `src/tools/coop.ts`
- `src/schema/*`
- `src/storage/*`

Old flywheel-era scripts are not part of the new conceptual model.
They should be removed or ignored as migration debris, not treated as active architecture.
