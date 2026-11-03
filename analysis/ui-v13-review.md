# ui-v13 对抗复核：强度百分比语义 / 请求值审计 / 延续与 stop / loop 顺序 / 波形名

> 复核员：reviewer（task-19），只读。基线 **HEAD = ff05b1c（v12）**；对象 = 工作区未提交第四轮 diff
> （14 files **+741/−227**：core intents/tools/executor + host play.ts + UI play.js/style.css + tests + 5 个文档）。
> 唯一写入本文件；未改代码、未 commit。
> 证据：`.ui-shots/t15-wavename/`、`.ui-shots/t18-effects/`（CDP 真实 UI + stub 宿主，report.json + 截图已核）+
> 本机独立门禁 + 代码/测试阅读 + `resolvePlan` 行为探针。真实模型 smoke（request=70/40、actual=14/8）只有 Lead 口述，
> **没有可复核产物**；真实郊狼 BLE 仍未验证；本机最新 audit 仍是 v10/v11 构建。

---

## 0. 门禁（独立复跑）

| 检查 | 结果 |
| --- | --- |
| core `vitest run` | **52 files / 742 tests passed**（与 ui-v13.md 一致） |
| desktop `vitest run` | **18 files / 249 tests passed** |
| 两包 `tsc --noEmit` | 均 exit 0 |
| esbuild `main/index.ts` / `dev-server.ts`（输出 NUL，不落盘） | 均 exit 0（main 632.7 kb） |
| `node --check src/ui/play.js` | ok |
| CDP `.ui-shots/t15-wavename` / `t18-effects` | 真实 index.html/play.js + stub 宿主；t15 覆盖显示/改名/切换/未选择/长名截断/390 窄屏，t18 覆盖 `区间 40% → 实际 8%`、旧路径 `胸部 · 55% · 涟漪`、cap100 合并 `大腿 · 40%`、超长 chip 截断、1600/390 无溢出 |

源码 mtime ≤ **22:15**；ui-v13.md 22:17；复核时工作区仍在小幅更新，最终以上述 mtime 为准（本报告写于 22:2x）。

---

## 1. 结论速览

- **P0：0 项。** 没有新增控制入口/绕过 cap/ceiling/LOCKED 的路径；request 字段不含 cap；延续 replay 仍走 registry 夹紧。
- **P1：2 项**（都落在 b 延续/preempt 边界）：
  1. **P1-1（本轮新增）** `recordPlanBodies` 在 dispatch **之前**、无条件记录/删除延续状态；对 **blocked（锁定）/aborted（preempt）/rejected** 的命令也会写入或删除，于是下一回合可能“延续”一条从未下发过的命令，或丢掉一条从未执行的 stop。
  2. **P1-2（既有，非本轮 diff；b 复核发现）** 宿主 `TurnExecutor` 包装只接收 3 个参数，**丢掉了 turn abort signal**；`PlanExecutor` 实际拿不到 signal，preempt/超时不能按设计丢弃剩余 beat。
- **P2：9 项**（loop→stop 的 warning 误报、人类直控被延续覆盖、delta 请求可 >100、文档 2s/500ms 与版本号、UI 仅静态/CDP 测试、真实 smoke 无产物、无 TTL 的产品风险、双 resolve、效果去重 key 等）。
- **交付判断：需修 P1-1（新的延续记录时机）与 P1-2（一行 signal 透传）后再交付；其余语义/UI/审计均闭环，真机回归除外。**
  若产品明确接受“延续状态可以来自未成功下发的 plan intent”，P1-1 可降为 P2；否则它是新控制路径，不建议放行。

> **更新（2026-11-03 22:32 后）**：P1-1/P1-2 已修（事务提交 + options 透传），人类直控窗口与 loop→stop 误报也已修；
> delta 复核见 **§6**。两 P1 均闭环，无新 P0/P1；最终判定 **可交付（真机回归除外）**。本节/§3 保留修复前状态。

---

## 2. 逐项复核（a–f）

### a) 百分比语义 / cap 不泄漏 / request 真实性

