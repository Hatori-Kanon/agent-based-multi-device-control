# M2 波次四独立审查（目标提交 `6ef15ee`）

- 审查对象：`git log --oneline -3` 为 `917a5bb`（仅文档）→ **`6ef15ee`（波次四）** → `f3aea94`；`917a5bb` 只改 `M2-实施计划.md`。
- 只读审查；未改源码/测试/文档，未跑 git 写命令。**审查期间工作区有并行未提交改动**：`packages/core/src/engine/turn-engine.ts` 被另一子代理改到 1000+ 行（B2-T5/T6，且当前构造函数引用了尚不存在的方法），`loop.ts`、`director.ts`、`probe*.ts`、`play.ts`、`dashboard.ts`、UI/tests 也有未提交修复。故本报告一律以 `git show 6ef15ee:<file>` 或 `git archive 6ef15ee` 快照为准，不把工作区修复计入结论。
- 验证方式：审查开始时（00:01）按给定命令跑过 `packages/core` **579 passed**；随后树被并行改动，未再复跑 desktop。P0/竞态结论用 `node --experimental-transform-types` 直驱 `git archive 6ef15ee` 的 `TurnEngine`/`runTurn` + `FakeClock` 复现（一次性探针，未在仓库留文件）。
- 结论先行：**settle 尾段解锁已修复**；但 P1 并发双回合、总超时不覆盖 dispatch、executing 抢占不生效、panic 被干净 resolve 记成 completed，仍是阻塞。**不放行**。

## 阻塞

### B-1 两个并发 P1 会同时跑两个回合，回合互斥被破坏

- 证据：`turn-engine.ts:449-462` 中两个 `submitPlayerInput` 都 `await running`；第二个进入时 `active.preempted` 已为 true，于是跳过 `preempt`，等旧回合结束后各自直接 `await this.start(trigger)`。探针：旧回合挂起时连发两条 P1，释放旧回合后出现 **requests=3、maxActive=2**（`turn2` 与 `turn3` 同时运行）；`execute` 的 `active.turnId` 守卫（`:576,621`）只会丢弃其中一个的结果，调用方仍收到成功。
- 影响：同一时刻两个模型/执行器回合，设备命令、`turn_started`/`turn_completed` 审计与 `active` 互相覆盖；一个回合的结果静默丢失。违反 §4.8 “同一时刻只有一个模型回合”与 B2-T4 的回合互斥。
- 建议：P1 也进串行命令队列；`await running` 后必须重新检查 `currentRun`/`turnState`，若已有新回合则让后到的 P1 抢占它，或合并为最后一次输入。补“旧回合忙 + 两条 P1”回归，断言 `maxActive===1` 且每条输入有明确 outcome。

### B-2 `runTurn` 的总超时不覆盖 dispatch，超时后仍可成功返回（波次三 B-4 未闭合）

- 证据：`agent/loop.ts:268-273` 只在 `await pendingDispatch` **之前**检查 `timedOut`/caller abort；`play.ts:406-420` 把 engine 的 `signal`/`timeoutMs` 交给 `runTurn`，但 `TurnExecutor.dispatch` 无 signal（`loop.ts:94-95`、`execution/executor.ts:139-180` 顺序派发全部 command）。探针：`apply_plan` 后 dispatch 挂起，`advance(60_000)` 仍 pending；释放后 `runTurn` **resolved 成功**（`line` 与 `dispatch` 都有）。engine 自己的 60s 定时器（`turn-engine.ts:542-546`）只 abort controller，拿不到这个成功结果，会按 `completed` 记。
- 影响：单回合可无限期越过 `turnTimeoutMs`；超时/panic/P1 之后仍可能继续派发剩余 beat，且 engine 记成功；`end()`/`pause()`/P1 的 `await running` 可被后端挂起拖死。这是 B1-T10/T11 的出口条件，非新功能。
- 建议：`Promise.race([pendingDispatch, abortPromise])`，`await` 后再查 `timedOut`/callerSignal；把 abort 传进 executor 的逐 command 循环（每 beat 前检查）；engine 对 `timedOut` 后的 runner 成功结果强制 `timeout`/`cancelled`，不回填 `lastLine`。补“dispatch 挂起 60s”和“超时后迟到 resolve”用例。

