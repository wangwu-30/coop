# TeamAI bounded RSI experiment

A standalone experimental module using TeamAI CLI 0.29.0 and an existing host harness. It contains newly created workflows, fixed synthetic evaluations, generic reviewer instructions, and a project-scoped RSI skill. No prior personal skills, original trial history, hooks, machine configuration, credentials, or conversation history are included.

## Flow

Run a baseline with rsi-evaluate. For at most three rounds, rsi-round proposes one instruction change, executes it, checks the fixed contract, obtains an independent semantic assessment, and makes a deterministic adoption decision. Candidate selection uses development cases only. Freeze the selected candidate before one final paired holdout evaluation stage.

The shared protocol and dataset manifest are fixed. All 10 cases are synthetic and contain no real customer, employee, financial, or account data. Character-count reduction is only a context-size proxy. It is not a claim of model quality improvement or cost savings.

## Contents

- .teamai/workflows: evaluation and improvement-round definitions
- .teamai/agents: reviewer, improver, and independent semantic judge
- .teamai/skills/rsi-cycle: existing-host orchestration instructions
- rsi/eval: fixed development/holdout data, oracle, schema, rubric, and verifier
- rsi/candidates: versioned candidate instruction text
- rsi/history: structured per-run evidence and decisions, added after runs finish

This module is stored in experiments/teamai-rsi on a dedicated GitHub branch. To run it as a standalone TeamAI project, copy this directory into its own Git working repository, initialize TeamAI against an authorized Git remote, and invoke the rsi-cycle project skill in a host that supports child agents. Do not expect a bare shell running the skill driver to spawn host children by itself.

A persistent terminal/session is recommended while driving command steps. Python command steps use -B so importing the frozen evaluator does not create __pycache__ in a read-only checkout.

Execution results will be recorded as observed; an implementation commit alone does not establish that the RSI rounds passed.
