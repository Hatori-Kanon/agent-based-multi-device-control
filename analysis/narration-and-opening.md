# 自动运行「AI 不说话」与开场背景：诊断与修复（2026-11）

## 现象

- 用户开启自动运行后，审计里每 10–20s 都有 `turn_started` / `turn_completed`（outcome
  `completed`），但 UI 没有台词；session 快照 `lastLine: ""`、`recentBeats: []`。
- 打开自动运行后的实际审计（2026-11-02T22:34Z，pack `tentacle-shadow`）：

```
turn_started turnId=1 trigger=resume
turn_completed turnId=1 outcome=completed durationMs=933
turn_started turnId=2 trigger=autopilot
turn_completed turnId=2 outcome=completed durationMs=1072
... turn 3/4 同样，lastLine 为空
```

- 没有 `plan_resolved`；说明模型既没有给出正文，也没有给出有效 plan。

## 根因

用用户 settings 里的真实模型（`deepseek-flash`）抓取了一回合的请求与 SSE 响应：

1. 首次请求（旧提示词）模型先调用了只读工具 `devices_list` + `state_get`，`content` 为
   **null**，`finish_reason=tool_calls`。单次调用 MVP 明确不执行只读查询、也不回灌结果，
   所以回合直接以「无正文、无 plan」结束。
2. 把提示词改成「必须 apply_plan」后再抓：模型确实调用 `apply_plan`，但 DeepSeek 的
   tool-calling 响应 **content 仍为 null**，正文只存在于模型内部 reasoning；旧实现只读
   assistant content，因此仍然静默。
3. 旧 system prompt 没有工具/输出版式约束，也没有「开场先写背景」的要求。

结论：这不是自动运行定时器的问题，而是 **单次调用 tool-calling 的正文载体与提示词
协议不匹配**；自动运行只是让每 10–20s 定时触发这个空回合。

## 修复

1. **`apply_plan.narration`**：在 `M2_TOOL_SCHEMAS` 的 `apply_plan` 增加可选 `narration`
   字段（完整正文，不是计划摘要）。`runTurn` 在 plan 解析前从原始 tool arguments 提取；
   没有 content 时作为本回合 line。`parseBeatPlan` 将 `narration` 加入已知顶层字段并忽略
   （不进入 `BeatPlan`）。
2. **mandatory `protocol` prompt 段**：`buildSystemPrompt` 新增 `protocol`，与 `world` 一样
   在预算外追加、不截断。宿主写入：
   - 不调用 `devices_list`/`state_get`/`look`/`sensors_list`/`waveform_list`（单轮无回灌）；
   - 恰好一次 `apply_plan`；intentId/regions 只取本回合可用；
   - 正文必须写进 `narration`，不能只写 reasoning/只调工具；
   - 动作/环境用（）包裹，不出现设备硬件词。
3. **开场协议**：turn 1 且无 playerText/choice 时追加一行——`narration` 第一段先交代
   场景/背景（环境、玩家姿态、角色如何出现），再进入互动。
4. **空回退重试**：`runTurn` 在「无正文且无 plan」时用一条纠正 user 消息重试一次（不重复
   派发；有 plan 时不重试），覆盖模型偶发只调查询工具的情况。
5. **自动运行不阻塞选项**：自动运行开启时提示词要求模型不要生成 choices，宿主也会丢弃
   plan 里的 choices（自动模式没有玩家可点；否则引擎会等选择菜单而看起来像停住）。

## 验证

- 真实模型 + 真实 `tentacle-shadow`（临时 dataDir，未动用户存档）：
  - 开场：`lastLine` 为约 250–400 字中文正文，第一段是暗室/巢穴/触手出现的背景，随后进入
    试探接触；`autopilot.enabled=true, intervalSec=15`。
  - 第二回合（玩家消息）：`lastLine` 非空，包含触手动作、身体反应与支配台词。
  - 自动运行（interval 10s）：开场后 26s 快照已到 turn 3；transcript 里 turn 1/2 均有正文
    （turn 2 偏短但非空）；自动模式不再生成 choices，所以不会被选择菜单卡住。
- core 新增测试：`runTurn` 使用 `narration` 作为 line；空回复重试一次；`protocol` mandatory
  且排在 world 之后；tool schema 含 `narration`。宿主测试：开场 prompt 含协议与开场指令，
  后续回合不含开场指令。
- 全量：core 52 files / **681 tests**、desktop 17 files / **214 tests**（新增计数见提交）。

## 影响

- 其他 OpenAI-compatible provider 若同时返回 content 与 narration，优先使用 content，避免
  重复；没有 narration 的旧路径仍兼容。
- 提示词新增 protocol 段可能让 prompt 超过 `budgetChars`（mandatory 设计使然）；这是为了
  不再静默，和 boundaries/world 同类例外。
- 不改变任何控制/安全边界：narration 只是文本，设备动作仍只来自已解析的 beats。