### B-3 `preemptSignal`/500ms 宽限在引擎里是真定时器，但生产运行器没有接

- 证据：engine 在 `turn-engine.ts:566` 把 `preemptSignal` 放进 `TurnRequest`，`preempt()`（`:466-492`）在 executing 用 `clock.timeout(500)` 作硬 abort；但 `play.ts:406-420` 只传 `signal`（`runTurn` 的 `TurnLoopOptions` 也没有 `preemptSignal`），`runTurn`/`PlanExecutor` 不监听它。`TurnExecutor.dispatch(plan,ctx,diag)` 无 signal，`executor.ts:176-180` 会派发整份 plan。测试 `engine-scheduler.spec.ts:171-205` 的“one beat finish”用的是会监听 `request.preemptSignal` 的假 runner，不能证明生产链路。
- 影响：P1 落在 `executing` 时，500ms 定时器最多 abort 模型 controller；已拿到 plan 的 executor 继续派发全部剩余 beat，实际不满足 §4.8 “当前 beat ≤500ms、剩余 beat 取消”。同时 `play.ts:430-434` 在 runner 干净返回时把旧回合 partial line 推进 `recentLines`，下一写作回合仍会看到被抢占的台词（engine 的 `active.preempted` 只抑制 `lastLine`）。
- 建议：把 `preemptSignal`/取消 token 传进 `runTurn`→`TurnExecutor`，每 command 前检查；`play.ts` 在 `request.preemptSignal.aborted` 时不推 `recentLines`；补生产 `runTurn` + `PlanExecutor` 的 executing 抢占集成测试，断言剩余 beat 未派发、旧 line 不入下一回合。

### B-4 panic 被“干净 resolve”的 runner 记成 completed，并回填台词（P0 #2 只闭合了 reject 路径）

- 证据：`turn-engine.ts:576-590` 的成功分支只判断 `active.preempted`，不判断 `this.panicked`；`panicked` 仅在 catch（`:593`）生效。探针：runner 在 abort 后忽略 signal、返回 `{line:'panic 后的台词'}`；`await panic()` 后 state=locked，但 `snapshot().lastLine` 被设为该台词、`outcome=completed`，审计只有 `turn_started`（无 `plan_fallback`，符合 #2 的一半，但不是 cancelled）。
- 影响：急停后 UI/会话仍可能显示“panic 后的台词”，engine outcome 与 P0 语义相反；若 runner 在 panic 后继续 dispatch，设备层虽由 `registry.locked` 拦截，但 engine 状态/审计已失真。§8.9 声称“中断回合 outcome 记 cancelled”并不总成立。
- 建议：成功分支先判 `this.panicked`/`active.panicked`，置 `cancelled`，跳过 `lastLine`/choices 与失败计数；panic 应作为该回合的终态事件审计。补“abort 后仍 resolve 的 runner”回归，断言 `cancelled`、无台词、无 completed。

### B-5 `PlayHost`/`PlaySession` 的并发 `start` 不是“一进程一会话”

- 证据：`play.ts:496-523` 先查 `this.session===undefined`，再 `await this.loadPack()`，最后才 `this.session=session`；两个并发 start 都能通过检查，各自建 session、各自起 opening turn，后完成者覆盖前者。`PlaySession.start`（`:230-282`）同理：`this.started` 检查在开头，`ceiling`/`savePolicy`/`PhaseMachine`/`TurnEngine` 都在 await 或构造之后才 `started=true`，并发调用可创建两个 engine。
- 影响：违反 B1-T16 的“一进程一会话”，两份模型请求/设备命令可能并行；`PlayHost` 只保留最后一个 session，前一个 engine 与定时器泄漏，`dispose` 只能清最后一个。工作区已有未提交的 `starting` 修复（只覆盖 PlayHost），但提交 6ef15ee 没有。
- 建议：`PlayHost` 用 `starting`/互斥锁覆盖整个 load+start；`PlaySession.start` 也加同步 latch（或只允许 Host 创建）；补 `Promise.all([host.start(),host.start()])` 与直接 `PlaySession` 并发用例。

