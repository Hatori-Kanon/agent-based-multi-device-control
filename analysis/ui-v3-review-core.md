# v3 设备输出语义与安全边界审查（只读）

- 审查对象：当前未提交工作区（基线 commit `f38a2f3`；设计契约 `设备范围与单窗口界面-设计说明.md`）。
- 审查方式：只读；未改源码/测试，未做 git 写操作。唯一写入是本文件，以及环境允许的 `.ui-shots/data-*` 临时试验数据。
- 基线数字：core 50 files / 635 tests、desktop 14 files / 162 tests（`f38a2f3` commit 记录）。
- 本次实测：core **50 files / 644 tests**、desktop **14 files / 163 tests**，两包 `tsc --noEmit` 均为 0 error；无 `skip`/`only`，逐文件 `it()` 计数与基线相比只增不减（见「已验证通过」）。

## 结论

**暂不建议直接合入；阻塞 1 项（B-1）。**

B-1 不是“换字段”问题，而是 v1 人类持有的**脉宽安全上限**在迁移后被整体删除：v1 默认 `maxWaveIntensity=80`，可被人类设成 45；v3 的 `ChannelPolicy` 已没有强度字段，波形帧强度只受协议 0–100 约束。BF 只封“强度/幅度”，频率带只改频率，两者都不约束脉宽，因此模型/内容包可以选中已有的 95/90 强度波形或自建 100 强度波形，输出比升级前更宽。设计 §1.3 明说强度不再由策略限制，代码是照该条实现；但验收清单第 3 条要求迁移“不放大边界”，两条在这里冲突，且安全上“BF/频率带持有脉宽边界”的说法不成立，故按安全边界计为阻塞，需产品明确书面接受，或补保护。

另有 **S-1（隐藏的遗留会话上限）** 为高优先级：如果用户第 3 条“去掉全局 X、改为每通道软上限”是按升级用户验收的，S-1 应升为第 2 个阻塞；按设计 §1.1“引擎保留第二道闸门”的写法，它目前是设计缺口，不是代码偏离。

## 阻塞级

### B-1 v1 的脉宽上限被迁移删除，模型/内容包可用到协议 100；BF 与频率带都不约束脉宽

**证据**

- v1 默认值：`git show f38a2f3:packages/core/src/devices/policy.ts` 第 50–54 行是 `{ maxPercent: 20, maxWaveIntensity: 80, maxDurationSec: 60 }`；v1 的 `clampFrameIntensity`（同 commit `waveform/clamp.ts:34-48`）在**发射端**把每帧强度压到该值。
- v2 迁移直接丢弃该字段：`packages/core/src/devices/policy.ts:399-406` 的 v1 分支只保留 `maxPercent`/`maxDurationSec`，把 `minPercent` 设为 0、频率带设为全带；`:422` 返回 `migrated: true`。`ChannelPolicy` 定义（`packages/core/src/devices/policy.ts:26-37`）已无任何强度字段。
- 发射端不再限制强度：`packages/core/src/waveform/clamp.ts:67-72` 明确“intensity 原样返回”；`packages/core/src/backends/coyote/backend.ts:337-347` 把 `mapped.intensity` 直接写进 B0 帧。
- 模型/内容包有现成的高强度素材：`packages/core/src/waveform/builtin.ts:125` 的 `climb` 是 95，`:110,114` 的 `staccato` 是 90；`packages/core/src/agent/tools.ts:181-191` 的 `waveform_author` 允许 intensity 0–100，`packages/core/src/waveform/dsl.ts:200-203` 也把 100 放行。`apply_plan` 的 `change.waveformId` 可选择它们（Coyote 通道 `supportsWaveform`），全过程不需要人类改边界。
- BF 不含脉宽上限：`packages/core/src/backends/coyote/backend.ts:254-269` 的 BF 只写 `softCapA/B`（strength）和两个 balance；协议字段见 `packages/core/src/backends/coyote/protocol.ts:117-146`，没有 pulse-width 场。
- 迁移测试正好证明该字段被丢掉：`packages/core/tests/policy.spec.ts:251-283` 的 v1 夹具带 `maxWaveIntensity: 80`，迁移结果只有 `{minPercent:0,maxPercent:25,minFreq:10,maxFreq:240,maxDurationSec:45}`，回写文本断言 `not.toContain('maxWaveIntensity')`。`analysis/ui-v3.md:50` 却写“v1 迁移……不放大边界”，在脉宽轴上是反例。

