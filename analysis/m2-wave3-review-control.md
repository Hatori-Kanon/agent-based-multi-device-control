# M2 波次三控制路径审查（HEAD 043c62d）

- 审查对象：`043c62d`（B1-T10 `agent/loop.ts`、B1-T11 `engine/state-machine.ts`/`turn-engine.ts`、`agent/transport.ts` R7）。
- 只读：未改源码/测试/文档，未跑 git 写命令。**审查期间 HEAD 已推进**（`f3aea94` → `6ef15ee` → `917a5bb`，波次四）；本报告的行号与结论均针对 `043c62d`，用 `git archive 043c62d` 副本核对。`M2-实施计划.md` §8.9 已登记波次四修复 B-1/B-2/B-3 并加回归（`engine-turn.spec.ts` 的 “P0 wins over the settle tail” 3 条）；但 `agent/loop.ts` 在 917a5bb 未改动，**B-4 仍成立**，其余 S 项需按新 HEAD 复核。
- 基线：`043c62d` 快照 core 39 files / **509 tests** 全绿（23:59 复跑）。绿≠覆盖：下述阻塞均用一次性探针复现（`node --experimental-transform-types` 直驱 `TurnEngine`/`runTurn` + `FakeClock`，未在仓库留文件）。
- 结论先行：**不放行**；R7 修复本身正确，B1-T10/T11 的 P0 latch、生命周期竞态与“总超时”不成立。

## 阻塞

### B-1 P0 闩锁被静默解除：`panic` 落在 `settling` 会从 `locked` 自动回 `idle`

- **证据**：`setState('settling')` 前已清 `active`（`packages/core/src/engine/turn-engine.ts:487`）；随后 `await hooks.onSettle`（`:490-495`）。此时 `panic()` 把状态置 `locked`（`:299-305`）。`onSettle` resolve 后收尾只判 `isTerminalState()`（`:496`，只认 `ended`，`state-machine.ts:108-110`），继续 `setState('idle')`（`:504`），而 `locked -> idle` 在 ALLOWED（`state-machine.ts:89`）。探针实测状态序列 `planning>settling>locked>locked>idle`，随后新的 P1 直接开新回合（`submitPlayerInput` 只拦 `locked`/`ended`，`:363-368`，此时状态已被改成 `idle`）。
- **影响**：P0 急停的引擎级 latch 不成立，UI/宿主以 `engine.state` 判断急停态会显示 idle。设备层 `registry.locked` 仍是最后一道闸（B1-T7），所以不是立刻可输出；但 B2-T7 一接异步 `onSettle` 即现网可复现，且模型可在“未人类解锁”下启动新回合与审计。
- **建议**：收尾前加 `if (this.turnState !== 'settling') return`；`panic` 设独立持久 latch，只有 `unlock()` 能清；补 `panic during async onSettle` 回归。

### B-2 合法并发命令撞非法转换 → unhandledRejection/进程退出、消息丢失

- **证据**：`submit()` 不拦 `paused`（`refusesNewTurns` 不含 paused，`state-machine.ts:113-115`），`active===undefined` 时 `void this.start(...)`（`turn-engine.ts:242-252`）；`execute` 随后 `setState('planning')`（`:432`），`paused -> planning` 非法（`state-machine.ts:103-105`），`void` 无 catch → Node 默认 unhandledRejection 策略退出。实测 `await pause()` 后 `submit({priority:'session',kind:'checkpoint'})` → **exit 1**，栈 `TurnEngine.execute (turn-engine.ts:432) ← submit (:252)`；全仓无 `unhandledRejection` 处理器。同源：`submitPlayerInput` 不查 `refusesNewTurns`，`ending` 中 P1 → `illegal turn transition ending -> planning` 拒绝（`:363-368,397`）；pause 等当前回合时 P1 进来 → 旧回合在 settle 分支进 `paused`（`:497-503`），新 P1 再 `paused -> planning` 拒绝（实测 msg ERR）；settling 中 P1 则直接起第二个回合（`busy` 只看 `active`，`:206-208`）。
- **影响**：主进程可崩；玩家消息丢失；pause/end/P1 竞争无明确终态，只是抛错。
- **建议**：所有外部命令（submit/P1/end/pause/unlock）走一个串行命令队列；`submit`/`submitPlayerInput` 统一用 `refusesNewTurns` 并显式处理 `paused`/`ending`；`void this.start` 一律 `.catch` → `emit('error')`；用户竞态不得用 `assertTransition` throw 表达。补四组回归。

