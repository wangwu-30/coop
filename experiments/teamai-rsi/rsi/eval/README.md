# RSI 审核能力固定评测集

这是为 TeamAI reviewer 的三轮有界迭代建立的合成筛查集。使用前先保存 manifest 的 hash 到候选不可修改的运行记录，并固定 Git 提交。没有连接真实业务、发布平台或个人知识库。

## 输入边界

- 给执行 reviewer：`protocol.json`、`response.schema.json`、本轮 split 的 `tasks.json` 和待评角色/skill。
- 给迭代器：开发集、开发结果、程序检查及语义反馈；不给保留集任务或任一保留 oracle。
- 给判分器：任务、oracle、响应以及本 rubric；不要求其猜测版本身份。
- `holdout/tasks.json` 和 `holdout/oracle.json` 分别保存，候选选择冻结后才在最终评测阶段使用。评测后可以归档用于复核，但不能继续把同一批称为未见保留集。

共享文件系统中的路径约定不是安全沙箱。manifest 能发现写入漂移，不能证明文件从未被读取。若执行环境无法隔离读取，只能称为任务级信息隔离；不要对抗性安全承诺。

## 执行与判分

批量响应是 `{"D01": {"verdict":...,"observations":...,"recommendations":...}, ...}`。独立语义结果形状见 `semantic-rubric.md`。

```bash
python3 score.py --verify
python3 score.py --split dev --responses responses.json --out hard-score.json
```

score 默认正常完成判分就返回 0，即使候选有题目未通过；这是评测执行成功，不代表候选合格。`--require-pass` 可将任何硬检查未通过作为非零退出码。完整任务是否通过仍需另行合并独立语义结果。程序错误或冻结资产不一致返回 2。程序评分 JSON 记录 decision accuracy 与硬检查，并明确语义检查尚未执行。独立语义结果单独提交，采用决定将逐题硬检查与语义结果合取；不用字符串关键词衡量质量。

## 冻结与采用

完整约定见 `protocol.json`。三轮是预算上限，不是统计充分性的结论。固定 baseline 与候选的输入、模型设置和预算。质量路径要求至少修复一个失败任务且没有通过任务退步。工程筛查例外：incumbent 与 candidate 的所有开发题完整通过，且候选待迭代指令在去首尾空白后的 Unicode codepoint 数减少至少 15%，可以采用压缩版本。字符数只是上下文体积 proxy，不代表 token 或费用下降，也不是统计非劣证明。所有规则与权限保持不变。baseline 全部通过时，拒绝无证据的修改是允许且正确的结果。

六个开发题与四个保留题，决策标签包含 pass、fail、insufficient。同一事件序列没有跨 split 改写；共享的抽象能力是预期迁移对象。保留题一次评测不提供显著性、普遍质量或成本保证。

## TeamAI 集成

将本目录除 `verify-wrapper.py` 外的固定资产复制到 `rsi/eval/`；将 `verify-wrapper.py` 安装为 `rsi/verify.py`。后者读取 `RSI_TASKPACK`（固定的 dev 或 holdout tasks.json 路径）与 `RSI_RESPONSES_JSON`（批量响应 JSON 字符串），stdout 返回 `{report: ...}`。建议用 `RSI_EVAL_MANIFEST_SHA256` 传入已在运行开始前固定的 manifest hash，避免只信任与数据放在一起的 manifest。wrapper 自身也应由主流程的固定 Git 提交或保护路径 hash 约束。
