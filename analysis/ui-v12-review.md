# ui-v12 对抗复核：loop 续播 / 自动运行区间 / 一 beat/通道

> 复核员：reviewer（task-12），只读。基线 **HEAD = 93d19e5（v11）**；对象 = 工作区未提交第三轮 diff
> （16 files **+1067/−143**：11 个源码/测试文件 + 5 个文档；`analysis/ui-v12.md` untracked）。本文是唯一写入。
> 源码 mtime ≤ **12:49**（复核期间只有文档在 12:49 前后更新；最终以 12:50 后的 mtime 为准）。
> 真实运行证据：本机 audit 最后一局仍是 **v10/v11 构建**（08:44–08:47），**本轮 v12 尚未在真实进程/真实硬件跑过**；
> UI 有 CDP stub 产物 `.ui-shots/t11-autopilot/`（report.json + 5 张截图，已核）。

---

## 0. 门禁（独立复跑）

| 检查 | 结果 |
| --- | --- |
| core `vitest run` | **52 files / 728 tests passed**（与 ui-v12.md 一致；Lead 消息里的 725 是 12:48 前旧数） |
| desktop `vitest run` | **18 files / 246 tests passed** |
| 两包 `tsc --noEmit` | 均 exit 0 |
| esbuild `main/index.ts` / `dev-server.ts`（输出到 NUL，不落盘） | 均 exit 0（main 628.8 kb） |
| `node --check src/ui/play.js` | ok |
| CDP 产物真实性 | `.ui-shots/t11-autopilot/report.json` 由 `t11-autopilot-cdp.mjs` 跑真实 index.html/play.js + stub 宿主：
大厅初始 20/20「20s」、拖动互推（10–30、20、45）、start payload `{windowMinSec:10,windowMaxSec:30,intervalSec:20}`、
右轨读 snapshot 窗口、POST payload、旧宿主回退 25/25、760 无横向溢出；截图 `01–05` 已核（rail 版可见「最短/最长」两滑杆） |

---

## 1. 结论速览

- **P0：0 项。** loop sustain / merge / autopilot 窗口都没有绕过 cap/ceiling/LOCKED，也没有新增 agent 可达控制入口。
- **P1：0 项**（但 **P2-1 / P2-2** 是两个“建议在本轮或下一轮尽快修”的语义边界，见 §3；若产品把“非 loop 必须保持作者时长”
  当硬承诺，P2-1 可升级为 P1）。
- **P2：13 项**（sustain×merge 的 duration 污染、target fallback 绕过 distribution、stale nextTurnAfterSec、
  paused 时 setRange 的空转 tick、窗口小数、HTTP start 无效窗口缺独立用例、manual/内置 loop 资产被续播、choice timeout 变窗口测试缺口、
  CDP/真实模型冒烟不可复核、文档与实现的边界、UI 行为缺自动化测试、manual 提示词提到 nextTurnAfterSec）。
- **判定：可交付（真机回归除外）**；交付后需要用户真机回归（真实郊狼 BLE + 本轮真实进程跑一局），
  建议把 P2-1/P2-2 作为下一批小修。对“队列”的判断见 §4：**当前不建议做隐式队列**，应走显式时间轴。

> **更新（2026-11-03 12:57 后）**：P2-1/P2-2/P2-3/P2-4/P2-5 与 P2-12/P2-13 已修复（core 735 tests）。
> delta 复核见 **§7**：这 7 项均闭环，无新 P0/P1；剩余 P2 仅 P2-6/P2-7/P2-8/P2-9/P2-10/P2-11 与文档口径。
> 本节 §1/§3 保留修复前状态。

---

## 2. 逐项复核（a–f）

### a) loop sustain（core `intents.ts`）

- 实现：`resolveBeat` 把 `buildCommand` 结果经 `sustainLoopCommand`（`intents.ts:336-357`）：仅
  `pattern + waveformId + waveform.loop===true + sustainLoopSec>0` 时，把 duration 抬到
  `max(原值, min(sustainLoopSec, channel.maxDurationSec))`；channel cap 缺失时回退 `MIN_DURATION_SEC`。宿主传
  `SUSTAIN_LOOP_SEC=60`（`play.ts:155`、`:1094`）。非 loop、level、stop 原样返回。
- **正确性**：单 beat 的正常路径正确：loop 纹理 4s→60s（channel cap 60）；非 loop stinger 保持 4s；无 sustain 配置保持 4s；
  cap 30 时抬到 30；level/stop 不变（`scenario-resolve.spec.ts:838+` 的 5 条测试真断言）。
- **安全**：抬到 `min(60, channel.maxDurationSec)`，registry `assertDuration` 仍会二次夹紧；不越过 percent/waveIntensity/LOCKED；
  与 stop 同通道时 merge 末条 stop 保持 stop（不会复活）；**未发现安全回归。**