**为什么是阻塞**

- 45/80 → 100 是**输出强度维度上的放大**，且由模型/内容包触发，不是人类这次设置的。旧模型选 `climb` 会得到 80 脉宽，新模型会得到 95；旧默认 `staccato` 80，新 90。频率范围不能抵消脉宽变大；BF 也不限制脉宽。安全文档 `波形系统设计.md:40-42` 自己把 100 标成“刺痛阈值”，并称 `maxWaveIntensity` 是 D4 硬约束。
- 迁移不崩、maxPercent 不放大这两点是对的；但验收清单的“不放大边界”在强度轴不成立。

**怎么修（二选一，不能只改文档）**

1. **保留一个不可被模型触碰的脉宽上限**：对 v1 迁移保留 `maxWaveIntensity` 的语义（例如新增内部 `maxIntensity` 字段或固定常量 80），在 `clampFrameFrequency`/`CoyoteBackend.slotsFor` 里对 `intensity` 做最终 clamp；v1 文件迁移写入原值，v2 新通道默认 80。UI 可以只展示频率范围，但这个上限仍由人类持有、模型不可改。代价是设计 §1.3 的“强度字节不再被策略限制”要改写。
2. **明确接受 100 的风险**：如果产品确认删除脉宽上限是预期，则必须在设计/README/迁移说明里写明“脉宽不再受策略保护，BF 与频率带不约束脉宽”，补迁移审计（记录被删除的 v1 值），并把本项从阻塞降为已知风险；同时至少禁止 `waveform_author`/内容包创建高于 80 的强度，或在人类首次开启 100 时要求显式确认。不要在测试里只验证“100 原样通过”而不验证这个产品决策。

补回归：v1 `maxWaveIntensity: 45` 迁移后，`climb` 的 95 应输出 ≤45（若选方案 1）；模型 `apply_plan` 选择 `climb` 时实际 B0 intensity 应被 clamp；内容包导入 100 强度波形同样被 clamp。

## 应该修

### S-1 隐藏的 `sessionCeiling` 仍压住新软上限；还能造出 `minPercent > maxPercent` 的非法快照（P1，若按第 3 条验收可升阻塞）

**证据**

- `PolicyStore.effective` 只把 `maxPercent` 收窄到 `min(base.maxPercent, sessionCeiling)`，`minPercent` 保持 base：`packages/core/src/devices/policy.ts:266-269`。`restore` 保留持久化 ceiling（`policy.ts:294-315`），v1 迁移也保留（`policy.ts:417-422`），`bootstrap.ts:332-361` 在迁移后原样回写。v1 夹具/测试明确保留 ceiling 30（`packages/core/tests/policy.spec.ts:251-283`）。
- 新 UI 没有 X：`apps/desktop/src/ui/play.js:1090-1094` 开局不再发送 `ceilingPercent`，`index.html` 没有 `id="ceiling"`；但 `dashboard.ts:718-740` 的旧 `/api/session/ceiling` 路由仍保留（设计 §2 的兼容要求）。
- `/api/cap` 只按 base 校验：`PolicyStore.setByHuman` 的 `assertValidPolicy(next)`（`packages/core/src/devices/policy.ts:224-238`）只看 `next` 自身，不看 ceiling。于是 legacy ceiling=20 时，`POST /api/cap {minPercent:40,maxPercent:60}` 返回 200，`registry.snapshot()` 输出 `minPercent:40,maxPercent:20`（`packages/core/src/devices/registry.ts:766-770`），随后 `/api/level` 正输出被拒：`percent must be a whole number from 40 to 20 for this channel`。
- 实测（临时 data 目录，47866）：v1 `sessionCeiling:20`、base max 35 → 启动快照 `min 0 max 20`；cap 到 40/60 后快照 `min 40 max 20`；level 50 → 400；level 0 → 200 stop。复现命令与结果见文末。
- 同样，设备视图/游玩软上限的 max 滑杆最高都到 100，但 snapshot 的 `maxPercent` 是 effective；用户把 max 拖到 60 后会被快照拉回 20，且界面没有 X 可解释/释放。