## 应修

### S-1 写作上下文的“零数字/零设备 id”只对 plan/probe 派生字段成立，透传字段未净化

- 证据：`writer.ts:251-263` 原样透传 `persona/host/scene/recentLines/corpusExcerpts`，`mustMention[].beatId`（`:51-55`）也留在返回对象里；`normalizeProbeBrief`（`:424-428`）只按数字丢弃，不拒绝设备 id。探针：persona=`第2章…coyote-1…50%`、recent line=`toy-secret 调到 30%`、beat id=`b12` 时，`JSON.stringify(buildWriterContext(...))` 同时含数字、`coyote-1`、`toy-secret` 和 `b12`；只有 `planText` 干净。测试 `agent-context-writer.spec.ts:119-136` 的“无数字”只用了干净 fixture，杀不掉这个输入。
- 影响：若验收按“写作上下文所有字段零数字/零设备 id”字面执行，B2-T2 不成立；内容包或历史台词可以把 `%`/设备 id 带进 writer 上下文。若契约只要求 plan/probe 投影干净，应明确写死这个边界。
- 建议：对透传 prose 至少做数字/设备 id 告警或净化，明确 `beatId` 不渲染给 writer（或从返回对象移除）；补“persona/recentLine 含数字与设备 id”用例。**若按任务字面验收，本条升级为阻塞。**

### S-2 导演提示词块仍出现 `magnitude` 档位，和“ProbeDirectorEntry 不进任何提示词”的字面裁定冲突

- 证据：`sensors/projection.ts:203-218` 的 `renderProbeBlock` 调用 `probeDirectorJson(records)` 后把 `MAGNITUDE_TEXT[entry.magnitude]` 写进 `探测：…（升·中）`；`probeDirectorJson`（`probe-projection.ts:74-87`）正是含 `delta`/`magnitude`/`reason` 的结构化适配面。`delta`/`reason` 确未进提示词，但 `magnitude` 的文本档位进了 `probePromptBlock({for:'director'})`；测试 `sensors-projection.spec.ts:226-232` 还把 `中` 写成期望。
- 影响：§8.9 第 1 条若按字面解释（该结构体不进任何提示词），这是契约违反；若“不带数字”只指原始数值，则只是文档/命名歧义，但两种投影的边界没有被测试锁住。
- 建议：Lead 明确“档位是否允许进导演提示词”；若不允许，改用 `director.ts` 的 `DirectorProbeEntry`（目前只有 direction，不含 magnitude）或删掉 `（升·中）` 的档位；补“把 delta/magnitude 注入 director block 必红”的测试，并对所有 audience 断言不带原始数字。

### S-3 抢占/回合审计的 detail 不符合 §4.11

- 证据：`turn-engine.ts:482-492` 的 `preempted` detail 是 `{turnId,from,reason,graceMs}`，§4.11（`M2-实施计划.md:1485`）要求 `{turnId,from,remainingBeats}`；`:639-643` 的 `turn_completed` 是 `{turnId,outcome,durationMs}`，要求还含 `roundTrips`。测试 `engine-scheduler.spec.ts` 的 executing 抢占用例只断言 `from/reason/graceMs`，没有 `remainingBeats`/`roundTrips` 断言。
- 影响：B2-T13 的审计回放按 §4.11 字段解析会缺键；和波次三 S-1 的 action/actor 修正一起看，抢占审计仍不是完整契约。
- 建议：补齐 `remainingBeats`（engine 至少可写 0/未知，或由 B2-T3 提供）与 `roundTrips`；测试改断言 §4.11 键集，禁止只断言宽松子集。

### S-4 ceiling 的“人类路径”是调用点约定，不是结构约束；落盘失败时审计先说成功