- **P2-1（重要边界）**：sustain 在 **merge 之前**执行，merge 的 `duration=max` 会继承被 sustain 抬大的 duration，
  从而**污染同通道后置的非 loop body**。复现（本机 node 直接调 `resolvePlan`）：
  同通道 b1 = loop 波形 4s（被抬 60）→ b2 = level 5s；合并后 b2 的 level **durationSec=60**（不是 5）；
  同理 loop 后接 `stinger`（loop:false）会让 stinger 跑 60s。触发条件是模型违反“一 beat/通道”或显式 targets 重复，
  但 v11 审计确实出现过同通道多 beat，merge 正是兜底路径，应该在这里正确。修复建议：**merge 之后**再对最终存活 body
  应用 sustain（只对最终 body 是 loop 的情形），merge 的 max 使用 **未 sustain** 的 duration；补一条“loop+非 loop 同通道”测试。
- **P2-7**：host 无条件传 60，manual 模式、内置 `呼吸/潮汐`（loop=true）与用户导入波形（默认 loop）都会从此“持续化”，
  作者写的 `suggest.durationSec`（例如 soothe 15s）会被覆盖；只有 `loop:false` 能退出。属产品取舍，但交付说明应写清。
- **语义/审计**：审计 `run_pattern.durationSec` 会是 60（真实值），效果框不显示 duration；不影响效果框/账本。
  同回合 merge 后 loop 长 hold 与下一回合 plan/stop 的覆盖语义需在文档中讲清（ui-v12 限制 #2 已部分说明）。

### b) autopilot 区间（core `turn-engine.ts`）

- 实现：`EngineConfig.random`（`:118`）、window 字段（`:304-305/181-182`）、`setAutopilotRange`（`:374-397`，夹到绝对
  `[minSec,maxSec]` 10–60，非法输入抛 `RangeError` 且不改窗口）、`setAutopilotInterval` 兼容固定窗口（`:402-408`）、
  `selectAutopilotInterval`（`:1105-1116`：模型 suggestion 优先且消费一次 → 窗口 min<max 用注入 random 取整数 →
  固定窗口返回值）、`scheduleAutopilotTick` 每次 re-arm 采样（`:1118-1130`）、snapshot 暴露 window（`:504-511`）。
- **正确性/确定性**：测试真断言（`engine-autopilot.spec.ts:57/91/168/212/249`）：范围夹取、非法 RangeError 不改状态、
  suggestion 被 clamp 到窗口且只消费一次、注入 random 顺序采样（0→10、0.5→20、0.9→28）、固定窗口不调用 random。
  production 默认 `Math.random`，只影响节奏，不影响安全/审计。
- **choice timeout**：`maybeArmChoiceTimeout`（`:1322-1335`）仍用 `this.intervalSec`；settle 顺序是
  `scheduleAutopilotTick()`（选/采样 → 写 intervalSec）后 `maybeArmChoiceTimeout()`（`:1065-1067`），因此菜单超时 = 下一拍
  选中的等待值（含模型 suggestion）；语义一致。**测试缺口**：variable window 下的 choice timeout 没有直接用例（现有
  engine-choices 用的是固定默认 interval）。
- **P2-3**：`pendingPacedSec` 在 autopilot 关闭时不清空（`setAutopilot(false)` 只 cancel timer）；
  若某回合 plan 给了 `nextTurnAfterSec`，随后关自动运行、若干回合后再开，第一拍会使用这条**陈旧 suggestion**而不是窗口随机。
  建议 setAutopilot(false)/end 时清空 pending（或记录来源 turn）。
- **P2-4**：`setAutopilotRange` 在 `autopilotOn` 时无条件 `scheduleAutopilotTick()`（`:385-393`），**没有 paused 检查**；
  paused 时改窗口会 arm 一个 tick，`onAutopilotTick` 因 `canAutopilotStart()===false` 每拍 emit skipped 并重新 arm，
  形成 paused 期间的 tick 空转（旧 setAutopilotInterval 也有同类行为，非本 delta 新引入，但新 API 同样暴露）。
  建议 schedule/onAutopilotTick 增加 `turnState==='paused'` 直接 return。
- **P2-5**：窗口允许任意正有限数（API/引擎都只 `Number.isFinite && >0`），而 `selectAutopilotInterval` 用
  `round(low+span*r)` 后又被 `Math.min/Math.max` 夹回窗口，非整数窗口可能返回非整数 `intervalSec`（timer 按 ms 截断，
  功能没问题），但 UI range `step=1` 无法精确表示（外部 API/旧客户端可能触发读数字面与滑块位置不一致）。建议窗口用整数校验
  （或引擎 round window）。