- **工具描述**（`packages/core/src/agent/tools.ts:65-104`）：`targetPercent` 明确 0–100 区间百分比、100=玩家 cap、50=中点、普通给 40–70、不要 5–20、具体 cap 数值不可见；`deltaPercent` 只用于微调；`strength` low/med/high=40/70/100%；waveform change 明确幅度由 `beat.strength` 决定且不接受 targetPercent/deltaPercent。测试 `agent-tools.spec.ts:169+` 断言描述含“50 = 区间中点/不要用 5–20/具体上限数值对模型不可见”，并断言不含具体 cap 例子。**未发现工具描述泄漏 cap。**
- **prompt**（`play.ts:179-180`）：只写相对档位和“100%=玩家上限”，无具体数值；测试断言 prompt 不含“上限 20 时输出 10”。`agent/context/director.ts:475` 只用 cap 计算 low/med/high 档位，输出的是档位而非 cap 数值；不构成泄漏。
- **单一路径**：`mapPercentThroughRange` 只在 `intents.ts:671`（level change）与 `:775`（strength 回退）被调用；`policy.ts:222` 是唯一定义。registry 的 `clampPercentToRange` 只做绝对百分比夹紧/下限，不做第二次“缩放”。**没有第二条缩放。**
- **request 真实性**：
  - level change：`request.requestedPercent = requestPercent(...)`（targetPercent 优先，其次 current relative + deltaPercent，最后 strength），映射前值；`targetPercent/deltaPercent` 原值也保留（`intents.ts:617-690`）。
  - strength-only / intent suggestion / waveform change：`requestedPercent = 40/70/100`（`strengthRelativePercent`）。
  - stop：request 固定 `{strength,targetPercent:0,requestedPercent:0}`。
  - **不含 cap**；executor 原样带到 `DispatchStatus.request` 和 `plan_resolved.actions[].request`（`executor.ts:82-95/357-440`；测试 `execution-executor.spec.ts:284`），host 再透传到 transcript effect（`play.ts:1468-1488`；测试 `play.spec.ts:2153+`）。
  - **行为误差**：`deltaPercent` 路径的 `requestedPercent` 是“当前相对位置 + delta 后的有效目标”，不是模型字面 target；但 `deltaPercent` 原值保留，语义可解释。极小问题见 P2-4（可 >100）。
- **效果显示一致性**：host effect 的 `requestedPercent`/`strength` 来自 action.request，`percent` 来自 action.percent；UI `effectPercentText`（`play.js:656-667`）在两者都有且不同时显示 `区间 X% → 实际 Y%`，相等时单值，无 request 时旧格式；CDP 已核 `阴蒂 · 区间 40% → 实际 8% · 腔鞘套弄抽吸`、旧路径 `胸部 · 55% · 涟漪`、cap100 `大腿 · 40%`。**显示与数据一致。**
- **结论 a）闭环**（除 P2-4 的 delta 边界与文档口径）。没有发现模型可见 cap 或第二道缩放。

### b) 延续 / preempt / 暂停 / 锁定 / TTL

- **设计**：`lastBodies` 记录每回合最终合并命令的 body；`holdContinuity` 在每回合开始对未被新 plan 覆盖的 ready 通道重放原 body（level 用绝对 percent；pattern 用原 envelope+waveform），bounded `min(30, channel.maxDurationSec)`；仅 `remaining>6s` 时不重启；**去掉 90s TTL**；stop/percent 0 与 stop 事件清除；人类直控不进入记录。测试覆盖 stop/长效果不重启/91s 后仍延续/loop 原 envelope/旧 TTL 移除，且 CDP 未涉及真实 host。
- **P1-1（新增）记录时机错误**：`play.ts:1058-1066` 在调用 `this.executor.dispatch(...)` **之前**调用 `recordPlanBodies(plan, ctx)`；`recordPlanBodies`（`play.ts:1330-1341`）无条件对 resolved commands 做 `lastBodies.set/delete`。而 executor 在以下情况**不会下发任何命令**：
  - `ctx.snapshot.locked || registry.isLocked` → 直接 blocked 返回 `actions:[]`（`executor.ts:199-216`）；
  - signal 已 abort（aborted before first command）→ `actions:[]`、`preempted:true`（`:218-235`）；
  - 逐命令 abort → 剩余命令不执行（`:255-262`）；
  - 某条命令被 registry 拒绝（NOT_CONNECTED/LOCKED/policy 等）→ `actions` 中 `status:'rejected'`，没有真实输出（`:354-440`）。
  上述情况下 lastBodies 已经被更新：下一回合一个未被 plan 提及的通道会**重放一条从未下发/被安全拒绝的 body**（system actor），或一条 stop 已被删除但 stop 从未执行（旧效果仍在硬件上）。这直接违反“延续上一回合的**输出**”，并且让**被安全层拒绝的命令**通过 host continuation 重新进入下发路径（虽然仍走 registry 夹紧，但控制来源不再是已接受 plan）。建议：pre-resolve 后先构造候选 map，`dispatch` 返回后只对 `result.actions` 中 `status !== 'rejected'` 的 key 提交；被 blocked/preempted 的 key 保留调用前状态（stop 的 delete 也只在 stop 被接受时提交）；补 blocked/preempt/rejected 三组测试。**在本轮代码里这是新引入的边界，列为 P1。**