- 证据：全仓 grep 只有 `play.ts:244` 调 `setSessionCeilingByHuman`，engine/executor/内容包没有调用点；这是好消息。但 `PolicyStore` 的方法公开，`restore()`（`policy.ts:234-255`）也能从 `state/policy.json` 恢复任意 0–100；`play.ts:244-251` 先写 `policy_change` 审计、再 `await savePolicy()`，save 失败时 start 抛错但内存 ceiling 已改、审计已记 ok。提交没有计划中承诺的 `it('never raises a cap from a plan, a pack or the engine')`。
- 影响：D4 只靠“当前没有调用点”成立，未来注入的 engine/pack 代码可调用公开 setter；磁盘失败时出现“审计成功、未落盘”的状态。不是已发现的可利用 raise 路径，但边界没有测试锁住。
- 建议：把 non-human setter 收窄（private/能力 token），`restore` 保持一次性；先 persist 成功再记 policy_change（或失败记 error）；补 plan/pack/engine 高值被夹紧的端到端测试与 save 失败用例。

### S-5 `PlaySession.message` 在 `ending` 期间返回 200（消息被引擎静默丢弃）

- 证据：`play.ts:312-327` 只拒绝 `ended`/`locked`/空文本；`engine.submitPlayerInput` 在 `ending` 只 `emit('error')` 并 return（`turn-engine.ts:429-432`），`PlaySession` 随后 `requireSnapshot()` 返回 `ending` 快照。HTTP 调用方看到 200，实际没有新回合。
- 影响：结束/收束窗口内的玩家输入被静默吞掉，和 B1-T16 “拒绝条件必须可被调用方看见”不一致。
- 建议：`PlaySession.message` 增加 `ending` 拒绝（`SESSION_ENDED` 或 `INVALID_INPUT`），或让 engine 在 `ending` 抛出可映射的 `SessionError`；补结束竞态用例。

### S-6 `panic()` 在 `onPanic` await 之后才置 `locked`，hook 抛错可跳过闩锁

- 证据：`turn-engine.ts:340-346` 先 `abortActive()`，再 `await hooks.onPanic()`，最后才 `setState('locked')`。若 `onPanic`（或将来接的 aftercare/ledger hook）reject，`panic()` reject，状态仍停在原状态；`execute` 的 settle 守卫只认 `locked`/terminal，可能把回合送回 `idle`。
- 影响：P0 闩锁依赖 hook 不抛；`PlaySession` 的 `onPanic` 目前是 `registry.emergencyStop`（通常不抛），但这是安全边界上的隐式假设。
- 建议：先置 `locked`（并记录 panicked），再 await hook；hook 错误只 `emit('error')`，不得阻止闩锁；补 onPanic 抛错用例。

## 建议

- **A-1** `end()` 的 `if (this.turnState === 'locked') setState('ending') else setState('ending')`（`turn-engine.ts:363-368`）是死分支；建议删除或让 locked 有独立收尾语义。
- **A-2** `dispose()`（`:376-381`）只 abort active，不取消 `currentRun` 的 turn timeout、不处理 settle hook；runner 不响应 abort 时定时器仍挂到 60s（波次三 S-4 的残余）。
- **A-3** panic 落在 `onSettle` 时闩锁已保住（`:625,645`），但 `turn_completed` 在 `:639` 已经写下 panic 前的 outcome；建议在 `onSettle` 后再判一次 locked，或记录 cancelled 的终态事件。
- **A-4** `session_end` detail 只有 `{reason}`（`:370`），§4.11 要求 `{sessionId,endReason,actualMin,aftercare}`；B2-T8 接账本前需补齐或明确延后。
- **A-5** `probePromptBlock` 的 director 分支只测长度/包含，不测“无原始数字”；`agent-context-director` 的 `inputHasPersona`、预算常量、`WRITER_TEMPLATE_LINE` 无数字等是永真断言（见下）。

## 必答问题（文件:行）