- **边界**：start/结束/暂停/锁定切换：`setAutopilot(enabled)` 只 arm/cancel；pause 取消 tick、resume 重新 arm；panic/end
  终态不 arm（既有测试 `:325` 覆盖 paused/locked 不开 turn；但没覆盖 paused 时 setRange 的空转）。

### c) host / API / nextTurnAfterSec

- host：`PlayAutopilotInput` 增加 `windowMinSec/maxSec`（`play.ts:295-310`）；`normalizeAutopilot`（`:2192+`）校验
  positive/finite、成对、min<=max；start/`setAutopilot` 都先 `setAutopilotRange` 再 `setAutopilot`（`:728-733/805-811`）；
  `autopilotPacingLine` 仅在自动运行时会加区间提示（`:1592-1601`）；`SUSTAIN_LOOP_SEC` 传入 resolveContext（`:1094`）。
- API：`parseAutopilotBody`（`dashboard.ts:381-410`）统一 start 与 POST `/api/session/autopilot`（`:1001/:1196`）：
  非 boolean/非正数/半窗口/min>max → 400；绝对越界（5/120）**接受并让引擎夹到 10/60**（与文档“引擎 clamp”一致）。
  旧客户端只发 `intervalSec` 仍走固定窗口；新 UI 发成对 window + intervalSec 中点。**测试**：play.spec 的 host/HTTP
  `windowMinSec` 校验（`:576/599/830` 一带）；**缺口**：HTTP start 的非法 window 没有独立 400 用例（与 POST 共用解析器，
  风险低）。
- **API 归一性（检查通过）**：`openSession` 在 `play.ts:557` 也 `normalizeAutopilot(input.autopilot)`，因此直接
  `PlayHost.start` 与 HTTP 路由一致（半窗口/非正数/min>max → `INVALID_INPUT`），无需修；唯一缺口是 HTTP start 没有
  独立的非法 window 400 用例（与 POST 共用解析器，风险低）。
- **nextTurnAfterSec 可达性（已验证）**：`apply_plan` schema 含 `nextTurnAfterSec`（`tools.ts:213`）→
  `parseBeatPlan` 解析（`beat-plan.ts:321/380`）→ host `runOneTurn` 返回 `plan.nextTurnAfterSec`（`play.ts:1173-1177`）→
  engine `TurnRunnerResult.nextTurnAfterSec` → settle 存 pending（`turn-engine.ts:975-976/1062`）→ 下次 arm 优先使用并消费一次。
  测试 `engine-autopilot.spec.ts:168` + play.spec 的 `nextTurnAfterSec` 用例真断言了 25s 采纳；可达。
- **P2-3 补充**：manual 模式（autopilot off）时 host 仍会返回 `nextTurnAfterSec`，engine 把它存进 pending；若用户之后才开
  自动运行，第一拍用旧值（见 b）。
- **安全**：suggestion 只影响等待秒数；所有命令仍经 registry 夹紧；无绕过。

### d) UI（index.html / play.js / style.css / 静态测试）

- 结构：大厅与右轨各 `*Enabled + *Min + *Max + *Value`（`index.html:79/140`），旧 `autoLobbyInterval/autoRunInterval` 已删；
  play.js 对应 DOM 映射（`:57/61`）、disabled（`:425/429`）、`paintAutoWindow`（`:466-484`，两端同 bounds、读数 `20s`/`10–30s`）、
  `updateAutoWindow`（`:486-503`，拖过界推另一端）、`autoWindowOf` 旧宿主回退（`:504-...`）、`lobbyAutoPayload/sessionAutoPayload`
  发 window + 中点 intervalSec（`:531+/580+`）。
- 行为：CDP 已验证初始 20/20、拖动互推（10–30、20、45）、start/autopilot payload、旧宿主 25/25、结束回大厅记忆 15–45、
  760 窄屏无横向溢出；dashboard.spec 断言新 id 存在、旧 id 不存在、js 含 window 字段（`:1413-1419/1465-1475`）。
- **P2-11（测试缺口）**：UI 交互只有 CDP 脚本（gitignored、需手动跑），没有 vitest/DOM 级自动化；如果 CI 只跑 246 tests，
  双滑杆互推/旧宿主回退回归不会被发现。建议把 `updateAutoWindow/autoWindowOf` 抽成可 require 的纯函数补单测（类似 chart-math），
  或保留一条可自动执行的 jsdom 测试。
- **P2-5 的 UI 侧**：外部 API 写入非整数 window 时，快照 window 可能 10.5/30.5，`input.min/max` 为整数；滑块 `.value`
  会被浏览器按 step 取整，而 readout 用传入值，可能出现“读数与滑块位置不一致”；UI 自身只发整数，正常路径无问题。
- **P2-12（UI 语义）**：readout 只显示窗口，不显示本拍实际采样的 intervalSec；用户看到 10–30 但下一拍等 23 是正常的，
  但可能困惑；可在 title 显示“本次等待 Xs”或保持现状（产品选择）。