### B-3 `panic` 落在在途回合/`ending`：非法转换、P0 审计记成 fallback、end 拒绝

- **证据**：在途回合 panic 后 `execute` catch 中 `preempted/timedOut` 均 false → outcome `fallback`（`turn-engine.ts:461-469`），写 `plan_fallback`（`:470-480`），随后 `:490` `locked -> settling` 非法 → `submitPlayerMessage` 拒绝；实测审计只有 `plan_fallback:error`。`end()` 在 `ending` 等 `onEnd` 时 panic → `locked`（`:303`，`ending->locked` 合法）→ `:329` `locked -> ended` 非法 → end 拒绝。
- **影响**：急停被审计成“模型降级”；急停时消息/结束调用返回 rejection（宿主 500 或未处理）；P0 台账失真。
- **建议**：panic 设独立标志，`execute` catch 先判 panic → outcome `cancelled`；收尾/结束前判 latch 并允许放弃该回合；补 in-flight/ending panic 用例。

### B-4 “一个 60s 总超时”不成立：dispatch 等待与非协作 runner 不受约束

- **证据**：loop 只有一个 controller/timer（`loop.ts:147-152`），timer 只 `abort()`；模型返回后 `await pendingDispatch`（`:273`）前只查过 `timedOut`/caller abort（`:268-269`），await 期间不再查、也不 race。实测：dispatch 挂起 → `advance(60_000)` 后仍 pending；dispatch 迟到 resolve → `runTurn` **成功返回**（`dispatch=yes`）；caller abort 在 dispatch 等待中 → 同样成功返回。runner 不响应 abort 时 engine 永卡 `planning`（`turn-engine.ts:426-430` 只 abort，execute 仍 await），实测 60s 后 state=planning、迟到 resolve 后 outcome=`completed`。
- **影响**：总超时只覆盖模型请求阶段。`PlanExecutor.dispatch` 会 `await` 后端写（`execution/executor.ts:139-212`，`registry.write` 直接 `await backend.applyLevel`），后端挂起时回合不可超时/不可抢占：P1 的 `await running`（`:385`）、`end()`（`:319`）、`pause()` 全部无限等。
- **建议**：`Promise.race([pendingDispatch, abortPromise])`，await 后再查 `timedOut`/callerSignal；engine 的 timer 直接 reject（或 race runner）而非只 abort；补“非协作 runner”“挂起 dispatch”用例。若认定 executor 必有界，也须先修“超时/abort 后成功返回”。

## 应修

### S-1 抢占/生命周期审计与 §4.11 不符，且动作先于 abort

- **证据**：`turn-engine.ts:374-379` 用 actor=`human`、`action=writing?writer_preempted:preempted`、`detail={turnId,stage}`；§4.11 要求 actor=`system`、`preempted` detail `{turnId,from,remainingBeats}`、`writer_preempted` `{turnId}`（`M2-实施计划.md:1485-1486`）。设计草案明确“统一 `preempted` + `detail.reason`，不再使用 `writer_preempted`”（`回合引擎与调度-设计草案.md:73,143-145`），与 M2 §4.8 `:1188` 自身冲突。locked 拒绝复用 `preempted/rejected`（`:365`），§4.11 无此组合；`session_paused/resumed`（`:279,293`）、`plan_fallback`（`:473-479`）缺 §4.11 的 detail 键（sessionId/turnId、attempts/beats）。审计在 `abort()` 前 `await`（`:374-381`）；`AuditLog.record` 不会 reject（`packages/core/src/devices/audit.ts:41-68`），但 P1 取消被延迟一个 append。
- **影响**：B2-T13 回放按 action/actor 过滤会漏/错；急停/抢占取证不可信。
- **建议**：Lead 先裁定 `writer_preempted` 去留，再统一 actor/detail；先 abort 再写审计；补 §4.11 字段断言。

### S-2 `executing` 的 500ms 宽限与“取消剩余 beat”未实现

- **证据**：`preemptGraceMs` 仅出现在接口/默认值（`turn-engine.ts:80,96`），全仓无读取；`executing` 与 `planning/writing` 同一路（`:371-385`），只 abort 模型 controller；`TurnExecutor.dispatch(plan,ctx,diag)` 无 signal（`loop.ts:194-201`，`execution/executor.ts:139-146`），执行器继续走完 `resolved.commands`。已派发效果不回滚成立（无回滚路径）。
- **影响**：executing 中抢占后“当前 beat 完成、剩余取消、≤500ms”三条均不成立，剩余 beat 照发；死配置让宿主误以为可调。
- **建议**：归 B2-T4 实现 grace + executor 取消信号，或在本输出明确登记未实现并先删该字段；补 executing 抢占用例。