**Q1 投影隔离**
- 导演：`DirectorContextInput` 无 `persona` 全文字段（`director.ts:252-271`），输出 `DirectorDeviceView` 只有 region/level/可用性，无百分比（`:412-442`）；纯函数、JSON 字节稳定（测试 `agent-context-director.spec.ts:248-266`）。但 `state.flags/player` 与 `lastLine` 原样透传（`:377-384`），任意值可含数字/设备 id；`outputSchema` 是共享对象引用。**结构上满足“不读人设全文/不发设备百分比”，字面上不是所有字段都净化。**
- 写作：`humanizePlan` 只读 narrative 字段并删除所有 `\p{Nd}`（`writer.ts:214-229,329-340,390-393`），`planText`/`mustMention[].text`/`probeBrief` 干净；但 `WriterContext` 透传 persona/host/scene/recent/corpus 和 `beatId`（`:251-263,51-55`），见 S-1。两者均无 clock/random，同输入 JSON 稳定（测试 `is byte-stable`）。

**Q2 probe 方向**
- `probeWriterBrief` 是固定句模板（`probe-projection.ts:61-66,98-100`），writer/model block 无数字；`unavailable` 句是“暂时不在画面/没有佩戴”，不是负面判断（`:65`）。
- `probeDirectorJson` 的 `delta`/`reason` 未进提示词；但 `magnitude` 档位进了 `probePromptBlock({for:'director'})`（`projection.ts:205-218`），见 S-2。
- 审计 detail 由 `auditDetail` 白名单复制（`probe.ts:337-352`），`targets` 只保留 `deviceId/channelId`，没有设备 percent/cap；一条动作一次 `settle`，`settleAll` 幂等（`probe.ts:229-245`，测试重复 settle 仍 2 行）。`baseline/window` 里是感知特征（含音频百分比），不是设备强度百分比。

**Q3 调度与抢占**
- `PriorityQueue` 排序稳定：priority→`at`→插入 seq（`scheduler.ts:82-87,169-180`）；测试 `keeps same-priority order...` 通过。
- 队列本体：P2 queued、P3 dropped、P4/P5 ignored（`scheduler.ts:134-142`）；engine 忙时 P3 丢弃、P2 排队、P4/P5 不 start（`turn-engine.ts:267-293`）。
- 500ms 是 **真定时器**（`turn-engine.ts:478`，测试断言 `pendingCount`），但只 abort controller；executor/生产 runner 不响应，见 B-3。
- P1 三种时机 action 名正确：planning/executing=`preempted`，writing=`writer_preempted`（`scheduler.ts:216-230`，`turn-engine.ts:482-492`，actor=system）；detail 缺 `remainingBeats`，见 S-3。
- P0 修复：settle 尾段已闭合（探针：panic 在 `onSettle` 挂起时最终仍 `locked`；`turn-engine.ts:625,645`）；panic 的 `plan_fallback` 对 reject 路径已闭合；但干净 resolve 路径仍 `completed`+回填台词（B-4）。`end()` during panic 的 locked 收尾（`:369-371`）符合 §8.9。

**Q4 会话服务**
- “一进程一会话”：顺序重复 start 拒绝（`play.ts:496-499`, `:230-233`；测试 `refuses a second...`）；**并发 start 不成立**（B-5）。
- 无会话 message/重复 start/locked start+message：`PlayHost.message`/`PlaySession.message`/`start` 抛 `SessionError`，dashboard `sendSessionFailure` 映射 400（`dashboard.ts:133-144,372-460`；测试覆盖 400）；locked 下 message 有专门拒绝分支（`play.ts:317-325`）。
- ceiling：只有 `play.ts:244` 的 `setSessionCeilingByHuman` + audit `policy_change{scope:'session'}` + `savePolicy`（`:245-251`）；engine/executor/内容包没有调用点；`setByHuman` 只改通道 cap。没有发现引擎/DLC/包抬 X 的路径；但 public setter/restore/落盘失败见 S-4。结束不自动恢复 X 是 §4.7/D4 的有意行为（人类 UI 恢复）。
- 结束归零：`onEnd` 调 `registry.stop('system')`（`play.ts:270-272`），`registry.stop` 对目标 cancel runner 并写 0（`registry.ts:516-540`）；但没有测试断言 end 后 level=0，aftercare/强制收束/存档属 B2-T5/B2-T8，B1-T16 未实现。

