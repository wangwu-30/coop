---
name: rsi-cycle
description: 用 TeamAI 执行有界的 Agent 指令自迭代：固定评测，运行基线，提出并验证候选，按程序采用或回退，保存每轮 GitHub 演进。用于用户要求构建 RSI、让 Agent 自我改进或连续迭代几轮；不自动修改模型、评价标准或授权边界。
---

# 有界 RSI 循环

在当前项目中使用既有 TeamAI 工作流和宿主子 Agent。默认最多执行三轮候选，不创建新的 Agent runtime。下列 `rsi/` 路径均相对项目根目录。

## 固定起点

1. 读取 `rsi/eval/protocol.json`、评测目录的 README、当前候选和已有运行记录。保持公共三值决策契约一致，不为基线制造缺陷。
2. 固定任务、oracle、评估程序、语义 rubric、模型设置和预算；核对评测 manifest 与外部记录的 hash。发现漂移时停止该轮并保留证据。
3. 保持开发集与保留集分离。执行者只读当前任务包；优化器只获得开发证据；独立判分者可以读取对应 oracle，但不得把 oracle 原文交给优化器。
4. 为每个执行与判分步骤启动新的任务上下文。共享文件系统下的读取约定不等于安全沙箱，不声称已经证明没有越界读取。

## 运行基线

从候选文件读取完整指令正文，作为 `rsi-evaluate` 的 `candidate` 字符串输入；`taskpack` 传任务包相对路径，例如 `rsi/eval/dev/tasks.json`。

先执行 `teamai workflow start --describe rsi-evaluate --driver skill --inputs ...`，按其返回的入口启动。让宿主按 TeamAI 的 dispatch、ack、report、next 协议推进。不要把子 Agent 的聊天回答代替指定结果文件与 report。

每个具名 Agent 必须实际加载对应角色。宿主没有具名 Agent 参数时，明确让 child 读取已部署的角色文件，再读 brief。只把该步骤所需的原始材料交给 child，不传预期答案或主会话的结论。

保存完整工作流 outputs：`responses`、`verification`、`judgement`。这份 JSON 作为下一轮的 `baseline_report`，其基准始终是当前采用的 incumbent，而非最近一次被拒绝的候选。

## 连续运行最多三轮

每轮启动 `rsi-round`，输入：

- `round`：1、2 或 3。
- `incumbent`：当前采用版本的完整指令正文，不是文件路径。
- `baseline_report`：已归档的 incumbent 工作流 outputs JSON 路径。
- `feedback`：仅含开发结果、问题与此前采用决定的反馈文件路径。
- `taskpack`：固定开发任务包路径。

工作流依次完成 propose、execute、verify、judge、decide。优化器只输出候选文本；执行者实际运行；独立语义判分者评估；`rsi/decide.py` 作固定采用决定。

遵守程序决定：

- schema、资产完整性或语义检查失败，拒绝候选。
- 比 incumbent 至少多完整通过一题，且没有任何已通过题退步，可以采用。
- 两版同样完整通过全部题目，且候选去首尾空白后的 Unicode codepoint 数至少减少 15%，可以按预先声明的工程筛查规则采用；仅称为上下文长度 proxy，不宣称 token 或费用效果。
- retain 必须返回 incumbent 原文且无变更；不把重复运行或相同文本包装成一次改进。
- 其它情况拒绝，保留 incumbent。保留基线是允许的结果。

只在该 run 完全结束、没有运行中的 attempt 或待执行 then 后，归档产物、应用已采用候选、提交 Git 并拉取下一轮。不得在活动的只读 checkout 中修改文件。

## 结束与保存

三轮结束后冻结最终候选，再用 `rsi-evaluate` 对原基线与最终版本进行一次保留集评测阶段。不要根据这次保留结果继续调整候选；失败时缩小结论或回退，不重新命名同一保留集为“未见”。

在用户指定 GitHub 仓库保留每轮源版本、完整响应、硬检查、独立语义判断、proposal、decision、失败／重试和最终配置。每轮保存独立提交，记录 source revision 与 TeamAI run id；使用正常提交与推送，不改写已有历史。

区分工作流执行成功与候选质量通过。报告实际采用了什么、拒绝了什么、仍不知道什么；小型合成任务只支持局部筛查，不代表普遍 90 分、统计显著提升或费用下降。保留实际成本记录；无法获得 token/费用时直接记为未知。
