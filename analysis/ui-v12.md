# ui-v12：loop 波形续播、自动运行区间（AI/随机）、一 beat/通道（2026-11-03）

> 用户第三轮“改动思路”：
> 1. 部位为什么会重复发送？是导演要分两次 beat 吗？能否队列输出？
> 2. 能否指定一部分波形为 loop 波形（我们或内容包指定），让思考阶段继续播放而不是 hold？
> 3. 自动运行间隔能否是区间，让 AI 在区间内决定等待多久，或随机决定？

## 1. 部位重复发送：原因与取舍（问题 1）

**原因**：不是引擎重复发送，而是**导演模型在同一回合里给同一通道写了多个 beat**（审计 turn 9：b1→a 10% 又 b2→a 1%+b；turn 13：b1→a 2%/40s 又 b3→a 4s）。引擎原先按 beat 顺序**立即**各下发一条命令，于是同一通道被连续覆盖；后一条短动作还会把前一条长保持截断。`BeatPlan` 没有 per-beat 开始时间，beats 是“这一回合的意图集合”，不是时间序列。

**本轮处理**（不改引擎时序模型）：

- 保留 per-channel 合并（v11：最后一条 body 生效、duration 取该通道非 stop 最大、stop 保持 stop、superseded 审计 warning）。
- **全局 TURN_PROTOCOL** 增加硬约束：`同一通道一回合最多一个 beat；需要连续动作请拆到下一回合（重复 beat 会被合并，后一条生效并记 superseded 审计）。`（`nextTurnAfterSec` 的说明只在自动运行的动态节奏行里出现，手动模式不广告。）
- 另修一个真实模型暴露的问题：模型会猜 `beats[].targets.deviceId`（如 `tentacle-shadow`），旧逻辑直接 target dropped → 整拍无输出。现在 **全部 target 都因 device/channel 不存在而落空且 regions 非空 → 回退到 region 匹配**（有任一有效 target 时不会串通道）；提示词同时明确“设备/通道 id 不可见，不要使用 targets”。

**为什么没做队列（输出时刻排队）**：

- `BeatPlan` 没有时间轴字段；"队列"意味着宿主为每个 beat 引入隐式开始时间，会和下一回合 plan、choice 超时、暂停/急停、preempt、probe 登记、效果框（transcript 在回合结束时定格）互相抢占，语义要比现在复杂得多；而且大多数回合的下一 plan 会在队列播完前到达，后半段队列大概率被取消。
- 若确实需要“同回合内顺序动作”，更干净的做法是给 `BeatPlan` 增显式 `beats[].startMs`/序列语义（下一轮可做），或（自动运行时）导演用 `nextTurnAfterSec` 把动作拆到下一回合；不建议本轮用隐式队列。

## 2. loop 波形续播（问题 2）

内容包规范 §4.5 的 waveform 资产本来就有 `loop` 字段（包作者可指定；用户导入的 wave 默认 `loop:true`，内置 `呼吸/潮汐` 等也是 loop）。但运行时此前只把 `loop` 用于“帧循环”，效果仍会在 `durationSec` 到期后停止。

本轮新增 **loop-aware sustain**：

- `ResolveContext.sustainLoopSec?`（宿主传 60）；`resolveBeat` 对 `pattern` 且解析出的 waveform `loop === true` 的命令，把 `durationSec` 抬到 `max(原值, min(sustainLoopSec, channel.maxDurationSec))`。
- 即：**loop 波形会一直播到下一 plan/stop（上限是通道 maxDurationSec 60s）**，思考阶段自然继续，不再需要靠 steady hold 重启；非 loop 波形（如 `stinger-burst`）保持作者写的短时长。
- 仍受人类软上限与 maxDurationSec 夹紧；stop/level 不受影响；同回合 merge 的 duration=max 规则继续生效。
- 包作者在 `waveforms/*.json` 写 `"loop": false` 即可禁止续播（内容包规范同步说明）。

## 3. 自动运行区间：AI 决定或随机（问题 3）

- 引擎 `EngineSnapshot.autopilot` 新增 `windowMinSec/windowMaxSec`；新方法 `TurnEngine.setAutopilotRange(min,max)`（夹到绝对边界 10–60）；`setAutopilotInterval(x)` 兼容=固定窗口 `[x,x]`。
- 每拍等待：**模型 `nextTurnAfterSec` 建议优先**（host 从 plan 透传，engine clamp 到窗口、只消费一次）→ 否则窗口 min<max 时用注入 `random` 在窗口内取整数 → 否则窗口固定值。选定值写入 `intervalSec`（显示 + autopilot 选择超时）。
- 宿主/API：`PlayAutopilotInput` 与 `POST /api/session/autopilot`、start 的 autopilot 载荷都支持成对的 `windowMinSec/windowMaxSec`（缺省回退旧 `intervalSec`；半窗口/min>max/非数字 → 400）；自动运行时协议追加动态节奏行——变窗口写“不写则由引擎在区间内随机”，固定窗口写“固定等待 {n}s”。
- UI（大厅「开局」卡与游玩右轨）：自动运行由单滑杆改为**最短/最长两条区间滑杆**，读数 `20s` / `10–30s`，两端互相推挤保证 min≤max；旧宿主无 window 字段时两个滑杆都回退到 `intervalSec` 单值。CDP 截图 `.ui-shots/t11-autopilot/`。