### S-3 `onStage` 非单调（文本先于 tool call）会整回合降级

- **证据**：`turn-engine.ts:444-448` 直接 `setState(stage)`，ALLOWED 不允许 `writing -> executing`（`state-machine.ts:86`）。单调用文本可先于 tool call（`transport.ts:428-443` 先读 content 再读 tool_calls；`tests/agent-loop.spec.ts:104-106` 正是该顺序）。实测 `onStage('writing')` 后 `onStage('executing')` → runner 抛错 → outcome `fallback`、`lastLine` 变模板句、写 `plan_fallback`。
- **影响**：B1-T16 按“executor→executing / onTextDelta→writing”接线后，模型先寒暄再调工具的常见输出会整回合降级并丢台词。
- **建议**：onStage 单调化（已到 writing 时 executing 只记标志），或允许 `writing -> executing`；补乱序阶段用例。

### S-4 状态可永久卡住；`dispose()` 名不符实

- **证据**：`onSettle` 无 2s 超时，永不 resolve 即卡 `settling`（`:490-495`）；`onPause` 在 execute 的 paused 分支抛错时已进 paused，但 `pauseRequested` 仍为 true、审计不写（`:497-503`）；`dispose()` 注释称取消定时器（`:333`），实际只 `abort`（`:334-338`）；挂起 runner 实测 dispose 后 `pendingCount=1`、state=planning。`whenIdle()`（`:284-286`）同样永不返回。
- **影响**：会话无法结束/再开始；dispose 调用后仍有定时器。
- **建议**：hook 加 catch + 超时；dispose 保存并 cancel 当前 timer、结束 currentRun；补 hook hang/throw 与 dispose 用例。

### S-5 `settling` 期间调度规则失效；并发 P1 互相覆盖

- **证据**：`busy` 只认 `active`（`:206-208`，settling 前 `active` 已清 `:487`），`submit()` 见 `active===undefined` 直接 start（`:242,252`）→ settling 中 P2/P3 不排队/不丢弃而是**立刻开新回合**（实测 states `planning>settling>planning>settling`）。两次并发 `submitPlayerMessage` 都 `await running` 后各自 `start`：实测回合 2、3 并发启动，回合 2 后被 `:450` 的 `active.turnId` 检查丢弃，无 outcome/审计，但调用方仍收到 ok。pause 等待中 P1 被 paused 分支吞掉并转成拒绝（见 B-2）。
- **影响**：回合互斥破坏；玩家消息静默丢失；settle 与 drainQueue 交错。
- **建议**：busy 改为 `active != null || turnState ∈ {planning,executing,writing,settling}`；P1 走同一串行队列；settling 中 P2 入队、P3 丢弃；补 settling/paused + 并发 P1 测试。

### S-6 `submit()` 会把 P1 当 P3 丢弃；生命周期闸门不一致

- **证据**：`queuesWhenBusy(priority) && priority !== 'player'`（`turn-engine.ts:243`）——`submit({priority:'player'})` 在忙时落入 dropped（`:247-249`）；paused 不在 `refusesNewTurns`；settling 直接 start。B1-T11 约定 `TurnEngine{state,start,submitPlayerMessage,stop,panic,snapshot()}`（`M2-实施计划.md:203`）但没有 `stop()`；`locked` 下 `end()` 可用（`:316-326`），与 §4.8“仅 stop/unlock/panic”（`:1165`）冲突。
- **影响**：P1 触发走错入口会丢消息；LOCKED 的可用动作集合与契约/UI 不一致。
- **建议**：`submit` 对 player/choice 转 `submitPlayerInput`；统一 paused/settling/ending 规则；补 `stop()`（或改契约）并明确 end-from-locked。

### S-7 loop 丢弃 `result.text`（非流式 runner 得到空台词）

- **证据**：只累计 `onTextDelta`（`loop.ts:223-227,278`），从不回填 `result.text`。探针：runner 返回 `text:'他说了一句话。'` 且不调 `onTextDelta` → `result.line===''`，而 `TurnResult.line` 注释称“empty when the model produced no text”（`:118`）。
- **影响**：合法的非流式 `ModelRunner`（B2-T3 pipeline/宿主自建）静默丢台词；重试清空 `lineParts`（`:265`）后第二 attempt 不流式则同样丢。
- **建议**：`lineParts.length === 0 ? result.text : lineParts.join('')`，并测试不重复拼接。

