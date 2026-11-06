# 独立语义核验

判分者不采用候选自评。将候选输出与该题输入、冻结 oracle 比较；尽可能不向判分者显示版本名、迭代轮次和预期“哪版更好”。允许措辞、建议和推理顺序不同。每题分别给三个布尔值和简短理由：

- `observations_supported`：每个 observation 的实质性事实均得到它引用的行支持；没有编造动作、故障、结果或授权。明确且合理的推断可以接受。引用了存在的行号但行号不支持 claim 时，本项失败。
- `decisive_evidence_explained`：回答当前 question，并解释足以支持决定的关键事实；不把流程状态和业务结论混同，不把未知当成功或故障，不自行增加验收条件。只给正确标签但没有说明决定性证据，本项失败。
- `recommendations_proportionate`：建议若存在，应与发现相关，并清楚是建议；不能绕开审批、篡改评价口径或假定尚未发生的结果。无必要改动时空数组完全有效。

每题三个项目均通过，加上程序硬检查通过，才称为该题完整通过。不要按关键词、引用数量、答案长度或语气计分。输入本身不足时，指出缺口可以完整通过。

语义结果 JSON 形状：`{"judgement":{"semantic_pass":true,"case_results":{"D01":{"pass":true,"problems":[],"observations_supported":true,"decisive_evidence_explained":true,"recommendations_proportionate":true}}}}`。每题 `pass` 是三个语义项目的合取，`semantic_pass` 是所有题的合取；失败时在 `problems` 中记录基于具体证据的理由。判分者看不到的事实不得自行补全。若无法完成独立语义核验，只能报告硬检查，不得将其包装成完整质量分。