## 4. 验证

**静态/单测**

- `packages/core`：**52 files / 735 tests passed**；`tsc --noEmit` 通过。
- `apps/desktop`：**18 files / 246 tests passed**；`tsc --noEmit` 通过。
- `corepack pnpm --filter @embodied/desktop build` / `build:dev` 成功；`node --check play.js/chart-math.js` 通过。

**真实模型冒烟**（waveform-capable 四通道 mock、包 0.3.0、玩家部位 小穴/后穴/阴蒂/乳房、autopilot 窗口 10–25）

| 检查 | 结果 |
|---|---|
| autopilot 窗口 | start/end snapshot `windowMinSec=10, windowMaxSec=25`；采样到的 `intervalSec` 依次 18/20/16/23/14（窗口内随机，模型未给 `nextTurnAfterSec`） |
| loop 续播 | `cilia-tickle`/`stroker-tide`/`spiral-squeeze`（loop:true）run_pattern `durationSec=60`；`stinger-burst`（loop:false）保持 12s（作者/模型原值） |
| 同回合重复 | 每个 plan_resolved 的 `(device,channel)` 唯一 |
| 目标兜底 | 模型猜 `targets.deviceId="tentacle-shadow"` 的 beat 现在回退到 region 匹配（修复前该拍 actions=[]） |
| 波形失败 | 0 |
| 思考期 hold | 1 条 system hold（多数空窗已被 loop 续播覆盖，剩下 1 次由 hold 桥接），符合预期 |
| 报错 | 0 |

**UI CDP**（真实 index.html/shell/play/style，stub 宿主）：大厅默认 20/20「20s」、拖区间互相推挤、start payload `{windowMinSec:10,windowMaxSec:30,intervalSec:20}`、右轨从 snapshot 渲染 `10–30s`、POST payload、旧宿主回退单值 25「25s」、结束回大厅记住窗口；1600/760 无横向溢出。

## 5. 限制 / 已知取舍

1. **队列未实现**：同回合多 beat 同通道仍按“后一条生效 + duration=max”合并；若要“按时间顺序播放”，需要 `BeatPlan` 显式时间轴（见 §1）。
2. loop sustain 在 per-channel merge **之后**只作用于最终存活命令：loop 波形的显式短 duration 会抬到 ≤60s，但同通道后置的非 loop/level body 不会被污染；merge 原有的“长 hold 保留”语义仍在（同通道多 beat 取非 stop 最大时长）。作者要短促请写 `loop:false`。
3. autopilot 随机在 timer 每次 re-arm 时采样（包括 turn 进行中的预排与 settle 重排），同一回合可能消耗多个随机样本；模型建议只消费一次。UI 显示的是窗口，不显示每拍随机值。
4. 显式 `targets` 兜底只在“全部 target 的 device/channel 都不存在”时触发；有效但离线的 target 仍按原语义 narrative-only，不会串到别的通道。
5. 真实郊狼 BLE 波形与修复后的真实进程回归仍需用户在硬件上验证。
6. UI 双滑杆的互推/旧宿主回退目前只有 CDP 手动验证（`.ui-shots/t11-autopilot/report.json`），未抽纯函数做 vitest；variable window 下 choice timeout 与 autopilot tick 的竞争语义也缺独立测试（引擎语义已由固定窗口用例覆盖）。
7. `loop:true` 的内置/用户导入波形在 manual 局也会被 sustain（产品取舍）：所有为用户导入波形默认 loop，想要短促请用 `loop:false` 的内容包资产。`nextTurnAfterSec` 只在自动运行生效（提示词已限定）。

## 6. 相关文件

- core：[`packages/core/src/scenario/intents.ts`](../packages/core/src/scenario/intents.ts)、
  [`packages/core/src/engine/turn-engine.ts`](../packages/core/src/engine/turn-engine.ts)
- host：[`apps/desktop/src/main/play.ts`](../apps/desktop/src/main/play.ts)、
  [`apps/desktop/src/main/dashboard.ts`](../apps/desktop/src/main/dashboard.ts)
- UI：[`apps/desktop/src/ui/index.html`](../apps/desktop/src/ui/index.html)、
  [`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)
- 复核：[`analysis/ui-v12-review.md`](ui-v12-review.md)
- 截图：`.ui-shots/t11-autopilot/`