**为什么是问题**

- 对升级用户，“每设备每通道软上限”并不真正权威：旧 X 仍在静默收窄，且 UI 不可见、不可释放；用户可能以为滑杆坏了。
- 通过仍然保留的 `/api/session/ceiling` 或任何降 ceiling 的旧客户端，可以制造 `min > max` 的非法 channel 快照，违反设计 §1.1/§2 的区间契约，并让该通道所有正输出 fail-closed（安全但不可用）。
- 这不是 fail-open；严重度取决于“全局 X 是否必须彻底退役”。按用户第 3 条验收，它是阻塞；按设计 §1.1，它是需要补齐的迁移/校验。

**怎么修**

- 迁移时把旧 `sessionCeiling` 翻译成每通道 `maxPercent` 覆盖（或至少对已有 override 做 `min(override.maxPercent, ceiling)`），再把 ceiling 重置为 100 并审计；这样既保留人类的收紧意图，又让每通道软上限成为唯一可见边界。
- 在 `setSessionCeilingByHuman` / `/api/cap` 增加交叉校验：当 `next.minPercent > min(next.maxPercent, ceiling)` 时返回 400 `INVALID_POLICY`，不要写入。
- 至少在 `PolicyStore.effective` 里保证返回有序区间（例如 `minPercent = Math.min(minPercent, maxPercent)`），并让 UI 对“达到隐藏上限”给出提示；否则快照契约仍可能被破坏。
- 补测试：legacy X=20 + cap min=40 → 400 或有序快照；X 低于通道 min 时 level 的行为；UI max 滑杆上限用 effective。

### S-2 resolver 是“先按 effective 区间映射”，不是设计 §1.2 的“先按人类区间映射、再被 ceiling 夹”（P2，语义契约）

**证据**

- 设计 §1.2 写：映射到 `[minPercent,maxPercent]`，**映射后再被 sessionCeiling 夹一次**。
- 实际 `PolicyStore.effective` 先把 ceiling 并入 `maxPercent`（`packages/core/src/devices/policy.ts:266-269`），`registry.snapshot()` 把这个 effective 值给 resolver（`registry.ts:751,767`），resolver 直接按 effective 映射：`packages/core/src/scenario/intents.ts:396,490`。
- 例：base `[10,100]`、ceiling=20、relative 50。设计顺序：map 到 [10,100] 得 55，再 ceiling → 20；实际顺序：map 到 [10,20] 得 15。两者都 ≤ ceiling，但中段表达完全不同。
- `apps/desktop/tests/m2-e2e.spec.ts:631` 的注释写“100% 映射到 [0,40]，再由 ceiling 夹到 20”，但只测 100%，两种实现都得 20，不能区分；`scenario-resolve` 没有 ceiling 场景。

**怎么修**

- 如果产品要的是“在允许带宽内保持相对表达”（实现现在的行为），就把设计 §1.2 改成“映射进 effective 区间”，并补一个 X<base max、relative 50 的测试锁定 15。
- 如果设计顺序是权威，snapshot 需要同时暴露 base `maxPercent` 与 effective ceiling（或 resolver 显式接收 ceiling），映射后再 clamp；补测试区分 15/20。

### S-3 正相对量可能被四舍五入成 0，从而走 stop 路径（P2，语义边界）

**证据**