- 旧宿主回退链路已覆盖：stub snapshot 只有 intervalSec → 两滑杆都回退 25/25；新 UI 发 window 给旧宿主（旧解析器忽略未知字段）
  用 interval 中点，可行。

### e) 一 beat/通道 + 合并兜底 vs 队列（用户问题 1）

- 现状：全局 TURN_PROTOCOL 增加“同一通道一回合最多一个 beat；连续动作拆下一回合或用 nextTurnAfterSec；重复 beat 会被合并，
  后一条生效并记 superseded”（`play.ts:175`）；core 仍保留 per-channel merge（last body + duration=max + stop 保持 stop +
  superseded warning）。prompt 全局生效（manual 也包含，测试 `:1372/1440/1460` 断言）。
- **是否足以解决“同一部位一回合重复发送”**：是。即使模型不遵守，merge 保证每通道每回合至多一条实际 dispatch；
  审计 action/效果框也只剩一条；用户不会再看到一回合同一部位两次下发。代价是**前一条动作完全被丢弃**（用户只看到最后一条），
  这是从“重复驱动”到“最后意图优先”的确定性收敛，符合 v11 的取舍。
- **为什么不做队列（同意 Lead 的取舍）**：`BeatPlan` 没有时间轴；隐式队列需要宿主为每个 beat 引入开始时间，和下一回合 plan、
  choice 超时、暂停/急停/preempt、probe 登记、效果框/transcript 定格、审计（一个 plan_resolved 一行）互相抢占；
  且多数回合下一 plan 会在队列播完前到达，后半段大概率被取消，收益低、语义复杂。**不建议本轮做隐式队列**。
  若产品确实要“同一部位先轻后重再停”的同回合编舞，正确方向是给 `BeatPlan` 增**显式时间轴**（如 `beats[].startMs` 或
  `sequence`），执行器按时间驱动并可被下一回合/stop 取消——这是下一轮的设计项，不是 host 小改。
- 补充（P2-13）：prompt 里的“用 nextTurnAfterSec 控制节奏”在 manual 模式下没有实际作用（engine 只在 autopilot 使用）；
  可把该句限定在自动运行协议里，避免模型在手动局误以为能排程。

### f) 测试缺口 / 覆盖

- 已有真断言：sustain 5 条（round3 新增）、autopilot range/random/suggestion 5 条、host start/setAutopilot/nextTurn 用例、
  target fallback 3 条（12:48 追加）、UI 静态断言、CDP 真实 DOM。全量 core 728 / desktop 246 / tsc / build 全过。
- 缺口：
  1. **sustain × merge**（P2-1）无测试；
  2. **target fallback × distribution**（P2-2）无测试（只有 synced/plain 用例）；
  3. variable window 下 choice timeout（P2-8）无直接测试；
  4. paused/ended 时 setAutopilotRange 的空转 tick（P2-4）无测试；
  5. autopilot off 后再开使用 stale nextTurnAfterSec（P2-3）无测试；
  6. HTTP start 的非法 window 400（与 POST 共用解析器，缺独立用例）；
  7. UI 双滑杆互推/旧宿主回退无 vitest（只有 CDP 手动）；
  8. 真实郊狼 BLE、以及 v12 在真实进程/真实模型下的整局（audit 仍是 v10/v11 构建；ui-v12 的“真实模型冒烟”没有可复核产物）；
  9. target fallback 的新行为（12:48 追加）是 diff 的一部分但不在 Lead 摘要里——见 P2-14。

---

## 3. 问题清单

### P0

无。

### P1

无（若把“非 loop 波形必须保持作者时长”视作硬承诺，P2-1 可升级；见下）。

### P2

**P2-1｜sustain 在 merge 前抬 duration，导致同通道后置非 loop/level body 被污染成 60s**
- 位置：`packages/core/src/scenario/intents.ts:336-357`（sustain 在 resolveBeat 内、merge 前）+ `:240-317`（merge duration=max）。
- 复现（本机脚本）：`b1 = loop waveform duration 4` → 被抬 60；`b2 = level duration 5` 同通道 → 最终 `b2.body.durationSec = 60`
    （非 loop stinger 同理）。触发条件：模型违反一 beat/通道（真实审计曾出现 turn 9/13 同通道多 beat）。
- 影响：作者声明的短动作可能实际跑 60s（仍 ≤ maxDurationSec / cap，但语义错）；README/kit 写“非 loop 保持作者短时长”，
  而 merge 限制 #2 只泛泛承认“继承同通道最长 hold”，实际是非 loop 被 loop 污染。
- 建议：先 merge（用未 sustain 的 duration 算 max），再对**最终存活 body** 按 loop 规则应用 sustain；补“loop + level/stinger 同通道”测试。
- 若产品接受“同通道合并时 duration 继承最长 hold”作为已知语义，需在 README/kit/ui-v12 中明确“非 loop 只在无 loop 同通道合并时保持短”。