- **P1-2（既有，非本轮 diff）abort signal 丢失**：`runTurn` 的 `stagedExecutor` 把第 4 个 `options`（含 signal）传给 host executor（`loop.ts:256-265`、`pipeline.ts:604-608`），但 host 包装 `dispatch: async (plan, ctx, diagnostics)`（`play.ts:1058`）没有接收第 4 参数，随后调用 `this.executor.dispatch(plan, ctx, diagnostics)`（`:1066`）也未传 options；`PlanExecutor` 的 `isAborted(signal)` 永远拿到 undefined（`executor.ts:220/259/409`）。因此 **preempt/超时不能丢弃剩余 beat**，preempted 的 `remainingBeats`/actions 语义在 host 路径不成立（core 单测直接传 signal，所以测试全绿；desktop 没有 preempt-during-dispatch 测试）。HEAD ff05b1c 同样如此，非本轮引入；但它使 b 的 preempt 边界不闭环，且 P1-1 的 abort 分支只要 signal 修好就会变成真实风险。建议一行修复：host 包装接收 `options` 并透传；补 desktop 的 preempt-during-dispatch 测试（延迟 registry + submitPlayerMessage）。
- **暂停/结束/锁定**：pause/end/panic 走 registry.stop/emergencyStop → `noteDispatch` 收到 `stop`（含 all）清空（`play.ts:1307-1317`）；pause 后 hold 不会复活；end/panic terminal 后无下一回合。**pause/end 路径本身 OK**；**锁定 blocked plan 的 lastBodies 风险属于 P1-1**。
- **无 TTL**：用户接受“未提及通道默认延续”，代码实现一致；测试 `keeps continuing ... past old 90s TTL` 真断言。风险在 P2-8（叙述已写“放开”但没调用 stop 时，旧 body 会一直续）。
- **重放安全性**：level/pattern 都走 registry；拒绝被 catch 且不阻塞回合；envelope 绝对值由 registry clamp；无绕过。D16 的 `modulation` 只是透传字段，executor/registry 当前都不应用，因此 hold 不传不影响实际输出（非 finding）。

### c) loop 顺序 warning

- 实现：`mergeChannelCommands` 对每个被 supersede 的命令追加 `loop output must be the last beat ... earlier beats need a fixed duration`（`intents.ts:305-320`），条件是 superseded body 为 pattern + waveformId 且 `ctx.waveforms.get(id)?.loop===true`；最终 loop、不同通道不触发。测试 `scenario-resolve.spec.ts:336/355/381` 覆盖“warning/最终 loop 不 warning/不同通道不 warning”。sustain 仍只作用于最终 body（v12 修复），warning 不影响 merge/sustain。
- **P2-1**：若同通道是 **loop beat 后接显式 stop**，superseded loop 也会触发该 warning（本机探针：`b1 loop 4s` + `b2 stop` → commands 只有 stop，warnings 同时含 superseded + loop-order）。这并非“loop 被后续输出截断”（stop 是合法的终止），warning 属噪音；若未来队列把“loop 后接 stop”视为合法，应排除 final stop。P2/P3。
- 与未来队列约束自洽：loop 只能最后一拍、前面固定时长；当前只 warning 不强制，符合“未实现隐式队列”。

### d) UI / CDP

