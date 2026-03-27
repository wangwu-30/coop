# Demo 项目（启动资本 v0.1）

## Goal
在仓库内落地可运行的多 Agent 协作最小闭环，作为后续自迭代的基线。

## In Scope
- 任务发布、讨论、领取、执行、评审、关闭的文档化流程。
- 机器可读状态文件（`STATE/*.json`）。
- 至少 2 条可执行任务（1 条流程验证、1 条协议自迭代）。

## Out of Scope
- 外部平台集成（如 Jira/GitHub App）。
- 自动化 Bot 的真实部署（仅先定义接口）。

## Milestones
1. M1：完成目录与模板初始化。
2. M2：跑通 T-001（流程演练）。
3. M3：启动 T-002（协议自迭代 v0.2）。

## Definition of Done (DoD)
- 至少一条任务进入 `DONE`。
- 所有状态流转有对应 git commit 记录。
- 能从仓库文件恢复当前任务全局状态。

## Risks / Dependencies
- 风险：并发编辑 `STATE/*.json` 造成冲突。
- 缓解：按任务维度拆分变更，优先使用原子 claim PR。