- `mapPercentThroughRange` 对 `percent in (0,100]` 做 `Math.round(min + percent/100*span)`，`percent<=0` 才返回 0（`packages/core/src/devices/policy.ts:172-179`）。
- 默认 `[0,20]` 时 relative=1 得 0，测试已明确断言：`packages/core/tests/policy.spec.ts:142-145`（`expect(mapPercentThroughRange({minPercent:0,maxPercent:20},1)).toBe(0)`）。
- `registry.setLevel` 看到 `percent===0` 直接走 `stop`（`packages/core/src/devices/registry.ts:410-414`）；对 `runPattern` 则接受 `0..0` 的零包络（`effect.ts:119-128` 对 `maxPercent<=0` 原样返回），安静跑完 duration。

**为什么是问题**

- 模型写 `targetPercent: 1` 或 `deltaPercent` 产生 1% 时，语义上想要“最轻的输出”，实际却是**停止**（level）或**静音包络**（pattern）；`0` 同时是“停止”和“数学结果 0”，边界不区分。
- 默认事件/审计会显示 `set_level` + percent 0（若走 registry 的 level 路径）或 `run_pattern` percent 0；这会让回放误以为模型主动停止。安全上不是危险，但语义不精确。

**怎么修**

- 若“正相对量必须产生非零输出”：`if (percent > 0) return Math.max(min > 0 ? min : 1, Math.round(...))`，并补 default `[0,20]` relative 1 → 1 的测试；或
- 若接受“舍入到 0 即停止”，在设计 §1.2 写明该边界，并在 resolver 把 `requested > 0 && mapped === 0` 标记为 `clamped`/warning，避免静默。

### S-4 `/api/level` 负值校验不一致（P2，校验）

**证据（实测 47861）**

- `{"percent":-5,"durationSec":5}` → 400，但错误是 `percent 0 stops immediately; omit duration`：dashboard 只校验 finite（`apps/desktop/src/main/dashboard.ts:1063-1066`），bootstrap 只做 `Math.round`（`apps/desktop/src/main/bootstrap.ts:820`），registry 先把负值 clamp 成 0（`registry.ts:422`），再被 `assertLevelWithinPolicy(0,5)` 按 duration 拒绝（`policy.ts:141-145`）。
- `{"percent":-5,"durationSec":0}` 或 `durationSec:0.4` → **200**，audit 是 `set_level ok {percent:0,durationSec:0}`，不是 `stop`；`durationSec` 若缺失则补 capacity（默认 60），同样 400。
- 另一个边界：`{"percent":0,"durationSec":"x"}` → 400，虽然 percent 0 本应直接 stop。

**为什么是问题**

- 负值属非法输入，应稳定 400，而不是“有时 400、有时 200 并写 set_level”；错误文案也不该把负值说成“percent 0”。
- 不是安全 fail-open（最终输出 0），但会污染审计/调用方诊断。

**怎么修**

- 在 `/api/level` 或 bootstrap 先做 `percent < 0 → 400 INVALID_PERCENT`（超 100 仍按设计 clamp），再 round；percent 0 在 duration 校验之前直接走 stop，避免 `percent=0,duration="x"` 被 duration 校验拦掉。
- 补测试：-1、-0.4、0、0.4、1.4、100.4、NaN/字符串、duration 0/负/字符串/缺失。

### S-5 `/api/cap` 对“部分非法”的 patch 静默丢弃字段，可能部分生效（P2，校验）

**证据**

- `asPolicyPatch` 只收集 `typeof raw.x === 'number'` 的字段，未知字段/字符串字段被丢弃；只有所有字段都无效时才 400（`apps/desktop/src/main/dashboard.ts:317-347`，`:1041-1057`）。
- 例：按 `asPolicyPatch` 的代码，`{minPercent:"80", maxPercent:20}` 实际只应用 `maxPercent:20` 并返回 200，而不是拒绝；`{maxWaveIntensity:50, maxPercent:60}` 也会返回 200，悄悄忽略已删除字段。设计 §2 要求非法区间 400、不再接受 `maxWaveIntensity`。

**怎么修**

- 对已识别键做“存在但不是 finite number → 400”；如果请求体显式带 `maxWaveIntensity`，返回 400（或至少 warning），不要当作“没写”。
- 补测试：混合非法字段不得部分应用。