**P2-2｜target fallback 绕过 intent distribution（primary/round-robin 变成 synced）**
- 位置：`intents.ts:358-395`（unknown targets → 回退 region 展开）；`selectMatches`（`:449+`，早退在 `:455`）对 `beat.targets!==undefined`
  直接 `return matches`，不按 distribution 选择。
- 现象：模型猜错 `targets.deviceId`（新增 fallback 的实际动机）且 intent 是 `primary`/`round-robin` 时，回退得到的 region matches
  会**全部下发**（多个通道同时动），而不是按 primary 选一个/按 round-robin 轮转。现有测试只覆盖 plain/synced 用例（`scenario-resolve.spec.ts:525+`）。
- 复现（本机脚本）：primary/round-robin intent + 猜错的 `targets` + regions 命中两通道 → `commands=[a,b]`（本应 primary 选一 / round-robin 轮转），
  只多一条 “falling back to region matching”。建议：fallback 时用一个 `fellBackToRegions` 标志让 selectMatches 应用 distribution，补 primary/round-robin 测试。
- 安全：仍受 cap/LOCKED 约束，属行为正确性/可预期性问题。

**P2-3｜`pendingPacedSec`（nextTurnAfterSec）在关闭自动运行时不清空**
- 位置：`turn-engine.ts:307/1062/1105`；`setAutopilot(false)`（`:438-444`）只 cancel timer。
- 现象：某 plan 建议 60s → 用户关自动运行（不消费 pending）→ 若干回合后再开 → 第一拍使用陈旧 60s（被窗口 clamp），
  用户以为窗口随机/新设置生效，实际是旧建议。
- 建议：`setAutopilot(false)`/`end`/session reset 清 pending；或给 suggestion 带 turnId，隔回合作废；补测试。

**P2-4｜paused 时 `setAutopilotRange` 会 arm 空转 tick**
- 位置：`turn-engine.ts:374-397`（autopilotOn 即 schedule）、`:1118-1130`、`:1138-1151`（tick 无条件 reschedule）。
- 现象：paused 时改窗口（UI 允许）→ tick 定时器每拍 emit skipped 并重新 arm，形成空转（旧 setAutopilotInterval 也有，
  但新 API 同样）；resume 会替换，功能无碍。
- 建议：scheduleAutopilotTick/onAutopilotTick 在 paused 直接 return；补测试。

**P2-5｜窗口接受小数，UI step=1 与 API 快照可能不一致**
- 位置：`dashboard.ts:381-410`、`play.ts:2192+`、`turn-engine.ts:1105-1116`（round 后又 clamp 到浮点 low/high）。
- 现象：API `windowMinSec:10.5, windowMaxSec:30.5` → snapshot 可能 10.5/30.5；引擎 interval 可能 10.5 等；UI range `.value`
  按 step 取整，readout 显示传入值，可能出现滑块位置与读数不一致。UI 自身只发整数，正常路径无问题。
- 建议：窗口要求整数（400 或引擎 round），或 UI 用 step 0.5 + 显示一位小数。

**P2-6｜HTTP start 的非法 autopilot window 缺独立 400 用例**
- 位置：`dashboard.ts:1001`（start 路由）与 `:1196`（POST 路由）共用 `parseAutopilotBody`；`play.ts:557` 的 openSession
  也会 normalize（direct start 已一致）。
- 风险低（同一解析器），但建议补一条 HTTP start 的 `{windowMinSec:10}` / `min>max` → 400 用例，避免未来分叉。

**P2-7｜loop sustain 无条件（manual/内置 loop 资产）覆盖作者/模型的显式短时长**
- 位置：`play.ts:1094`（host 恒定传 60）、`intents.ts:336-357`。
- 现象：manual 局、内置 `呼吸/潮汐`（loop=true）、用户导入（默认 loop）都会从短 duration 变 60；`soothe` 15s、`ambient`
  等作者的短意图被覆盖；作者只有 `loop:false` 可选。属产品语义，需在 UI/规范中明示（当前 README/kit 已有说明，但 UI 无提示）。
- 建议：若想保留作者短 loop 的“一次性”，提供 per-intent/beat opt-out（如 `sustain:false`）或只在 autopilot on 时 sustain；
  至少文档明确“loop=true 即持续”。

**P2-8｜variable window 下 choice timeout 与 timer 竞争缺测试**
- 位置：`turn-engine.ts:1065-1067`（settle 先 schedule 后 maybeArm）、`:1322-1335`。
- 现状逻辑正确（timeout = 选项菜单打开时选中的下一拍 interval，含 suggestion），但没有 variable window 的测试；当 autopilot tick
  与 choice timer 同拍时，tick 会 skip+reschedule（resample intervalSec），choice timer 仍用旧值，语义未在测试中固定。