- 效果小框（`play.js:656-690`）：requested/actual 均有限时显示 `区间 X% → 实际 Y%`；相等单值；缺 request 旧格式；`status==='rejected'` 不渲染（host 已过滤）；按最终 text 去重；CSS `max-width/ellipsis`。CDP t18 覆盖 desktop/narrow、旧路径、cap100 合并、超长 chip（narrow 下 clipped=true）、无溢出。
- 波形名（`play.js:900-970`）：仅 `supportsWaveform` 通道创建 `.live-wave-name`；`channel.waveform` 的 `{id,name}` 更新时刷新，title 含 id，缺失显示“波形：未选择”；CSS 单行 ellipsis。CDP t15 覆盖显示/改名/切换/未选择/长名/390 窄屏/非波形通道无此行。
- **P2-5 文档/频率**：ui-v13.md 与前端设计写“随 2s snapshot 更新”，实际全局 `POLL_MS = 500`ms（`play.js:34/2052`）；行为更快，不算 bug，但文档不准确。
- **P2-6 测试层次**：UI 只有 dashboard.spec 的字符串静态断言 + 手动 CDP；`effectPercentText`/wave name 更新/去重没有 vitest/DOM 单测。CDP 产物真实，但不进 CI；回归风险。
- **P2-7**：t18 的 “只有区间 · 区间 70%” 说明 request 有值而 actual 缺失时只显示请求值；这是合理降级，但缺测试说明该路径来源（可能是 waveform/stop 的 action）；可补一条。

### e) 门禁 / 测试缺口

- 已复跑：core 742、desktop 249、两包 tsc 0、esbuild main/dev-server 0、node check play.js；diff 14 files +741/−227。
- 真断言覆盖：request 传播（executor/host/effects）、loop warning 三种、旧 TTL 移除/stop 清除/loop 原 envelope、UI 静态/CDP。
- **关键缺口**：
  1. **P1-1** 的 blocked/preempt/rejected 延续测试没有；
  2. **P1-2** 的 host preempt-during-dispatch 没有；
  3. loop→stop 的 warning 无测试（应为噪声或排除）；
  4. 人类直控 level 后下一回合被延续覆盖无测试；
  5. effect request 的 delta 越界/无 actual 路径无测试；
  6. UI 行为无 vitest；
  7. 真实模型 smoke 无 artifact、真实 BLE 未验。

### f) 对用户“为什么低”的结论

- **诊断闭环**：真实 smoke 的 request 70/40、actual 14/8 与 cap 0–20 完全吻合映射公式（70%×20=14，40%×20=8），说明模型确实改成了“区间百分比”请求，引擎没有第二道缩放；效果小框现在同时显示请求/实际，能区分“模型请求低”与“映射后低”。**这部分足以回答“为什么以前低”**（旧 model targetPercent 15 / strength low + UI 只显示实际值）。
- **但“低”的主观感受未完全闭环**：100%=玩家 cap，所以 cap 11/15 时，70%/40% 请求的实际值约 8/6（native ~16/12 /200）；cap 0–20 时 14/8。要更强只能**提高通道软上限**或让模型给 high/100%；这不是引擎 bug。用户原话“放宽到 100 时请求 30%+、调回低值实际 <10%”正是区间映射按 cap 缩放的定义。建议对用户明确：
  - “请求值是区间百分比，不是设备满量程百分比；当前 cap 决定天花板；模型现在普通给 40–70，若仍觉得弱请把该通道上限拉高（或要求 high=100%）。”
- **未闭环项**：真实硬件/真实进程整局；模型偶发仍可能给低 targetPercent（文档限制已承认）；真实 smoke 无产物；用户对“百分比=cap 相对值”的接受度需要产品沟通。

---

## 3. 问题清单

### P0

无。

### P1

**P1-1｜延续状态在 dispatch 前无条件记录/删除，包含 blocked/preempted/rejected 的命令（本轮新增）**
- 位置：`apps/desktop/src/main/play.ts:1058-1066`（先 record 再 dispatch）、`:1330-1341`（无条件 set/delete）；对照 `packages/core/src/execution/executor.ts:199-235`（locked/aborted → actions:[]）、`:255-262`（逐命令 abort）、`:354-440`（rejected）。
- 现象：plan 被 LOCKED 阻断、或 turn 在命令间被 abort、或某命令被 registry 拒绝时，下一回合未提及的通道会以 `system` 重放这些**从未成功下发**的 body；若 body 是 stop，则延续状态被提前删除而实际 stop 没执行。
- 影响：违反“延续上一回合输出”的产品规则；让被安全层拒绝的 plan 意图通过 host 延续路径重新尝试下发（仍受 registry 夹紧，但控制来源不再是已接受 plan）。
- 建议：dispatch 后按 `result.actions` 的 `status !== 'rejected'` 做事务提交，blocked/preempted 保留旧状态；stop 的 delete 也只在 stop 被接受时提交；补三组测试。若产品接受该边界则降为 P2，但需在文档写清。