### S-6 直控 keepalive 5s 与短 `maxDurationSec` 会产生输出断档；5s 续期还会刷审计（P2，UI/运行）

**证据**

- `app.js` 直控命令的 `durationSec = max(1, min(floor(maxDurationSec), 15))`（`apps/desktop/src/ui/app.js:202-207`），keepalive 固定 5s（`:216-225`）。当人类把 `maxDurationSec` 设为 1–4s 时，每条命令先于下一次 keepalive 到期，输出会在 1–4s 后归零，再等下一次续期；表现为拖动时输出断续。
- 每次 keepalive 都走 `registry.setLevel` 并写一条 `set_level` 审计（`registry.ts:440-448`）；长时间直控每通道约 720 条/小时，审计尾部会被续期淹没。

**怎么修**

- keepalive 间隔改为按通道 `min(5, max(1, floor(duration*0.6)))`，或强制 `maxDurationSec >= 6`（后者限制人类设置，不推荐）；补短 duration 的浏览器/集成测试。
- 续期不改变目标时，考虑不重复写 `set_level`（另记 `level_keepalive` 或只记录首条），避免审计膨胀；至少在设计里说明这是预期。

### S-7 `sessionCeiling` 收紧不立即作用于运行中的 steady 效果（非 Coyote 后端；P1，既有问题）

**证据**

- `PlayHost.setSessionCeiling` 只调用 `policy.setSessionCeilingByHuman` 和 `registry.reapplyBounds()`（`apps/desktop/src/main/play.ts:638-654`）。
- `reapplyBounds` 只对 `backend.applyBounds` 非空的设备执行（`packages/core/src/devices/registry.ts:725-739`），而 Mock/XHTKJ/Ankni/MonsterParty 没有 `applyBounds`；它也不会 `runner.invalidate()` 或重写当前 level。
- `EffectRunner` 对 steady 值做 dedupe：`lastRequested` 相同就不再 emit（`packages/core/src/devices/effect.ts:307-309`）。因此降低 X 后，正在跑的 steady 效果（直接控制或模型 steady pattern）会继续以旧值输出，直到下一次显式写/keepalive/效果到期（最长 `maxDurationSec`，60s）；Coyote 靠 BF 硬件 cap 兜底，其他后端没有。
- 现有测试 `packages/core/tests/registry.spec.ts:753` 和 `apps/desktop/tests/m2-e2e.spec.ts:631` 都是先降 X、再发新命令，未覆盖“降 X 时已有 steady 效果”。

**怎么修**

- 在 `reapplyBounds` 里对每个 ready channel 执行 `state.runner.invalidate()`；若 `state.percent > 0`，以新 effective 调一次 `write`（或新增 `registry.applyCeilingNow()` 循环调用 `applyPolicyChangeNow`）。补 MockBackend + steady 效果 + 降 X 的测试，断言在下一 tick 内（或立即）≤ 新 ceiling。
- 这是 v2 已有的问题，不是 v3 新引入；但 v3 仍把 sessionCeiling 当第二道闸门，且 UI 不再暴露，建议一并修或在设计里降级为“非实时”。

## 已验证通过

### 构建与全量回归

```text
cd packages/core
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> TSC_EXIT=0
node node_modules/vitest/vitest.mjs run --pool=threads            -> Test Files 50 passed (50)
                                                                     Tests 644 passed (644)

cd apps/desktop
node ../../packages/core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json -> TSC_EXIT=0
node node_modules/vitest/vitest.mjs run --pool=threads            -> Test Files 14 passed (14)
                                                                     Tests 163 passed (163)
```