- 建议：补一条 variable window + choices 的 FakeClock 测试，断言 choice_timeout 发生在所选 interval（且不伪造 choice）。

**P2-9｜UI 行为缺自动化测试（CDP 手动）**
- 位置：`dashboard.spec.ts:1413` 只有静态断言；`t11-autopilot-cdp.mjs` 手动。
- 建议：把 `updateAutoWindow`/`autoWindowOf` 抽成纯函数（像 chart-math）并加 vitest；或加一条 jsdom 测试覆盖互推/旧宿主回退。

**P2-10｜文档与实现边界**
- README/`内容包规范.md`/kit 写“非 loop 保持作者短时长”，P2-1 的 merge 边界使其在“同通道 loop+非 loop 同回合”不成立；
  ui-v12 限制 #2 只泛泛写“继承同通道最长 hold”。建议文档与实现二选一：修 P2-1，或在文档明确该例外。
- `autopilotPacingLine` 在固定窗口仍说“不写则由引擎随机”（fixed window 实际不随机）；属于 prompt 文案小瑕疵（P3）。
- ui-v12 的“真实模型冒烟”无临时产物可复核（报告只有 UI CDP 有 artifact）；作为口述记录可以，不能当独立证据。

**P2-11｜target fallback 是 12:48 才追加的 diff，不在 Lead 摘要范围**
- 位置：`intents.ts:358-395`；测试 `scenario-resolve.spec.ts:525+`。行为本身合理（模型看不到 device id，猜错时回退 regions），
  但请确认这是本轮有意改动并同步进交付说明/ui-v12（ui-v12 §1 已提及）；同时补 P2-2 的 distribution 测试。

**P2-12｜（微）`nextTurnAfterSec` 在 manual 模式被 engine 存 pending**
- 同 P2-3；仅提示：manual 下模型按全局一 beat 协议可能写 nextTurnAfterSec，实际不会即时生效，后续开自动运行可能消费旧值。

**P2-13｜prompt 的 “用 nextTurnAfterSec 控制节奏” 在 manual 模式没有即时效果**
- 位置：`play.ts:175`（全局一 beat 行包含 nextTurnAfterSec）、`:1592-1601`（autopilot-only pacing 行）。
- manual 局没有 autopilot tick，模型写 nextTurnAfterSec 只会进 engine 的 pending，直到用户开自动运行才可能被消费；
  建议把这句限定在 AUTOPILOT_PROTOCOL，或明确“仅自动运行生效”。

---

## 4. 对“队列是否值得做”的判断

- **当前取舍（一 beat/通道提示 + merge 兜底，不做队列）可接受**：用户问题 1 的“同一部位一回合两次下发”已经被确定性地
  消除（每通道每回合最多一条 dispatch），且 prompt 降低了模型产生多 beat 的概率；代价是前序 beat 被丢弃（用户只看到最后意图），
  但这是从“不可控重复”到“最后意图胜出”的明确收敛，符合现有 `BeatPlan`（意图集合，不是时间序列）模型。
- **不建议现在做隐式队列**：需要给每个 beat 引入开始时间，与下一 plan、choice 超时、暂停/急停/preempt、probe 登记、
  transcript 定格、plan_resolved 审计冲突；下一 plan 通常会提前到达并取消剩余队列，收益低。估时/风险高于收益。
- **值得做的是显式时间轴**（下一轮/后续）：给 `BeatPlan` 增 `beats[].startMs`/`sequence` 或单独的 `sequence` 字段，
  执行器按时间驱动、可被下一回合/stop 原子取消；这样叙事与效果框才能表达“先轻后重再停”。在此之前，用
  `nextTurnAfterSec` 把连续动作拆到下一回合是更便宜且语义清晰的做法。

---

## 5. 交付判断

- **可交付（真机回归除外）**：P0=0、P1=0；core 728 / desktop 246 / tsc / build 全过；loop sustain、autopilot 区间、
  UI 双滑杆、nextTurnAfterSec 采纳均有实现 + 真断言（/CDP 产物）。
- **交付前必须做/说明**：
  1. 真机回归：真实郊狼 BLE 波形 + 本轮 v12 在真实进程跑一局（当前 audit 仍是 v10/v11 构建；真实模型冒烟无产物）。
  2. 建议下一批优先修 **P2-1（sustain×merge 的 duration 污染，小改 +1 测试）** 与 **P2-2（target fallback 的 distribution）**；
     其余 P2 可排后续，不阻断本次交付。
  3. 交付说明写清：loop=true 会持续到下一 plan/stop（≤maxDurationSec）；同回合同通道多 beat 合并为最后一条（duration=max）；
     manual 模式同样受 loop 语义影响；旧宿主回退为固定 interval。
