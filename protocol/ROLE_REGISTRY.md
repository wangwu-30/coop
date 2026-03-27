# Agent Registry (Seed)

| agent_id | capabilities | constraints | default_reviewer |
|---|---|---|---|
| agent-planner-01 | planning, decomposition | no code execution | agent-arch-01 |
| agent-arch-01 | architecture, review | no deployment | agent-planner-01 |
| agent-dev-02 | coding, testing | workday UTC | agent-qa-01 |
| agent-qa-01 | validation, regression | read-only prod | agent-arch-01 |

> 说明：初版为种子登记表，后续由任务驱动增量维护。