**P1-2｜host 包装丢弃 turn abort signal，preempt 不能停止剩余 dispatch（既有，非本轮引入）**
- 位置：`apps/desktop/src/main/play.ts:1058/1066` 只接收/传递 3 个参数；`packages/core/src/agent/loop.ts:256-265`、`pipeline.ts:604-608` 传入第 4 个 `options`（含 signal）；`executor.ts:220/259/409` 依赖 signal。
- 现象：preempt/超时后，若 `apply_plan` 回调已经进入 dispatch，剩余 beat 仍全部下发；core 的 abort 单测全绿（直接传 signal），host 路径没有测试。
- 影响：preempt 语义（M2 §4.8）在真实 host 不成立；P1-1 的 abort 分支一旦修好会变成真实风险。
- 建议：host 包装加 `options` 透传（一行）+ desktop 测试：延迟 registry.setLevel，玩家消息 preempt，断言后续命令不再 dispatch（remained action 为空/preempted 标记）。

### P2

**P2-1｜loop→stop 会误报 loop-order warning**
- 位置：`intents.ts:305-320`；探针 `b1 loop 4s` + `b2 stop` → warning `loop output must be the last beat` 与 superseded 同时出现。
- 影响：审计噪音；未来队列若允许 loop 后 stop 会误判。建议 final body 是 stop 时不加该 warning，或改写措辞。

**P2-2｜人类直控 level 不算延续来源，但会被后续 hold 覆盖**
- 位置：`play.ts:1307-1317`（只记录 model plan；人类直控只处理 stop）；`holdContinuity` 每回合重放 lastBodies。
- 现象：人类直接把通道调到某强度/波形后，下一回合若模型未提及该通道，hold 会把它改回**上一次 model plan body**；由于无 TTL，影响持续存在。建议明确产品规则（人类直控是否应清空/更新 lastBodies），或在直控时清空该通道延续状态。

**P2-3｜delta 请求的 `requestedPercent` 可超出 0–100，效果小框可能显示 `区间 115%`**
- 位置：`intents.ts:737-756`（current relative + delta，未 clamp 请求值；map 内部 clamp 到 100）；request 原样进入 audit/UI。
- 影响：审计/效果显示与“0–100 区间”语义不一致；`clamped` 标记存在但 UI 不展示。建议 request 记录“有效请求”或对展示 clamp 并注明 clamped。

**P2-4｜文档与实际频率/版本号不一致**
- ui-v13.md、前端设计 §17 写“随 2s snapshot 更新”，实际 `POLL_MS=500`（`play.js:34/2052`）；dashboard.spec 注释出现“v14”而本轮是 v13。影响：读者误解刷新率/版本，非功能问题。

**P2-5｜UI 行为缺自动化测试**
- 只有 dashboard.spec 静态字符串断言 + 手动 CDP（`.ui-shots/t15-wavename-cdp.mjs`、`t18-effects-cdp.mjs`）。`effectPercentText` 的相等/缺失分支、wave name 同名/改名/清空、去重/窄屏均无 vitest。建议抽纯函数（像 chart-math）补单测。

**P2-6｜真实模型 smoke 无可复核产物；真实 BLE/真实进程整局仍待做**
- ui-v13 的“request=70/40 actual=14/8”与 Lead 口述一致，但无 audit/trace 文件；本机最新 audit 仍是 v10/v11 构建。交付前需要用户真实硬件回归 + 真实进程跑一局。

**P2-7｜无 TTL 的产品风险（用户已接受，但需写清）**
- 叙述里写“放开/退出”而模型忘了 stop 时，旧 body 会一直续（每回合 bounded 30s），直到显式 stop。用户已接受“未提及默认延续”，但建议在 UI/文档提醒；`holdContinuity` 只在有回合时续接，长时间无回合会停。