- 结论：**可交付（真机回归除外）**；P2-1 若被产品视为“非 loop 必须保持作者时长”的硬承诺，则升级为需修（一处小改）后再交付。

> 12:57 后 P2-1/P2-2/P2-3/P2-4/P2-5/P2-12/P2-13 已修复并复核闭环，最终结论见 **§7.8**。

---

## 6. 复核记录

- 只读复核：初轮 `git diff`（HEAD 93d19e5 → 工作区，16 files +1067/−143）+ `analysis/ui-v12.md` 声明 + `.ui-shots/t11-autopilot/` CDP 产物
  + 本机 audit 最后一局；delta 后为 **+1301/−156**（§7）；未改源码，唯一写入本文件，未 commit。
- 独立门禁：初轮 core 52/728、desktop 18/246、两包 tsc 0、esbuild main/dev-server 0；delta 后 **735/246**（§7）。
- 复现：用 `node --experimental-transform-types` 直接调用 `resolvePlan` 验证 P2-1（loop 4s + level 5s 同通道 → 后者 duration 60）。

---

## 7. P2-1…P2-5 / P2-12 / P2-13 修复复核（delta，2026-11-03 12:57–13:05）

> Lead 已按 §3 修复 P2-1（sustain 移到 merge 后）、P2-2（target fallback 走 distribution）、P2-3（关自动清 pending）、
> P2-4（paused 不排 timer）、P2-5（窗口整数 round）与 P2-12/13（手动模式不广告 nextTurnAfterSec）。
> 只读复核增量；HEAD 未变、未 commit；diff 16 files **+1301/−156**，源码 mtime ≤12:56；ui-v12.md 12:57 已同步
> 735 tests 与限制 #2（sustain 在 merge 后）。独立门禁：**core 52/735、desktop 18/246、两包 tsc 0、
> esbuild main/dev-server 0、`node --check` play.js ok**（与 Lead 数字一致）。

### 7.1 P2-1（sustain 移到 merge 后）— ✅ 闭环

- 实现：`resolvePlan` 先 `mergeChannelCommands`，再对每个存活命令按 `channelSnapshotOf` 找到通道并
  `sustainLoopCommand`（`intents.ts:185/219-230/355-385`）；sustain 只作用于最终 body，merge 的 duration=max
  使用**未 sustain** 的时长，因此 loop 的长 hold 不再污染后置非 loop/level body。
- 行为复验（本机脚本）：同通道 loop 4s + level 5s → 最终 `{kind:'level',durationSec:5}`（修复前 60）；
  同通道两个 loop 4s+6s → 最终 loop body 60（存活 loop 仍 sustain）；level/stop、非 loop 仍不变。
- 测试：`scenario-resolve.spec.ts:947`（does not leak…）、`:974`（sustains a loop that survives the merge）真断言。
- 残余（P2，非本次引入）：merge 原有的“同通道多 beat 取非 stop 最大 duration”仍可能把**前一条本身就很长的非 loop 动作**
  时长带给后一条 body（v11 有意语义，文档已写）。sustain 不再是放大源。

### 7.2 P2-2（target fallback 走 distribution）— ✅ 闭环

- 实现：`collectMatches` 返回 `CollectedMatches{matches, fromTargets}`（`intents.ts:185-197/387-455`）：
  显式 targets 真的命中 device/channel 时 `fromTargets:true`；全部落空回退 regions 时为 `false`；
  `selectMatches(matches, fromTargets, …)`（`:482-490`）只在 `fromTargets===true` 时绕过 distribution。
- 行为复验：primary intent + 猜错 targets + regions 命中两通道 → 修复后 `commands=['a']`（修复前 `['a','b']`），
  仍保留 “falling back to region matching” warning；round-robin 同样回到窗口/ready 池语义。
- 测试：`scenario-resolve.spec.ts:547`（applies the intent distribution to the region fallback）真断言。
- 残余：无（“有效 target 但设备离线 → 不回退”的既有语义保留，测试仍覆盖）。

### 7.3 P2-3（关自动运行清 pending）— ✅ 闭环

- 实现：`setAutopilot(false)` 在 idempotent 检查前清 `pendingPacedSec`（`turn-engine.ts:437-450`）。
- 测试：`engine-autopilot.spec.ts:273`（drops a pending plan suggestion when autopilot is switched off）：
  manual turn 记下 30s suggestion → off→on 后窗口 0.5 采样为 20，而非陈旧 30。✅
- 残余：无；panic/end 也走 setAutopilot(false) 清 pending（同路径）。

### 7.4 P2-4（paused 不排 timer）— ✅ 闭环

- 实现：`scheduleAutopilotTick`（`:1130-1137`）与 `onAutopilotTick`（`:1155-1160`）都增加 `turnState==='paused'` 直接 return；
  `setAutopilotRange` 在 paused 时不会 arm tick；resume 重新 arm。
