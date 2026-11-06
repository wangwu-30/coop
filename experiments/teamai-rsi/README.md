# TeamAI：三轮有界 RSI 实验

本模块使用 **Tencent TeamAI CLI 0.29.0 + 现有宿主子 Agent**，对 reviewer 指令完成一次基线、三轮候选筛选和最终配对保留集评测。实验只演进可变指令正文；公共协议、开发题、保留题、判分程序、语义 rubric、宿主模型配置和预算保持固定。

## 实际结果

“完整通过”要求该题同时通过确定性硬检查和独立 child 的语义评审。

| 阶段 | 指令字符数 | 开发集完整通过 | 采用决定 | 相对上一版缩短 |
| --- | ---: | ---: | --- | ---: |
| v0 基线 | 580 | 6 / 6 | 基准 | — |
| 第 1 轮 v1 | 478 | 6 / 6 | adopt | 17.59% |
| 第 2 轮 v2 | 393 | 6 / 6 | adopt | 17.78% |
| 第 3 轮 v3 | 331 | 6 / 6 | adopt | 15.78% |

最终冻结版本为 **v3**。原始 v0 的保留集完整通过为 **4 / 4**；冻结 v3 为 **4 / 4**。两次评测都在候选冻结后执行，之后没有继续调整候选。

可变指令正文累计减少 **42.93%**。基线已经全题通过，没有新增通过题；本次观察到的是这组案例上的指令简化。字符数按 `len(text.strip())` 计算，不能据此换算 token、费用、整个上下文体积或一般能力的提升。六个开发题和四个保留题均为合成案例，不能证明真实业务中的“90 分 Agent”。

完整分析：[RESULTS](rsi/RESULTS.md) · [逐轮索引](rsi/run-index.json) · [最终选择](rsi/final/selection.json) · [指令与评测绑定核对](rsi/history/instruction-bindings.json) · [公开提交来源映射](rsi/history/publication-provenance.json)。

## 交付内容与职责

| 资源 | 路径 | 用途 |
| --- | --- | --- |
| 项目约定 | [AGENTS.md](AGENTS.md) | 任务与访问约定 |
| 主 Agent 操作技能 | [.teamai/skills/rsi-cycle](.teamai/skills/rsi-cycle) | 有界循环、子任务派发、归档、当前版本管理 |
| 角色 | [.teamai/agents](.teamai/agents) | improver、reviewer、judge 三个角色 |
| 工作流 | [.teamai/workflows](.teamai/workflows) | 单次评测与单轮候选验证 |
| 固定评估 | [rsi/eval](rsi/eval) | 开发/保留任务、oracle、schema、rubric、manifest |
| 采用程序 | [rsi/decide.py](rsi/decide.py) | 根据固定规则 adopt / reject / retain |
| 全部候选 | [rsi/candidates](rsi/candidates) | v0 到 v3 的真实正文 |
| 最终配置 | [rsi/final](rsi/final) | 冻结指令与选择记录 |
| 演进证据 | [rsi/history](rsi/history) | 输入、回答、硬检查、语义判断、决定、故障与修复 |

主 Agent 接收请求，按需启动 TeamAI workflow；每个 prompt 步骤创建新的 child 上下文。优化器提出候选，reviewer 实际答题，judge 在新的上下文中评审，确定性程序作采用决定。三轮结束后停止优化器，冻结候选，执行最终保留集阶段。

共享知识通过显式输入传递：当前采用的指令、与它配对的成绩，以及开发反馈。此模块没有实现额外的长期记忆数据库或常驻调度服务。每轮结束后以 Git 保存新版本和证据。

### 固定的采用条件

- schema、评测资产完整性与语义检查必须通过。
- 候选比当前采用版本至少多完整通过一题，且无任何已通过题退步；或者两版均全题通过，且可变指令正文至少缩短 15%。
- 同一段指令重复运行得到更高成绩，不算一次改进；`retain` 保持当前版本。
- 只有开发结果参与选择。保留集结果用于最终报告，不用于继续调参。

v3 的第一句引用固定的 shared contract，因此可复用交付是 **指令 + workflow 中的公共 wrapper + protocol + evaluator**。单独复制 331 字符不能复现这次实验条件。

## 复用入口

本目录是 `coop` 仓库中的独立实验模块，没有接入 `coop` 原有运行流程。将 `experiments/teamai-rsi/` 的全部内容（包含 `.teamai/`）复制到一个**独立 Git 工作仓库根目录**，使 `.teamai/` 与 `rsi/` 并列。先提交实验文件，并为该仓库配置自己有权限使用的 `origin`；以下命令在新仓库根目录执行。

以下入口已按 CLI 0.29.0 的 help、随包 setup/workflow 文档核对；没有另行进行全新机器上的三轮复现实验。`init` 会写入项目配置，并可能初始化或提交团队资源、注册 `teamai-reports` 成员，因此应在用于实验的授权仓库执行。

```bash
npm install -g teamai-cli@0.29.0

teamai init . \
  --provider git \
  --scope workspace \
  --agent codex \
  --no-inherit-user-scope

teamai pull
teamai skill get workflow
```