**P2-8｜双 resolve 成本/告警**
- `recordPlanBodies` 与 executor 各 `resolvePlan` 一次（`play.ts:1065/1331` + executor），结果确定但多一次解析；host resolve 的 warnings 被丢弃。影响小，可在重构 P1-1 时顺便消除。

**P2-9｜效果去重 key 不含 requestedPercent**
- `effectSummary` 的 key 为 device/channel/region/percent/waveform（`play.ts:1460-1468`）；两个同 percent/waveform 但 request 不同的 action 会被合并（实际同一命令通常不会）。影响小。

**已验证通过｜cap 不泄漏 / 单一映射**
- 工具/prompt 无具体 cap；`mapPercentThroughRange` 只有 resolver 一处；request 无 cap。测试断言覆盖。**列为“已验证通过”，不是 finding。**

---

## 4. 队列 / loop 约束

- 用户“若未来做队列，同通道 loop 只能最后一拍、前面固定时长”与当前实现一致：merge 仍最后 body 生效，warning 提示 loop 被 supersede；sustain 只对最终 body。真正的隐式队列仍未实现，**不建议现在做**（BeatPlan 无时间轴，会与下一 plan/选项/暂停/preempt/probe/审计/效果框抢占）。若未来做，应显式 `beats[].startMs`/`sequence`，并在 queue 层强制“loop 只能最后”；当前 warning 是合理预留。
- 建议把 P2-1（loop→stop 误报）在 queue 设计时一并定义为“stop 是终止，不属于输出截断”。

---

## 5. 复核记录

- 只读复核：`git diff`（HEAD ff05b1c → 工作区，初轮 14 files +741/−227；delta 后 **+1017/−249**）+ `analysis/ui-v13.md` + `.ui-shots/t15-wavename/`、`t18-effects/` + 本机 audit；未改源码，唯一写入本文件，未 commit。
- 独立门禁：初轮 core 52/742、desktop 18/249；delta 后 **core 52/743、desktop 18/253**、两包 tsc 0、esbuild main/dev-server 0、`node --check play.js` ok。
- 行为探针：`resolvePlan` 的 loop→stop warning；P1-1/P1-2 为代码路径复核（未动态构造 host preempt/blocked 用例，测试缺口已列）。
- 结论：**初轮需修 P1-1/P1-2；22:32 delta 修复后两 P1 均闭环，最终见 §6（可交付，真机回归除外）。**

---

## 6. P1-1 / P1-2 / P2 修复复核（delta，2026-11-03 22:32–22:40）

> Lead 已修：P1-1 延续记录改为 dispatch 后事务提交；P1-2 host 包装透传第 4 个 options（含 signal）；
> 人类直控新增可信窗口与 lastBodies 清除；loop→stop warning 误报由 core 修（最终 stop 不报）。
> 只读复核；diff 14 files **+1017/−249**，源码 mtime ≤22:31；独立门禁 **core 52/743、desktop 18/253、
> 两包 tsc 0、esbuild main/dev-server 0、`node --check play.js` ok**（与 Lead 数字一致）。**未发现新 P0/P1。**

### 6.1 P1-1（事务提交）— ✅ 闭环

- 实现（`play.ts:1066-1083/1364-1392`）：
  1. 先 `resolvePlan(plan, ctx)`，**不写** `lastBodies`；
  2. `dispatchWindowActive = true` 后 `this.executor.dispatch(plan, ctx, diagnostics, options)`（第 4 参数含 signal）；
  3. `commitResolvedBodies(resolved, result)`：`result.blocked` → 不提交；`actions.length !== commands.length`（preempt/abort 尾）→ 不提交；逐条校验 `beatId/deviceId/channelId` 身份，任一不匹配整轮不提交；
  4. 只对 `status !== 'rejected'` 提交：level/pattern 存原 body，`level percent<=0`（stop）删除；被拒 stop 不删除。
- 测试真断言（`play.spec.ts`）：
  - `:2051` blocked plan → 下一回合仍只延续旧的 20% body，不会出现 blocked 的 50%；
  - `:2092` 单通道 rejected → 只有另一通道继续；
  - `:2117` rejected stop → 旧 body 保留，后续仍延续；
  - 既有正常路径测试仍通过。