**Q5 测试杀伤力**
- 永真/空心：`agent-context-director.spec.ts:170`（运行时 `inputHasPersona=false`）、`:199-200`（常量公式）；`agent-context-writer.spec.ts:285,301`（常量）；`sensors-probe-projection.spec.ts:84`（固定句不含 `%`，实现天然成立）；`sensors-projection.spec.ts:168`（常量 200）；`engine-scheduler.spec.ts:106`（常量序关系）。
- `humanizePlan` 带百分比（写成 `50%`）：红 `agent-context-writer.spec.ts:119-136`、`:310-320`（no digit）、`:322-334`（loop no digit）；若写“一半/百分之五十”则**全绿**（没有语义百分比断言）。
- `probeWriterBrief` 加数字：红 `sensors-probe-projection.spec.ts:77-86`（no digit）、`:88-106`（四句精确值）；红 `sensors-projection.spec.ts:176-190`（writer no digit）、`:198-209`；**不会红**：只检查 writer 长度的用例、manifest 外的常量断言。
- P3 改成排队：红 `engine-scheduler.spec.ts:65-66`（`dropped`）与 `:123-145`（queueSize/resolvers）；**不会红**：若只把 engine 对 P3 改成 `ignored`（不排队也不丢弃），`:138-144` 仍绿（没有断言 dropped 事件/队列为空的原因）；P1/P2 队列用例不受影响。
- PlaySession ceiling 不经人类路径：若把 `setSessionCeilingByHuman` 换成等价的 private 写入且仍 save+audit，`play.spec.ts:251-264` **仍绿**（只查结果/审计形状）；若删 save/audit 才红 `policySaves`/`policy_change`。**空白**：没有断言调用的是人类 setter；没有 plan/pack/engine 高值端到端；没有 savePolicy 失败、end 后不自动恢复 X 的用例。
- 其它空白：P1 并发双回合、end/message 竞态、panic clean-resolve、生产 executing 抢占、writer 透传数字、director magnitude prompt、P3 ignored 变异。

**Q6 集成**
- `play.ts:406-420` 正确传了 `signal`、`turnId`、`phase`（用 `phases.current`）、`resolveContext`（registry snapshot + scenario + waveforms）；`onStage` 有状态守卫，避免 `writing→executing` 抛错。
- **`preemptSignal` 没有接**：engine 发出（`turn-engine.ts:566`），`runTurn` 无该字段，`play.ts` 忽略；见 B-3。
- 超时层数实际是 **3 层**：engine `turnTimeoutMs`（`turn-engine.ts:542`）、`runTurn` 的 `clock.timeout(timeoutMs)`（`loop.ts:149`）、transport 每次请求的 `clock.timeout(timeoutMs)`（`transport.ts:88-93`）。play 把 engine 的值传给 runTurn，三者同一 60s 时没有观察到“砍两次”的二次结果（engine 先到，runTurn 检查 caller abort），但存在冗余；更重要的是 B-2 的“超时后成功返回”比双砍更严重。
- `end()` 与 P1 竞态：`submitPlayerInput` 在 `await running` 后直接 `start`（`:458-462`），`execute` 顶部只挡 locked/terminal（`:516`）；探针 `end()` + late message 得到 `illegal turn transition ending -> planning` 的非 SessionError rejection、`pendingCount=1` 的残留 active/timer，HTTP 有 500 风险。见 S-5 与 B-2/B-3 的串行化建议。

## 是否可放行

**不放行。** 阻塞项 B-1（回合互斥）、B-2（总超时失效，波次三 B-4 未闭合）、B-3（executing 抢占不生效/旧台词泄漏）、B-4（P0 panic 干净 resolve 记 completed）、B-5（并发 start 绕过一进程一会话）必须先修；S-1/S-2/S-3 是验收/审计契约问题，应在签字前由 Lead 裁定或修掉。settle 尾段闩锁修复本身已用独立探针验证通过；P0 #2 仅闭合 reject 路径。
