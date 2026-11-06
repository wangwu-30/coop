# TeamAI 有界 RSI：运行结果与最终产物

这次实际完成了基线、三轮候选、固定程序采用决定和最终保留集评测。最终采用 **v3**，待迭代指令字段由 **580** 缩至 **331** 个去首尾空白后的 Unicode codepoint，减少 **42.93%**。这是局部指令体积的工程筛查结果；不表示整个上下文、token 或费用同比下降，也不证明通用任务质量提高。

最终配对保留评测中两版均完整通过全部题目。本次没有观察到质量通过题数增加。基线开发题已全部通过，所以本次迭代选择的是有证据约束的文本压缩路径，没有人为制造基线缺陷。

## 固定范围与实际执行

- 本地使用 `teamai-cli@0.29.0`，由 `rsi-round` 组织 propose → execute → verify → judge → decide，`rsi-evaluate` 执行基线与保留集。没有另写 Agent runtime。
- 提议者、执行审核者、语义评审者分别使用部署角色，每一步启动新的 child 上下文；通过 TeamAI 的真实 dispatch、ack、result、report、next 协议运行。verify 和 decide 由 TeamAI command 步骤实际执行。
- 所有对比沿用同一宿主默认模型和推理设置，没有逐步模型覆盖；未获得可核验的精确 provider 模型版本、token 或账单信息。
- 开发集 6 题、保留集 4 题，全部为合成审查事件。共用三值判定契约、任务、oracle、schema、rubric、评分器、采用规则和预算保持冻结。
- 每个 prompt step 的预算为 4 分钟；最多三轮候选。只有已记录的基础设施故障可以有限重试。最终候选先冻结，再开启一次保留评测阶段；没有根据保留结果继续优化。
- 每轮的基准是当时已采用的 incumbent。完整通过要求同一题的程序硬检查与新上下文语义评审均通过；工作流 succeeded 与质量通过是不同结果。

固定资产与采用规则见 [plan.json](plan.json)、[protocol.json](eval/protocol.json)、[decide.py](decide.py)。所有本轮语义评审来自新的 child 上下文，仍是同宿主模型的判断，不是独立模型或人工金标准。

## 开发演进

| 版本 | 比较基准 | 完整通过 | 指令字符数 | 相对基准减少 | 决定 |
|---|---|---:|---:|---:|---|
| v0 基线 | — | 6/6 | 580 | — | 起点 |
| v1 | v0 | 6/6 | 478 | 17.59% | adopt：`all_cases_pass_with_shorter_instructions` |
| v2 | v1 | 6/6 | 393 | 17.78% | adopt：`all_cases_pass_with_shorter_instructions` |
| v3 | v2 | 6/6 | 331 | 15.78% | adopt：`all_cases_pass_with_shorter_instructions` |

采用规则在候选提出前已固定：至少修复一个原未通过的完整任务、且没有原通过任务退步；或两版均完整通过全部开发题，且候选指令字段至少缩短 15%。所有候选正文均保留在 [candidates](candidates/)，三轮采用决定及 incumbent 演进写入 [run-index.json](run-index.json)。本轮三次候选均按体积筛查规则采用，没有新增完整通过题。

### 第 1 轮

- 假设：在公共协议和其它配置保持不变时，压缩重复的审核说明仍能保持开发题完整通过；任何开发题退步都否定该假设。字符数只作为局部上下文体积 proxy。
- 变更：合并开头的角色、读取、评估和报告说明，保留访问、仓库写入和指定 runtime 输出限制。
- 决定：`adopt`，`all_cases_pass_with_shorter_instructions`。
- 证据：[原始假设与完整输出](history/round-01/outputs.json)、[输入](history/round-01/inputs.json)、[TeamAI 运行记录](history/round-01/run.json)。

### 第 2 轮

- 假设：在公共协议和其它配置保持不变时，压缩重复的审核说明仍能保持开发题完整通过；任何开发题退步都否定该假设。字符数只作为局部上下文体积 proxy。
- 变更：继续缩短开头审核句子，引用公共判定定义，浓缩观察与建议的区分；访问与写入限制保持逐字不变。
- 决定：`adopt`，`all_cases_pass_with_shorter_instructions`。
- 证据：[原始假设与完整输出](history/round-02/outputs.json)、[输入](history/round-02/inputs.json)、[TeamAI 运行记录](history/round-02/run.json)。

### 第 3 轮

- 假设：在公共协议和其它配置保持不变时，压缩重复的审核说明仍能保持开发题完整通过；任何开发题退步都否定该假设。字符数只作为局部上下文体积 proxy。
- 变更：将开头收敛为“Read the case; apply the shared contract.”，依赖已提供的公共协议承载判定与证据要求；访问与写入限制保持逐字不变。
- 决定：`adopt`，`all_cases_pass_with_shorter_instructions`。
- 证据：[原始假设与完整输出](history/round-03/outputs.json)、[输入](history/round-03/inputs.json)、[TeamAI 运行记录](history/round-03/run.json)。

## 冻结最终版本与一次保留评测