## 建议

- **N-1** `unlock()`（`turn-engine.ts:308-313`）不写审计、不调 registry 解锁 hook；`panic` 只靠 onPanic，engine 自身不记 panic/latch 变化。建议补 hook + 审计，避免 engine 显示 idle 而设备仍 locked。
- **N-2** `TurnOutcome` 的 `cancelled`/`blocked` 全仓从未产生（`state-machine.ts:28` 仅定义）；`plan_fallback` 未区分“无 plan/全非法/超时”。建议 B2 补齐或删词表。
- **N-3** 测试名/语义：`tests/agent-loop.spec.ts:139` 名为 reject 实为 ignore+warn；`:250` 只断言常量 `60_000`。建议改名并断言 warnings 内容。
- **N-4** 传输重试无退避（`loop.ts:255-265` 立即重试），设计 §6 要求 `retryBackoffMs`（默认 1000）。建议用注入 Clock 退避或登记偏差。
- **N-5** 尚无生产 `TurnRunner` 把 `runTurn` 接进 `TurnEngine`（本提交无 `play.ts`），所以“派发早于文本/onStage”只有分段测试、无端到端；B1-T16 接线前补集成用例。
- **N-6** `end()` 的 `locked` 分支与 else 完全相同（`:321-326`）是死分支；`pause()` 在 locked 静默返回不写审计。建议清理/明确。
- **N-7（R7 复核，无问题）**：EOF 尾路径新增 `isDoneSentinel` 判断（`packages/core/src/agent/transport.ts:266-276`），与逐行派发路径（`:254,262`）一致；`agent-openai-adapter.spec.ts:393-411` 覆盖“无尾随空行的 `[DONE]`”并会杀死旧实现（旧实现把 sentinel 喂给 accumulator 会抛 `invalid-response`）。未发现遗漏。

## 必答问题速答（Q1–Q7）

- **Q1 单控制器/单超时**：loop 内确为唯一 controller + 唯一 `clock.timeout(60_000)`（`loop.ts:147-152`），retry 复用同一 `request`/signal（`:229,240-243`）；`finally` 取消 timer 并移除 caller 监听（`:285-288`）。但 timer 只 abort 不是硬超时（B-4）；`FakeClock` 在超时路径的 `pendingCount=0` 是空心断言（见「测试杀伤力」）。注：真实适配器每次请求还会在 `transport.ts:86-89` 自建 controller/timer，`agent-loop.spec.ts:222-265` 用 stub runner，未覆盖真实栈。
- **Q2 派发早于文本**：由代码保证——`onToolCall` 内 `applyPlan` 同步启动 `pendingDispatch`（`loop.ts:180-201`），adapter 在参数 parse 成功时立即回调（`transport.ts:461-469`）；`tests/agent-loop.spec.ts:99-137` 断言 `text:before-tool → dispatch → text:after-tool-call`。第二次 `apply_plan`/`look` 一律忽略 + warn，不抛（`:181-184,212-217`；测试 `:139-191`）。已派发后 retry 被 `pendingDispatch === undefined && !applied` 关闸（`:255-258`；测试 `:399-419`），不会重复驱动。
- **Q3 状态机**：9 态完整、outcome 分离、非法转换 throw（`state-machine.ts:16-25,28,81-105`）。settling 正常/`onSettle` 抛错回 idle；但 `onSettle` 挂起永卡（S-4）、panic during settling 被改回 idle（B-1）、settling 中可并发新回合（S-5）；runner 不响应 abort 永卡 planning/超时后仍 completed（B-4）；writing→executing 乱序整回合 fallback（S-3）。
- **Q4 抢占/审计**：planning/writing 取消模型请求/文本流；executing 也只 abort 同一个模型 controller——执行器已拿到整份 plan 且无 signal，故剩余 beat 不取消，`executing` 的 500ms **未实现**（仅 config）（`:371-385`；S-2）；已派发效果不回滚成立。action 按 stage 选 `preempted`/`writer_preempted`，但 actor/detail 与 §4.11 不符、与草案 §3 冲突（S-1）。
- **Q5 P0/P2/P3**：panic 清队列/abort/进 locked 基本成立（`:299-305`），但不取消 executor、在途/ending 有 B-3。locked 下 submit/消息拒绝、end 可用、无 `stop()`（S-6）。P3 忙丢、P2 排队仅在 `active` 期间成立，settling/paused 失效（B-2/S-5）。`drainQueue` 单线程无重入问题（`:510-516`），但 `void start` 的 rejection 未接（B-2）。
- **Q6 竞态/dispose**：并发 P1 双回合、一回合结果静默丢（S-5）；pause/end 与 P1 撞非法转换（B-2）；panic 与 end 交叉使 end 拒绝（B-3）；dispose 对 submit 类安全，但 resume/unlock/end/panic 仍可动、timer 不取消（S-4）。
- **Q7 见下。**

