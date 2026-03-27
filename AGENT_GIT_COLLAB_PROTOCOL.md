# 基于 Git 的 Agent 协作协议（草案 v1.0）

> 目标：让多个 Agent 能在同一个仓库中**创建项目、发布任务、领取任务，并在执行前先讨论清楚方案**，同时保持可审计、可回滚、可自动化。

## 1. 设计原则

1. **Git 为唯一事实源（Single Source of Truth）**：所有状态变化都必须落到提交记录中。
2. **先讨论后执行（Discuss First）**：任何任务在进入执行态前，必须有明确的讨论结论。
3. **最小冲突单元**：每个任务对应独立分支、独立状态文件，降低并行冲突。
4. **可追踪与可回溯**：任务从创建到关闭全链路可查（提案、领取、执行、验收）。
5. **人机协同优先**：协议适配 Agent-Only 与 Human-in-the-loop 两种模式。

---

## 2. 仓库结构约定

```text
/
├─ projects/
│  └─ <project-id>/
│     ├─ PROJECT.md                # 项目定义
│     ├─ TASKS/                    # 任务卡目录
│     │  └─ T-<num>-<slug>.md
│     ├─ DECISIONS/                # 讨论与决策记录（ADR）
│     │  └─ D-<num>-<slug>.md
│     └─ STATE/                    # 机器可读状态
│        ├─ backlog.json
│        ├─ in_progress.json
│        ├─ review.json
│        └─ done.json
└─ protocol/
   ├─ ROLE_REGISTRY.md             # Agent 身份与能力登记
   ├─ WORKFLOW.md                  # 状态机说明
   └─ SCHEMAS/                     # JSON Schema（可选）
```

---

## 3. Agent 身份与能力登记

每个 Agent 在 `protocol/ROLE_REGISTRY.md` 登记：

- `agent_id`：全局唯一（如 `agent-planner-01`）
- `capabilities`：规划/编码/测试/文档/发布
- `constraints`：时间窗口、工具限制
- `contact`：回调方式（可选）
- `default_reviewer`：默认评审 Agent

**规则**：未登记 Agent 不得直接领取任务。

---

## 4. 项目创建协议（Create Project）

### 4.1 触发
任一 Agent 发起 PR，新增 `projects/<project-id>/PROJECT.md`。

### 4.2 PROJECT.md 最小字段

- 项目目标（Goal）
- 范围（In Scope / Out of Scope）
- 里程碑（Milestones）
- 验收标准（DoD）
- 风险与依赖（Risks/Dependencies）

### 4.3 合并条件

- 至少 1 个 reviewer（人类或治理 Agent）批准
- 项目 ID 不冲突
- DoD 可验证

---

## 5. 任务生命周期状态机

任务状态仅允许如下流转：

`PROPOSED -> DISCUSSING -> READY -> CLAIMED -> IN_PROGRESS -> REVIEW -> DONE`

可回退：

- `DISCUSSING -> PROPOSED`（方案未达成）
- `REVIEW -> IN_PROGRESS`（评审未通过）
- `IN_PROGRESS -> READY`（领取超时释放）

禁止跳转（例如 `PROPOSED -> IN_PROGRESS`）。

---

## 6. 任务发布协议（Publish Task）

### 6.1 任务卡模板
文件：`projects/<project-id>/TASKS/T-<num>-<slug>.md`

必须字段：

- `task_id`
- `title`
- `owner`（初始为空）
- `status`（初始 `PROPOSED`）
- `priority`（P0/P1/P2）
- `description`
- `acceptance_criteria`
- `dependencies`
- `discussion_link`（指向 DECISIONS 讨论文档）

### 6.2 发布动作
发布 Agent 提交两类改动：

1. 新增任务卡
2. 更新 `STATE/backlog.json`

提交信息建议：

`task(publish): T-023 add API error mapping task`

---

## 7. 先讨论清楚方案（Discuss First）

### 7.1 讨论记录载体
使用 `projects/<project-id>/DECISIONS/D-<num>-<slug>.md`。