- 与基线一致且净增：core 50/635 → **50/644**（+9），desktop 14/162 → **14/163**（+1）。
- 未发现 `it.skip` / `describe.skip` / `it.only` / `describe.only`；`git diff --numstat -- '*tests*'` 显示所有测试文件只有增/改，没有测试文件被删除；逐文件 `it()` 计数对比 `f38a2f3` 均为相等或增加（例如 policy 22→28、registry 30→32、dashboard 28→29、coyote 22→23）。
- 定向回归也通过：`policy.spec.ts > migrates a version 1 file into version 2 semantics`、`maps 0, 1, 50 and 100 through [10, 60]`；`registry.spec.ts > lifts an authored envelope to the interval floor and caps its peak`、`surfaces the ceiling in the snapshot and clamps anything above it`、`treats setLevel(0) as a stop dispatch`；`coyote-backend.spec.ts > maps waveform frequencies into the channel band and leaves intensity untouched`、`leaves frequency bytes untouched on the identity band`；`dashboard.spec.ts > exposes per-channel ranges and drives direct level control`。

### 语义/安全已验证

- **映射公式**：`mapPercentThroughRange([10,60], 0/1/50/100) = 0/11/35/60`；`[0,20]` 得 0/0/10/20；`percent<=0`/非有限值返回 0（`policy.ts:172-179`，`policy.spec.ts:135-150`）。min>0 时 1% 映射到 min 而非 0（`[10,60]` → 11），符合“相对量映射进区间”的非零边界；min=0 时小相对量舍入为 0 是 S-3 的已知边界。
- **0=停止**：`setLevel(percent:0)` 走 `stop`，不进入 level 事件（`registry.ts:410-414`；`registry.spec.ts:725`）。`stop` 写 0 时 `clampPercentToRange` 的 `percent<=0` 分支保留 0，不会把停止抬到 floor（`policy.ts:193-196`）。
- **session ceiling 对新命令收窄**：`effective()` + `write()` 双重 clamp；`registry.spec.ts:753` 与 `m2-e2e.spec.ts:631` 的 20/10 断言通过。`write()` 每次都用当前 `effective()`，因此新写不会超过 `min(base.max, ceiling)`（`registry.ts:868-879`）。
- **`assertLevelWithinPolicy`/registry 顺序**：`setLevel` 先 `clampPercentToRange` 再 `assertLevelWithinPolicy`（`registry.ts:422-426`），`write` 再最终 clamp（`:874-876`）；对普通非法 interval，`clamp` 的下界是 `min(minPercent,maxPercent)`，不会超过上界。不可达的“先拒绝超 cap”语义已改为 clamp（见 S-2/S-1 的契约讨论），但方向始终向下，未发现 fail-open。
- **三条模型路径都变相对量**：`level` 的 `targetPercent`/`deltaPercent`/`strength` 都经 `requestPercent` → `mapPercentThroughRange`（`intents.ts:392-407,461-491`）；`waveform`/无 change 的 `strength` 经 `strengthTargetPercent` 映射（`:489-491`）；grep `maxPercent` 在 resolver 只出现在 `relativePercentOf`/`policyOf`，没有残留的绝对 cap clamp。`scenario-resolve.spec.ts` 的 target 10→2、delta 18→19 断言通过。
- **只有人类能改边界**：`grep -rn "setPolicyByHuman|setSessionCeilingByHuman|setByHuman" packages/core/src apps/desktop/src` 只命中 `PolicyStore`、`DeviceRegistry.setPolicyByHuman`、bootstrap HTTP `setCap`、electron IPC（人工 UI）与测试；内容包 loader/agent 目录没有 policy 写入路径；模型工具 schema 没有 cap/freq 字段（`tools.ts:55-75`；`agent-tools.spec.ts` 的 percent 字段白名单只有 `targetPercent`/`deltaPercent`；`devices_list` 描述与 schema 不返回 cap）。
- **LOCKED/急停/审计**：`prepare` 在 locked 下拒绝正输出，`stop` 永远可用（`registry.ts:882-899,547-577`）；`emergencyStop` 先置 locked、写 `panic` 审计，再逐设备 `stopAll`（`:586-611`）；`unlock` 只有 human 入口（`:614-623`）。`registry.spec.ts` 的 emergency-stop/unlock 用例、dashboard 的 panic 用例全绿；真实 dev-server（mock 设备）47861 的 audit 只出现 `policy_change human ok`、`set_level human ok/rejected`、`stop human ok` 等预期记录。
- **策略变更审计与 BF 重下发**：`setPolicyByHuman` 写 `policy_change` 带 `previous/next`（`registry.ts:626-641`），随后 `applyPolicyChangeNow` 重下发 BF（`:689-709`）；实测 `policy_change` 失败也有 `rejected` 记录；`coyote-backend.spec.ts:558` 的 BF 重写测试通过。`reapplyBounds` 仍用于 session ceiling（设计 §4）。
- **频率映射**：`clampFrameFrequency`/`clampWaveformFrequency` 先归一化端点、`Math.round`，最终 clamp 到 `MIN_FREQ..MAX_FREQ`（`clamp.ts:42-58`）；窄带 30→20、60→34，恒等带 [10,240] 返回原 frame，强度不变（`coyote-backend.spec.ts:233-271`、`waveform.spec.ts` 通过）。协议带 10–240、整数在代码路径上成立；身份带引用相等（`:69`）也符合“波形完全不变”。
- **强度 0–100 协议上限仍被强制**：所有进入 `PulseFrame` 的入口都校验：`parseHexFrame` 拒绝 >100（`hex.ts:57-72`；`waveform.spec.ts:59-66` 实测 101 被拒），DSL 把 0–100 clamp（`dsl.ts:200-203`），库 import/load 走 `parseHexFrames`（`library.ts:47-56,112-140`），内容包 loader 走 parse/compile（`scenario/loader.ts:306,323`）；`encodeB0` 的 `byte()` 不会产生 >255，但不会把 101 变合法。BF 不涉及 intensity 字段，确属“策略层不再夹”。
- **v1 迁移与回写**：在 `.ui-shots/data-w2`（v1 {maxPercent:35,maxWaveIntensity:80,sessionCeiling:100}）的副本上启动当前 v3 dev-server（47865）：启动后 snapshot 为 `a: min0 max35 minFreq10 maxFreq240`，`state/policy.json` 自动变成 `version:2`、无 `maxWaveIntensity`，audit 出现 `policy_change system scope:"restore"`。core 迁移单测通过；损坏文件测试 `policy-file.spec.ts`（maxPercent 999）仍回到默认 20，fail-closed。
- **`parsePolicySnapshot` 的 `migrated` 用法**：`parsePolicySnapshot` 仅在 v1 返回 `migrated:true`（`policy.ts:422`）；`bootstrap.ts:327` 读取 `restored.migrated`，`:361` 触发一次 `savePolicy()` 回写；回写后再次 parse 无 `migrated`，序列化不含该字段（`policy.spec.ts:251-283`）。
- **`/api/level` 实测**：47861（mock-pulse a 有效区间 10–70、maxDuration 60）：
  - 5 → snapshot/audit `percent=10`；90 → `70`；0 → `0` 且 audit 是 `stop human ok`；超界 999 → `70`；缺 duration → audit `durationSec:60`；duration 9999 → 60；duration 0/-5/"5" → 400；非数字 "x" → 400；未知设备 → 400。审计 detail 的 percent 是**实际**值。
  - `/api/cap` 非法：min80/max20 → 400 `minPercent must be less than maxPercent`；只带 `maxWaveIntensity` → 400；minFreq 121（>max 120）→ 400；maxPercent 70.5 → 400；minPercent "20" → 400。