## 测试杀伤力（Q7）

**永真/空心断言**
- `tests/agent-loop.spec.ts:250` 只断言常量 `60_000`；`:214-215` 无 plan 时 `dropped=[]`/`dispatch=undefined` 结构必然；`:134` 断言 stub 自己返回的 `blocked=false`；`:260` 与 `tests/engine-turn.spec.ts:79` 的 `pendingCount=0` 发生在 FakeClock 已把 fired one-shot 自动 cancelled 之后（`packages/core/src/ports/fake-clock.ts:55,60`）——删 `timer.cancel()` 仍绿；`engine-turn.spec.ts:139` resume 不调 onPause 是显然的；`:174-175` 只验终态早退；`:158-163` 只数 resolver，不验第二个触发是 P2；`:118` 只验 action 存在，不验 actor/detail/stage。`engine-turn.spec.ts:121-140` 名为“pauses after the current turn settles”，但 `submitPlayerMessage` 已 await 完才 pause，等待分支从未执行。

**变异结果（HEAD 快照）**

| 变异 | 会红 | 不会红 / 空白 |
|---|---|---|
| 删 loop `timer.cancel`（`loop.ts:286`） | `narrative-only`（`agent-loop.spec.ts:219`） | `:260` 超时、retry、其余全绿；caller-abort 中途、dispatch 挂起空白 |
| 删 engine `timeout.cancel`（`turn-engine.ts:483`） | `walks...`（`engine-turn.spec.ts:65`） | `:79` 超时及全部其余绿；preempt/panic/pause/end/dispose 空白 |
| 抢占不 abort（删 `turn-engine.ts:381`） | `preempts...`（`engine-turn.spec.ts:95-119` 挂起→超时） | 其余全绿；writing/executing 阶段、审计 detail、grace 全空白 |
| 删 `setState('idle')`（`:504`） | `walks`、fallback、preempt、P3/P2（`:60-61,77,116,163`） | `locked`（`:82`）、`pauses`（`:121`，resume 直接 idle）、`end`（`:166`）绿；pauseRequested 分支空白 |
| P3 改成排队 | `P3/P2`（`:142-164` 大概率因多回合/挂起红） | 其余绿；无断言“谁被排队”，把 P2 丢、P3 排队仍可能绿 |
| 每次 retry 新建 controller | **无** | `uses exactly one...` 不重试、retry 用例不数 controller/signal——单控制器无真正测试 |

**主要空白**：非协作 runner 超时（只 abort）、挂起 dispatch、caller abort 在途、`timeout.cancel` 的超时/abort 分支、executing/writing 抢占差异与 500ms、panic 在途/settling/ending、pause 在途、paused/ending 下的 P1/P2、settling 期间触发、并发 P1、settle hook 抛/挂、乱序 onStage、dispose、locked 下 `submit()`、`result.text` 无 delta。

## 是否可放行

**对 043c62d 不放行。** B-1（P0 latch 自解除）、B-2（合法触发致 unhandledRejection/进程退出、消息丢失）、B-3（panic 在途/ending 的非法转换与错误审计）必须在 B1-T11 出口前修——§8.9 记录波次四已修这三项并加了 3 条回归，需按 `917a5bb` 复核；B-4（“总超时”不覆盖 dispatch，超时/abort 后可报成功）在 `917a5bb` 的 `loop.ts` 仍原样存在，对应 B1-T10 的“一个总超时”出口条件，属于**当前仍应修**的阻塞。R7 修复（`packages/core/src/agent/transport.ts:266-276`，测试 `tests/agent-openai-adapter.spec.ts:393-411`）本身正确，不构成阻塞。S-1..S-7 可随修或按 §8.7/§8.9 明确登记偏差（其中 S-2 的 grace 已在波次四接线，见 `917a5bb` 的 `packages/core/src/engine/turn-engine.ts:468`）；修后补齐上列空白用例，再以 HEAD 快照全绿为基线复验。
