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

用用户 settings 里的真实模型（`deepseek-flash`）抓取请求与 SSE 响应后，发现是两层问题叠加：

1. **tool-calling 的正文不在 content**（第一层）。旧提示词没有工具约束，模型先调用只读工具
   `devices_list` + `state_get`，`content` 为 **null**、`finish_reason=tool_calls`；单次调用
   MVP 不执行只读查询、也不回灌结果，所以回合以「无正文、无 plan」结束。改成强制
   `apply_plan` 后，DeepSeek 的 tool-calling 响应 **content 仍为 null**，正文只存在于模型内部
   reasoning；旧实现只读 assistant content，因而仍静默。
2. **thinking mode 的历史约束**（真正让第 2 回合开始崩坏的一层）。自动运行回合没有玩家
   消息，请求历史是 `system → assistant(上一句台词)`，以 assistant 结尾；DeepSeek thinking
   mode 直接 400：
   ```
   The `reasoning_content` in the thinking mode must be passed back to the API.
   ```
   OpenAI adapter 把所有 400 都当“能力不支持”，于是把 tools 永久标记为 unsupported，接着
   `response_format` 也 400，最后落到纯文本 fallback。fallback 让模型输出
   `{"tool":"apply_plan",...,"line":"..."}` 的 JSON envelope；其中一回合 envelope 被截断/不合法，
   原始 `,"line":"..."}` 尾巴就成了 lastLine；另外两回合 envelope 合法但缺 `pacing`，plan 被
   丢弃。用户看到的“前三回合一样、文本里有 \n/括号、没有选项”就是这个 fallback 链的产物。
3. 旧 system prompt 没有工具/输出版式约束，也没有「开场先写背景」的要求。

结论：不是自动运行定时器的问题。自动运行只是每次触发这个“没有 playerText 的回合”，把
两层 provider 协议问题放大成每 10–20 秒一次的空/坏回合。

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
5. **自动运行保留选项**：自动运行不再禁止 choices；提示词说明自动运行也会给玩家选项，由模型
   决定给 0–3 条（出现选项时引擎会等玩家选，这是玩家决策而不是静默）。
6. **thinking-mode 历史修复**：自动运行/检查点回合没有玩家消息时，在消息列末尾补一条
   系统续行 user 消息（`（系统：自动运行继续…）`），不再让请求以 assistant 结尾；它不进
   transcript、不进审计。adapter 不再把 `reasoning_content` 类 400 误判为工具能力缺失，
   避免一次错误永久降级整个进程的 tools。

## 验证

- 真实模型 + 真实 `tentacle-shadow`（临时 dataDir，未动用户存档）：
  - 修复前抓包：turn 2/3 请求以 assistant 结尾 → 400 reasoning_content；adapter 降级后
    turn 4 是文本 envelope，lastLine 为 `,"line":"…"}`，与用户截图一致。
  - 修复后开场：`lastLine` 为约 250–400 字中文正文，第一段是暗室/巢穴/触手出现的背景，
    随后进入试探接触；`autopilot.enabled=true, intervalSec=10`。
  - 修复后自动运行：开场后 26s 快照到 turn 3；transcript 的 turn 1/2 都是完整、不同的正文；
    没有再出现 reasoning_content 400、pacing 被丢或文本 envelope。
  - 第二回合玩家消息：正文包含触手动作、身体反应与支配台词；自动运行仍可出 choices。
- core 新增测试：`runTurn` 使用 `narration` 作为 line；空回复重试一次；adapter 不对
  thinking-mode 400 降级 tools；`protocol` mandatory 且排在 world 之后；tool schema 含
  `narration`。宿主测试：开场 prompt 含协议与开场指令；自动回合末尾补系统续行 user 消息，
  并保留 choices。
- 全量：core 52 files / **683 tests**、desktop 17 files / **216 tests**。

## 影响

- 其他 OpenAI-compatible provider 若同时返回 content 与 narration，优先使用 content，避免
  重复；没有 narration 的旧路径仍兼容。
- 提示词新增 protocol 段可能让 prompt 超过 `budgetChars`（mandatory 设计使然）；这是为了
  不再静默，和 boundaries/world 同类例外。
- 不改变任何控制/安全边界：narration 只是文本，设备动作仍只来自已解析的 beats。