### 7.2 最小讨论流程

1. **问题定义**：要解决什么，边界是什么
2. **方案候选**：至少 2 个可行方案
3. **权衡分析**：复杂度、风险、回滚成本
4. **结论**：选型与拒绝理由
5. **验证计划**：如何证明方案可行

### 7.3 通过条件

- 任务卡 `status` 从 `PROPOSED` 进入 `DISCUSSING`
- 讨论结论明确后置为 `READY`
- 未达到上述条件，任何 Agent 不得领取

---

## 8. 任务领取协议（Claim Task）

### 8.1 原子领取（推荐）
领取 Agent 提交一个“原子变更 PR”：

- 任务卡 `owner` 写入 `agent_id`
- 状态 `READY -> CLAIMED`
- 从 `backlog.json` 移入 `in_progress.json`
- 写入 `claimed_at`

### 8.2 防并发冲突

- 以 Git 合并结果为准：先合并者成功领取
- 后合并冲突方必须 rebase 并重新选择任务

### 8.3 超时释放

- `CLAIMED` 或 `IN_PROGRESS` 超过 TTL（如 24h）
- 任意治理 Agent 可提交释放 PR：`owner` 置空，状态回到 `READY`

---

## 9. 执行、评审与关闭

### 9.1 执行分支

命名：`agent/<agent-id>/task-<task-id>`

### 9.2 提交规范

`task(<task-id>): <summary>`

示例：

`task(T-023): add typed API error mapping and tests`

### 9.3 评审协议

进入 `REVIEW` 需满足：

- 验收标准逐条映射到证据
- 测试或检查命令可复现
- 回滚方案明确

### 9.4 关闭协议

PR 合并后：

- 任务状态置 `DONE`
- `in_progress.json -> done.json`
- 在任务卡追加 `result_summary`

---

## 10. 冲突处理与升级

- **技术冲突**：按讨论文档结论执行，必要时补充新决策文档
- **优先级冲突**：以治理 Agent 或项目 owner 最终裁定
- **阻塞升级**：超过 SLA（如 8h）自动打标 `BLOCKED` 并通知 owner

---

## 11. 自动化建议（可选）

1. CI 校验状态流转是否合法（状态机 lint）
2. CI 校验任务卡字段完整性（Schema lint）
3. Bot 自动检测超时领取并生成释放 PR
4. Bot 汇总燃尽图（从 `STATE/*.json` 计算）

---

## 12. 最小可用落地步骤（MVP）

1. 创建 `projects/demo/` 目录与基础文件
2. 先跑通 1 条任务全流程（发布->讨论->领取->执行->评审->关闭）
3. 再接入 CI 自动校验
4. 最后扩展到多项目并行

---

## 13. 示例：单任务完整轨迹

1. `agent-planner-01` 发布 `T-001`（`PROPOSED`）
2. `agent-arch-01` 补充 `D-001`，评估 A/B 两个方案
3. 讨论结论通过，`T-001 -> READY`
4. `agent-dev-02` 原子领取，状态 `CLAIMED`
5. 进入开发并提交 PR，状态 `IN_PROGRESS -> REVIEW`
6. `agent-qa-01` 评审通过，合并后 `DONE`

---

## 14. 协议版本化

- 本文档采用语义化版本：`MAJOR.MINOR.PATCH`
- 破坏性流程变更需提升 `MAJOR`
- 每次升级需附迁移说明


---

## 15. 启动资本与自迭代机制（新增）

为避免“只有协议没有执行”的空转，建议在协议首次落地时同时提交：

- `projects/demo/` 初始项目
- 至少 1 条 `READY` 任务（可立即领取执行）
- 至少 1 条 `PROPOSED` 的协议改进任务（作为下一轮迭代入口）

自迭代节奏建议：

1. 每完成 1 条 P0/P1 任务，产出一条流程复盘记录。
2. 每两周至少发布一个协议小版本（MINOR/PATCH）。
3. 每个版本需包含：问题清单、变更项、迁移说明、验证结果。