冻结记录：[selection.json](final/selection.json)。它记录最终正文 hash、来源候选、开发结果、冻结时间与保留评测策略。最终指令：[reviewer.md](final/reviewer.md)。

| 版本 | 硬检查通过 | 语义评审通过 | 完整通过 | TeamAI run |
|---|---:|---:|---:|---|
| 原基线 v0 | 4/4 | 4/4 | 4/4 | `raf98f2e6af32b3b8` |
| 冻结最终版 v3 | 4/4 | 4/4 | 4/4 | `rdae62296291639c8` |

逐题响应、证据引用、硬检查、语义判断保存在 [原基线保留结果](history/holdout-baseline/outputs.json) 和 [最终版保留结果](history/holdout-final/outputs.json)。保留题已在本阶段使用且现已公开；后续若继续优化，需要另建新的保留集，不能继续把这些题称为未见测试。

最终正文如下：

```text
Read the case; apply the shared contract.
Do not modify repository files, create commits, or run git push.
Do not read credentials, unrelated projects, or personal conversation history.
When the workflow requests a runtime result file outside the repository,
write only that designated result file using the required output schema.
```

候选正文依赖共同的 protocol、schema、角色和工作流包装；将这段正文单独移植到缺少共同契约的环境，不属于本次已验证范围。

## 实际故障与恢复

1. **第一次基线的只读校验失败**：Python import 生成了 `__pycache__`。两个工作流改用 `python3 -B` 后重新运行；没有关闭只读校验，也没有改任务或判分规则。原失败保留，不能把它当作模型质量失败。
2. **第二次基线的 verify 超时**：该 attempt 只有 job/lease 元数据，没有命令结果或 place 文件。在持久终端中对同一 run 仅重试 verify 后完成。证据支持运行环境生命周期是可能原因，不支持宣称 TeamAI 存在普遍产品缺陷。
3. **第一轮 judge 因驱动交接超时**：16:43:36 发出 lease，16:47:33 到期，直到 16:47:14 才 ack，16:48:04 report 已迟于原期限。保留迟交结果和失败状态，使用相同响应、相同 4 分钟预算和新的 child 仅重试 judge 一次；迟交结果没有冒充成功结果。

详细事实见 [infrastructure-events.json](history/infrastructure-events.json) 与 [infrastructure](history/infrastructure/)。没有因为低分重跑，也没有改写先前提交掩盖失败。

## 运行记录与成本边界

| 阶段 | Run | 终态 | Attempt 数 | 墙钟秒数 |
|---|---|---|---:|---:|
| 首次基线（基础设施失败） | `rcd8334965689c92d` | failed | 2 | 141.8 |
| 基线开发集 | `rdb1509ed0234a9b8` | succeeded | 4 | 546.5 |
| 第1轮 | `ra66a9bf598590a61` | succeeded | 6 | 750.9 |
| 第2轮 | `r6db09c02ff7cdd08` | succeeded | 5 | 295.6 |
| 第3轮 | `r91d0b93a3e4a3e43` | succeeded | 5 | 277.6 |
| holdout-baseline | `raf98f2e6af32b3b8` | succeeded | 3 | 144.6 |
| holdout-final | `rdae62296291639c8` | succeeded | 3 | 125.6 |

墙钟时间包含驱动等待、交接、调度和恢复；重试按 attempt 计入，不能解释为模型推理速度或运行费用。完整结构化核算见 [execution-summary.json](history/execution-summary.json)。token 用量与费用均未知。

## 可以得出的结论与限制

- 已跑通 Git 管理配置、TeamAI 按需调度角色、独立 child 执行/评审、固定采用决策、终态后逐轮提交的闭环；本次没有增加新的模型能力，也没有证明“通用 90 分 Agent”。
- 6 个开发题反复参与选择，4 个保留题只支持小范围筛查。全部通过仍不足以证明统计非劣、显著提升或真实业务收益。相同通过题数不能解释为质量提升。
- 字符数只衡量候选指令字段；公共协议、任务数据、schema、角色说明、brief 和运行工具仍占上下文。没有 token 或费用测量，不能把字段压缩百分比转换为成本节省。
- 评测题涉及共享记忆、来源追溯等场景，但材料是合成事件文本；本次没有实现或验证真实长期记忆服务、跨项目检索权限或无人值守部署。
- child 使用新上下文，但仍共享文件系统。读取范围是任务约束，manifest/只读检查能发现写入漂移，不能证明从未越界读取；这不是 OS 权限隔离。
- `decide.py` 尚未独立验证 `baseline_report` 与传入 incumbent 正文的身份绑定。此次编排使用 [run-index.json](run-index.json) 和每轮归档 inputs/outputs 保持并可核对正确配对；该绑定检查应在下一版流程补强，本次未更改冻结判分器。
- 运行记录中的 `teamRevision` / `source_revision` 是本地原始 Git 来源。GitHub 公开交付为经过内容范围筛选的独立提交，不能把本地 SHA 当作 GitHub 已存在提交；公开发布的来源映射另行保存。

本轮选择和评估到此停止。后续扩大任务覆盖、加强读取隔离或绑定校验时，应建立新的实验记录和新的保留集。