- 测试：`engine-autopilot.spec.ts:293`（does not arm autopilot timers while paused and recovers on resume）：
  pause 后 timer=0，paused 期间 setInterval/setRange 仍 0，resume 后 1。✅
- 残余：无。

### 7.5 P2-5（窗口整数 round）— ✅ 闭环

- 实现：构造 `intervalSec`、`setAutopilotRange` 的 window、`setAutopilotInterval`、`clampToWindow`
  全部 `Math.round`（`turn-engine.ts:332/377-411/1098-1116`）；`selectAutopilotInterval` 返回整数。
- 测试：`engine-autopilot.spec.ts:311`（rounds the autopilot window）：12.4/29.6→12/30、10.6/10.7→11/11、
  setAutopilotInterval(12.6)→13，真断言。✅
- 残余（P3）：若引擎配置的绝对 minSec/maxSec 本身是小数（测试/自定义 engineConfig），snapshot 的
  `minSec/maxSec` 仍可能是小数而 window 已整数；默认 host 配置都是整数，无产品影响。

### 7.6 P2-12 / P2-13（提示词）— ✅ 闭环

- 实现：全局 `TURN_PROTOCOL` 的 one-beat 行删去 “或用 nextTurnAfterSec 控制节奏”（`play.ts:175`）；
  `nextTurnAfterSec` 只出现在 `autopilotPacingLine`（`play.ts:1594-1601`，仅自动运行时加入）。
- 测试：`play.spec.ts:1369-1372/1450-1466`：auto 局 system prompt 含“自动运行节奏区间/可在 apply_plan.nextTurnAfterSec…”，
  manual 开局/后续回合 **不含** “nextTurnAfterSec” 与区间行，但仍含 one-beat/设备 id 约束。✅
- 残余（P2 文档）：`analysis/ui-v12.md:15` 仍引用旧提示词（“或用 nextTurnAfterSec 控制节奏”），
  `导演与写作上下文契约.md` v0.1.3 第 1 条也写着未限定的“用 nextTurnAfterSec 控制节奏”；实现已改为自动运行限定，
  建议提交前把这两处限定为“自动运行”。另 `autopilotPacingLine` 在固定窗口仍写“不写则由引擎随机”（固定窗口实际不随机），
  P3 文案。

### 7.7 新增/残余问题（delta 后）

- **无新 P0 / 新 P1。** 修复未触碰执行器/registry 安全路径；sustain 仍受 channel cap + registry 夹紧；target fallback 仍受
  distribution/caps；paused/ended/LOCKED 边界未被放宽。
- **P2-7**（保留）：host 无条件传 sustain=60，manual 局、内置 loop 资产、用户导入波形会被持续化；属产品语义，需在 UI/规范
  明示（ui-v12 已写；UI 无提示）。
- **P2-8**（保留）：variable window 下 choice timeout 与 autopilot tick 同拍竞争缺直接测试（逻辑仍一致）。
- **P2-9**（保留）：UI 双滑杆互推/旧宿主回退只有 CDP 手动脚本，无 vitest。
- **P2-10**（保留+新）：P2-1 已修但 README/kit/`内容包规范.md` 的“非 loop 保持作者短时长”现在成立；ui-v12 限制 #2 已同步
  merge 后语义；剩余是 ui-v12:15 与导演契约的 nextTurnAfterSec 提示词口径（见 7.6）。
- **P2-11**（保留）：真实模型 smoke 仍无可复核产物；真实郊狼 BLE 与 v12 真实进程整局仍待用户回归。
- **P2-6**（保留）：HTTP start 非法 window 缺独立 400 用例（共用解析器，风险低）。
- **门禁对照**：core 735（+7：P2 相关测试）/ desktop 246 / 两包 tsc 0 / build 0；与 Lead 一致。

### 7.8 更新后的最终结论

- **P0=0、P1=0；P2-1/P2-2/P2-3/P2-4/P2-5/P2-12/P2-13 全部闭环**（实现 + 真断言测试 + 本机行为复验）。
  delta 没有引入新的逻辑漏洞/安全回归/确定性回归（sustain 仍确定、distribution 确定、window 整数确定、pending 生命周期明确）。
- **最终：可交付（真机回归除外）。** 剩余 P2 为产品取舍/可观测性/测试自动化（P2-6…P2-11）与两处文档口径，不阻断。
  交付前仍建议：真实郊狼 BLE + v12 真实进程整局回归；提交前顺手把 ui-v12:15 / 导演契约的 nextTurnAfterSec 表述限定为
  “自动运行”，并把 `analysis/ui-v12.md` 的 smoke/测试数字与最终提交对齐（735/246）。
- 队列判断不变：当前不做隐式队列；若产品要同回合顺序动作，后续做显式 `BeatPlan` 时间轴（见 §4）。