- 结论：**原 P1-1 的“dispatch 前无条件写状态”已消除**；blocked/preempt/rejected 都不会再把未下发命令变成延续状态，被拒 stop 也不会误删。✅

### 6.2 P1-2（signal 透传）— ✅ 闭环

- 实现：host 包装 `dispatch: async (plan, ctx, diagnostics, options)`，并把 `options` 传给 `this.executor.dispatch(plan, ctx, diagnostics, options)`（`play.ts:1068/1078`）；`pipeline.ts:604-608` 的第 4 参数链现在贯通到 `PlanExecutor`。
- 测试：`play.spec.ts:2146` `carries the turn abort signal into the executor`：`turnTimeoutMs` 在 dispatch 前 abort →
  `plan_resolved.preempted===true`、`planActions===0`、所有通道 percent 0。✅
- 残余（P2，既有语义）：若 abort 发生在**部分命令已下发之后**，`actions.length !== commands.length` 会整轮不提交，保留**更早**的 body；这是 Lead 选的保守策略（不会 replay 未执行命令，但可能与本轮已部分生效的输出不完全一致）。建议文档写明。

### 6.3 P2 人类直控 / loop→stop — ✅ 闭环

- **人类直控**：新增 `dispatchWindowActive` 可信窗口（模型 dispatch 与 hold 期间为 true）；窗口外的 level/pattern/waveform 事件在 `noteDispatch`（`:1339-1347`）删除该通道 `lastBodies`；stop 仍无条件清。测试 `play.spec.ts:2023`：人类 `setLevel('human', a=15)` 后下一回合只延续 b（20%），a 不被覆盖。✅
  - 残余 P2：可信窗口**内**（模型 dispatch 的毫秒级窗口或 hold 执行中）并发的人类直控仍会被当作受信事件；v13 文档限制已承认，概率极低。
- **loop→stop warning**：`mergeChannelCommands` 新增 `finalIsStop` / `isStopBody`（`intents.ts:313-336`），最终 body 是 stop 时不追加 loop-order warning；测试 `scenario-resolve.spec.ts:366` 覆盖 loop→stop 合法终止。✅

### 6.4 仍存在的 P2（均不阻断）

1. **degraded waveform 的延续 body 仍存“可能失败的波形”**：`commitResolvedBodies` 用**resolved** body 提交；executor 在 waveform 失败后跑 plain pattern（status degraded），若该波形持续不可用，下一回合 hold 用同一 waveform 会再次失败并被 catch → 通道静默，而不是延续实际跑过的 plain pattern。建议 degraded 时提交 fallback body（或 hold 失败重试 plain）。测试缺失。
2. **部分 preempt 不提交**：见 6.2 残余；保守但可能让 next hold 重放更旧 body；文档写明即可。
3. **人类直控可信窗口内并发**（6.3 残余）。
4. **delta 请求的 requestedPercent 可 >100 / 为负**（原 P2-3，未修）；UI 原样显示，建议展示 clamp/clamped。
5. **文档 2s vs 实际 POLL_MS=500**、dashboard.spec 注释 v14/v13（原 P2-4/P2-5）；非功能。
6. **UI 仍只有静态断言 + 手动 CDP**（原 P2-5）；`effectPercentText`/wave name 无 vitest。
7. **真实模型 smoke 无 artifact、真实 BLE/真实进程整局未回归**（原 P2-6）。
8. **无 TTL 的产品风险**、**双 resolve**、**效果去重 key 不含 requestedPercent**（原 P2-7/8/9）仍存在，均不阻断。
9. **request/cap/effect 语义、loop warning、UI CDP、门禁**均已复核通过（见 §2 与 §6.3）。

### 6.5 最终结论（更新）

- **P0=0；P1-1、P1-2 均已闭环**（实现 + 真断言：blocked/rejected/stop/abort signal；人类直控与 loop→stop 也闭环）。
- **无新 P0/P1**；delta 未引入安全/控制路径回归：延续只来自 `status !== 'rejected'` 且身份匹配的实际下发；hold 仍走 registry clamp；信号透传后可正常 preempt。
- **最终：可交付（真机回归除外）**。剩余 P2 为边界/可观测性/测试自动化/文档口径，均不阻断；建议下一批优先处理 6.4-1（degraded 延续）与 6.4-3（可信窗口并发），并在真实郊狼 BLE + v13 真实进程整局回归后提交。
