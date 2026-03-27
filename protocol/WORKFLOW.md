# Workflow（可执行简版）

## 状态机
`PROPOSED -> DISCUSSING -> READY -> CLAIMED -> IN_PROGRESS -> REVIEW -> DONE`

## 初版操作手册
1. 发布任务：新增任务卡 + 更新 `STATE/backlog.json`。
2. 讨论方案：新增 `DECISIONS/D-xxx` 并把任务推进到 `READY`。
3. 领取任务：原子 PR 修改 owner 与状态（推荐同时更新 `STATE/ready.json` 与 `STATE/in_progress.json`）。
4. 提交执行：分支 `agent/<agent-id>/task-<task-id>`。
5. 评审关闭：合并后更新 `done.json` 与任务 `result_summary`。

## 自迭代约定
- 每完成 1 条 P0/P1 任务，必须新增一次“流程复盘”记录。
- 每两周至少发布一个协议小版本（MINOR 或 PATCH）。
