# Architecture

## Decision

`agent-coop` is a Git-native cooperation core with replaceable adapters.
MCP is the default local Agent adapter, not the source of truth and not the
Agent-to-Agent transport.

```text
Codex / Claude Code / CI / human
             |
       MCP or CLI adapter
             |
       agent-coop core
             |
   canonical Git branch/remote
```

The dependency direction is one-way:

```text
adapters -> core -> schema/storage
```

Code under `src/core/` must never import MCP or client-specific configuration.
The current core facade keeps compatibility with the original domain
operations while giving adapters one stable import boundary.

## Canonical state

The following paths are canonical and publishable:

- `config.yaml` and `policy.yaml`
- `cooperation/tasks/`
- `cooperation/messages/`
- `cooperation/message-receipts/`
- `cooperation/dispatch-receipts/`
- `cooperation/runtime/quality-gate-status.json`
- `logs/`

Planner outputs under `coop-min/state/` and lock files under
`.agent-coop-runtime/` are local runtime artifacts and must not be committed.

## Concurrency model

Within one checkout, all mutations that can change Git `index` or `HEAD` use a
repository-wide lock. Codex and Claude Code may therefore share one physical
coordination checkout on one machine.

Across checkouts or machines, the remote branch is the compare-and-swap
boundary:

1. sync and read the current task version;
2. create a local candidate commit;
3. fast-forward push;
4. begin business work only when the push succeeds.

A rejected push is never silently rebased. `coop reconcile` first inspects the
local candidate. It can discard the candidate only when every changed path is
canonical cooperation state and the caller supplies the exact observed local
revision. Business files make automatic discard impossible.

## Adapter responsibilities

### Core

- task and message invariants
- optimistic versions
- event evidence
- Git publication and reconciliation rules
- no dependency on MCP

### CLI

- installation and diagnostics
- human/CI task and message operations
- machine-readable JSON results and non-zero error exits

### MCP

- typed tool discovery and validation
- client permission boundary
- server instructions that teach Agents the safe workflow
- no ownership of canonical state

### Future HTTP adapter

A remote HTTP adapter is useful for hosted Agents and centralized wakeups, but
is not required for local Codex/Claude Code. It must call the same core API and
must not introduce a second database of record.

## Acceptance gates

- core boundary test contains no MCP/client import
- concurrent mutations on different tasks leave a clean Git worktree
- rejected remote candidates cannot overwrite business files
- installer is idempotent and preserves existing client configuration
- a clean packaged install can initialize, install adapters, pass `doctor`, and
  exchange a task and message