- **`registry.setLevel(0)` 事件**：`registry.spec.ts:725` 明确“stop dispatch, not level dispatch”；live `/api/level {percent:0}` 的 audit 是 `stop` 而非 `set_level`，符合“0=停止”的路径。
- **遗留字段 grep**：`grep -rn "maxWaveIntensity" packages apps --include=*.ts` 只命中 `packages/core/tests/policy.spec.ts:256,280,292,301` 与 `apps/desktop/tests/policy-file.spec.ts:77`（v1 迁移/损坏夹具及断言）；源码 `.ts` 无命中。更宽的 grep 还会命中 `apps/desktop/src/renderer/renderer.js:92`（不再加载的旧 Electron 渲染器）、`apps/desktop/dist/*` 历史构建产物、README/设计文档，见建议。
- **`clampEnvelopeToRange` 行为**：源码 `effect.ts:119-128` 对零包络原样返回、对 floor 用 `min(minPercent,maxPercent)`、对 min=max 退化为该值；registry 的 `lifts an authored envelope to the interval floor and caps its peak` 用例通过。没有直接单测覆盖“零包络/ min=max”，见建议。

## 建议

1. **文档同步**：`波形系统设计.md:40-42,151,159,256,270`、`设计文档.md:173,267` 仍把 `maxWaveIntensity` 写成 D4 硬约束；README `:116,:179-181,:210` 仍描述发射端夹紧/试跑；`apps/desktop/src/renderer/renderer.js:92` 是已不再加载的旧 Electron 渲染器（main 的 `createWindow` 在 `apps/desktop/src/main/index.ts:148-168` 加载 dashboard `/`），但仍保留 `maxWaveIntensity` 控件。按设计 §4 至少要同步 `前端界面设计.md`/README 界面段；建议把上述旧文档标为 superseded 或彻底更新，避免 B-1 的“脉宽上限”在文档里继续被当作存在。
2. **Electron 单窗口**：`apps/desktop/src/main/index.ts:178-198,318-320` 的 `PLAY_ACCELERATOR` 仍会开第二个 `/play` BrowserWindow；用户第 1 条要求“同一个窗口、不要弹窗”。浏览器 UI 已单窗口，但 Electron 快捷键路径仍是双窗口，建议改为聚焦主窗口并切到 play 视图，或移除该快捷键。
3. **单测补齐**：v1→v2 bootstrap 回写（当前只有 core parse 单测，bootstrap 的 `policyMigrated` 分支无桌面测试）；`clampEnvelopeToRange` 的零包络/min>0/min=max 直接单测；`/api/level` 负值/NaN/0.4/超界/duration 边界；`/api/cap` 部分非法字段；session ceiling 收紧时运行中 steady 效果；B-1 的高强度波形 clamp。
4. **S-1 的 UI 可见性**：如果设计坚持“保留隐藏 ceiling”，至少在设备视图/软上限卡显示“当前被全局上限 X 限制”的只读提示，并提供人类释放/改写的入口；否则用户无法理解 max 滑杆回弹。
5. **频率映射属性测试**：对 10–240 的所有 f 和随机合法 band 断言 `output` 整数、在 `[band.min,band.max]` 与 `[10,240]` 内；对 `normaliseBand` 的反向输入明确选择“交换（当前）还是拒绝”，防止未来把反向 band 当作恒等全带放宽。
6. **审计量**：直控 keepalive 每 5s 写一条 `set_level`，建议另设低噪声事件或去重；否则审计尾部/回放会被续期占满。

### 复现命令摘要（临时数据，已清理）

```bash
# v1 迁移回写（data-w2 副本，47865）
EMBODIED_DATA_DIR="$PWD/.ui-shots/data-review-migrate" EMBODIED_DASHBOARD_PORT=47865 \
  node apps/desktop/dist/dev-server-v3.mjs
curl -s "http://127.0.0.1:47865/api/snapshot?token=$TOKEN"
# -> mock-pulse:a minPercent=0 maxPercent=35 minFreq=10 maxFreq=240
# state/policy.json -> version 2, 无 maxWaveIntensity

# 隐藏 ceiling / 非法快照（v1 + sessionCeiling=20 副本，47866）
# -> snapshot: min 0 max 20
# POST /api/cap {minPercent:40,maxPercent:60} -> 200
# -> snapshot: min 40 max 20
# POST /api/level {percent:50,durationSec:5} -> 400
#   "percent must be a whole number from 40 to 20 for this channel"
```

> 说明：上述 live 数字来自 mock 设备/内存策略，未接真实硬件；`BF` 与频率字节的实际写入由 core 单测（MockBleTransport）覆盖，不是真机电磁安全验证。