`init` 与 `pull` 职责不同；后者部署团队资源。本次项目中确认部署了 `.codex/agents/rsi-reviewer.toml`、`rsi-improver.toml`、`rsi-judge.toml` 与 `.codex/skills/rsi-cycle/`。

随后在支持 child Agent 的宿主中给主 Agent 一个明确请求，例如：

> 使用项目的 rsi-cycle 技能，在新的实验记录目录运行基线和最多三轮候选。固定评测与模型配置，按程序采用决定推进，冻结最终版本后做一次配对保留评测，把全部候选与证据提交到我的实验仓库。保留本次历史记录。

原实验的保留题已经公开、使用过；若要提出新的泛化结论，应建立新的实验版本和未参与优化的保留集，重新预先固定其 manifest 与规则，不能把这组题再次称为未见数据。

### 基线输入示例

```bash
rsi_inputs="$(python3 - <<'PY'
import json
from pathlib import Path

print(json.dumps({
    "candidate": Path("rsi/candidates/v0.md").read_text(encoding="utf-8"),
    "taskpack": "rsi/eval/dev/tasks.json"
}))
PY
)"

teamai workflow start --describe rsi-evaluate \
  --driver skill \
  --inputs "$rsi_inputs"
```

`--describe` 返回启动入口；主 Agent 按返回内容启动。不要将未具备相应能力的宿主声明成 Codex CLI。后续遵循 `dispatch → 启动 child / ack → 写指定 result file / report → next` 协议，并及时处理返回的 `then`。child 必须实际读取对应角色和 attempt brief；聊天中的回答不能代替结果文件与 report。

`candidate`、`incumbent` 输入传**完整指令正文**；`taskpack`、`baseline_report`、`feedback` 传相对项目路径。`rsi-evaluate` 运行一份指令的评估，`rsi-round` 运行一轮候选。最多三轮的循环、当前版本切换、报告配对、反馈生成、冻结和提交由主 Agent 完成。裸 shell 不会因此自动获得 child 派发能力。

在本次实际执行中，主 Agent 使用本对话宿主的 collaboration child 工具驱动 `--driver skill`，child 显式读取部署角色与 brief。`targets: [codex]` 表示资源部署目标；安装了 Codex CLI 不构成本次通过该 CLI 调用模型的证据。

## 执行边界与复核

各步骤使用新的任务上下文，并遵守本步骤的读取约定；共享文件系统并没有经过验证的读取沙箱。`workspace: read-only` 约束项目 checkout，brief 指定的结果文件位于 checkout 外。相同宿主中的独立 child judge 不等于独立模型或人工真值。模型配置继承宿主，未设 per-step override；token 和账单数据不可得。

`decide.py` 检查比较的任务集、分区、schema、完整性和逐题结果，但没有自行证明 `baseline_report` 确实来自输入中的 incumbent。主 Agent 必须将指令和成绩成对推进；拒绝候选时保持原配对。本次归档另经一次精确正文、结果文件和版本链核对，见 [instruction-bindings.json](rsi/history/instruction-bindings.json)。

只在 run 完全结束、没有活动 attempt 或待执行 `then` 后，修改候选、归档和提交。处理 dispatch 时先启动 child 并 ack，避免交接耗尽固定期限。verify 超时后，在持久终端中仅重试该步骤并成功完成；环境生命周期是可能原因，本次没有单独验证故障根因。Python 命令使用 `-B`，避免导入评估器在只读目录生成缓存。

从本模块根目录核对固定资产：

```bash
python3 -B rsi/eval/score.py --verify \
  --manifest-sha256 1c56315a055d77be2c497c56adc4c799280a2859b1734e8133b8e2890601d84d
```

`rsi/eval/README.md` 是随评测 manifest 冻结的原始说明，其复制/安装段落描述资产制作；当前模块已经采用该布局，不必再次复制 wrapper。更换任务或判分规则应开启新的实验版本，重新固定所有相关 hash，不要在本次历史之上悄悄改题。

### 本次环境与来源

实测版本：TeamAI **0.29.0**、Python **3.12.14**、Git **2.51.1**、Node **24.22.1**。随包官方安装说明要求 Node.js ≥ 20。安装的 Codex CLI 为 **0.167.0**，仅作安装记录。

官方来源：[Tencent/teamai-cli](https://github.com/Tencent/teamai-cli)；操作参数以安装的 0.29.0 `--help`、`skills/teamai/SKILL.md`、`skill-data/setup/SKILL.md`、`skill-data/workflow/SKILL.md` 为本次核对依据。[环境记录](rsi/history/environment.json)

公开历史只包含本次新建通用模块、合成任务和运行证据，运行记录已去掉机器安装标识。`run.json` 的 `teamRevision` 来自执行时的本地 Git；公开副本采用独立提交历史，二者由 [publication-provenance.json](rsi/history/publication-provenance.json) 对应，不能将本地 SHA 当作此公开仓库中的可访问提交。
