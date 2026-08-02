# Quickstart: Codex + Claude Code

## 1. Install the tool

Until an npm release is published, install directly from GitHub:

```bash
npm install -g github:wangwu-30/coop
coop --help
```

For local development:

```bash
git clone https://github.com/wangwu-30/coop.git
cd coop
npm ci
npm run build
npm link
```

## 2. Choose the canonical cooperation checkout

For one business repository, use a dedicated `coop-state` branch. Business
changes stay on feature branches; coordination commits stay on `coop-state`.

```bash
git -C /path/to/business-repo branch coop-state
git -C /path/to/business-repo push origin coop-state
git -C /path/to/business-repo worktree add ../business-coop-state coop-state
```

On one machine, Codex and Claude Code may share this checkout because Git
mutations are repository-wide serialized. On different machines, give each
Agent its own clone of the same remote branch.

Use a separate cooperation repository only for multi-repository coordination
or when access and retention policy must differ from business code.

## 3. Initialize once

```bash
coop init \
  --coop-dir /absolute/path/to/business-coop-state \
  --remote <business-git-remote-url>

coop push --coop-dir /absolute/path/to/business-coop-state
```

## 4. Install both client adapters

Run this from the business project root:

```bash
coop install \
  --client both \
  --project-dir /absolute/path/to/business-repo \
  --coop-dir /absolute/path/to/business-coop-state
```

This safely creates or updates:

- `.codex/config.toml` and the managed section in `AGENTS.md`
- `.mcp.json` and the managed section in `CLAUDE.md`

Existing content is preserved. Paths are machine-local, so every developer
must run installation on their own machine. Claude Code asks for approval
before using a project-scoped MCP server.

## 5. Diagnose

```bash
coop doctor \
  --client both \
  --project-dir /absolute/path/to/business-repo \
  --coop-dir /absolute/path/to/business-coop-state
```

Restart Codex/Claude Code, then inspect MCP connections with `codex mcp list`,
`claude mcp list`, or `/mcp` inside either client.

## 6. Agent lifecycle

At session start:

1. `coop_sync`
2. `coop_check_inbox`
3. `coop_get_global_state`
4. `coop_list_tasks`

Before business work:

1. read the task and its version;
2. `coop_claim_task(expected_version=...)`;
3. `coop_publish_state`;
4. continue only when `pushed=true`.

After work:

1. `coop_update_task(status="done" | "blocked", expected_version=...)`;
2. send review/handoff messages when needed;
3. `coop_publish_state`.

## 7. Resolve a rejected push

Inspect first:

```bash
coop reconcile --coop-dir /absolute/path/to/business-coop-state
```

If `candidate_is_cooperation_only=true`, explicitly discard the rejected
candidate using the exact revision returned by inspection:

```bash
coop reconcile \
  --coop-dir /absolute/path/to/business-coop-state \
  --discard-local-candidate \
  --expected-local-revision <local_revision>
```

Then sync, re-read the task/inbox, and retry the high-level decision. The tool
refuses to discard candidates containing business files.

## 8. CLI fallback

MCP is optional. Humans, CI and Agents without MCP can use the same core:

```bash
coop task list --coop-dir /path/to/coop-state --status open
coop task claim --coop-dir /path/to/coop-state \
  --task-id cooperation/tasks/task.md \
  --assignee codex \
  --expected-version 1
coop push --coop-dir /path/to/coop-state
```
