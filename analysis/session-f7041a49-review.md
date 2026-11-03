# session-f7041a49 修改审查 · 用户两问题根因证据链

> 审计员：reviewer（task-4）。基线 **HEAD = 44d8e1c**（`fix(v9)`，2026-11-03 07:36 +08）。
> 工作区另有未提交修复（§6 任务 2 复核对象，本文 §0–§5 一律按 HEAD 源码/HEAD 构建产物取证）。
> 真实运行证据：`C:/Users/HatoriKanon/AppData/Roaming/@embodied/desktop/embodied/audit/device.jsonl`
> （845 行；**时间戳为 UTC，本地 = UTC+8**，故任务里说的 23:41–23:43 即本地 07:41–07:43）。
>
> 关键基线：运行实例 `apps/desktop/dist/main.mjs` 构建于 **07:39:31**（含 44d8e1c，见 §0），
> 失败局 `32f95259…` 于 **07:41:12 开局、07:43:58 暂停**。也就是说：**最后一局是在 v9 修复
> 重启后跑的**，下文的负面证据不能归咎于“没重启/旧构建”。

---

## 0. 基线与时间口径

| 项 | 值 | 证据 |
| --- | --- | --- |
| HEAD | `44d8e1c`（v9 修复） | `git rev-parse HEAD` |
| 运行构建 | `dist/main.mjs` mtime 07:39:31，`dist/dev-server.mjs` 07:36:01 | `ls -la apps/desktop/dist/` |
| 构建内是否含 v9 修复 | 是：`setAutopilotInterval`/choice timeout 改为 `intervalSec`，可从审计的 15s 超时反证 | 见 §3(e) |
| 失败会话 | `32f95259-a529-49ce-b740-380d3b9d772d`，pack=`tentacle-shadow@0.3.0`，30 分钟 | audit 行 799 |
| 内容包 | `tentacle-shadow` 0.2.0/0.3.0、`tentacle-freeform` 0.3.0 已装；active=0.3.0 | `content/registry.json` |
| 设备 | `coyote`（a/b）在线；`coyote-2`（a/b）部分离线，审计多次 `disconnected` | audit 行 819/831/841 warnings |
| 玩家部位词表 | `coyote-2:a=小穴`、`coyote-2:b=后穴`、`coyote:a=阴蒂`、`coyote:b=乳房` | `state/regions.json`；audit 行 796–798 |
| 定时操作证据 | 07:40:25 `coyote:b` 小穴→**乳房**；07:41:07 `coyote-2:b` **chest**→后穴；07:41:10 `coyote-2:a` null→小穴 | audit 行 796/797/798 |

> **构建产物说明（复核后追记）**：取证时 `apps/desktop/dist/main.mjs` 的 mtime = 07:39:31（HEAD 44d8e1c），
> 但本报告 §7 复核期间（08:09）实现者重新构建了该文件（已含修复，gitignored）。因此下文凡用“运行实例拒绝
> 重复导入”作证据处，以 **HEAD 源码 + HEAD 单测 + `dist/dev-server.mjs`（07:36:01 构建、未再重建，仍为 HEAD 代码）
> 第 9865 行**为准；旧 `main.mjs` 的同一断言（第 9866 行）已随重建消失，但当时失败局（07:41）确实是旧构建在跑。

> 行 797 的 `previous: "chest"` 是整条证据链的“引信”：**玩家把原来可命中的包 region id
> `chest` 改成了自由词「后穴」**。v6 的自由命名 + 包推荐词表并集，从这一刻起就和 resolver 的
> 精确匹配（`channel.region === region`）分叉了（详见 §3(d)）。

---

## 1. 结论速览

| 用户问题 / 待核声明 | 结论 | 一句话根因 |
| --- | --- | --- |
| (a) v9 注入波形 enum+prompt 后 dispatch 不再 `UNKNOWN_WAVEFORM` | **不成立** | resolver 用 pack lookup 放行，registry 用 host `WaveformLibrary` 拒绝；HEAD 未把包波形注册进 host library，raw id 也未 canonicalize。v9 后 5/5 波形下发仍被拒 |
| (b) effectSummary 只留 beat.regions 命中项会藏 fallback → 小框偶尔出现 | **部分成立** | 代码确实隐藏 fallback/degraded 动作；但本局 9 回合里小框空的主因是无 plan（4/9）与波形全拒（5/5），过滤只是把“真实下发”也一并藏掉的放大器 |
| (c) 日志 23:41–23:43 turn 3/5/7/8 无 `plan_resolved` 说明什么；loop 重试是否漏“有正文无 plan” | **成立** | loop 只在 `lineParts.length===0 && plan===undefined` 时纠偏；有正文无 plan 的回合静默完成：不派发、无 plan_resolved、无效果框、无 `plan_fallback` 审计 |
| (d) 玩家部位词表 vs 包 region id 并集 + fallback 所有通道 | **成立** | worldFacts 同时列两套词；意图默认仍用包 id；`channelMatchesRegion` 精确相等 → 包 id 命中不到「小穴/后穴」→ fallback 到**所有在线 level 通道**，正文说一处、电的是全部 |
| (e) choices/超时修复（9a61b93+44d8e1c） | **成立（有细节错误）** | 审计 60.01s → 15.0s；passive 不伪造选择；但“选项文字回送模型”只到 prompt 层，真实运行里选项后的回合仍可无 plan（turn 5），用户“选项不改变行为”的体感仍成立 |
| (f) 内容包重复导入“同名文件覆盖而不是不能导入” | **不成立（未闭环）** | HEAD `pack-registry.install` 对同 `id@version` 直接抛 `already-installed`→HTTP 400→UI「导入失败」；HEAD 测试还把这个拒绝当契约断言；用户要求的覆盖语义只存在于工作区未提交修复 |

另一条用户体感必须单列：

| 用户问题 | 结论 |
| --- | --- |
| “导演感觉没起作用，针对部位的输出只偶尔出现一次，跟写作文本完全不符合” | **成立**。整局 9 回合：仅 5 回合有 `plan_resolved`，其中**只有 1 次正强度真实下发**（turn 6 b1：coyote:a 4%/4s）；19/21 次波形引用被拒；4 个回合正文有、计划无；region fallback 让“文本写小穴、电的却是全部通道” |

> §1 的裁定针对 **HEAD 44d8e1c**。工作区未提交修复的对抗式复核见 **§7**：其中 (f) 导入已**闭环**、
> (a) 波形数据链已闭环（真机未验）、(c) 有纠偏缓解但未完全闭环、(d) 主路径收窄但仍有未标注/离线的残余 fallback。

---

## 2. 真实运行证据：失败局逐回合（`32f95259…`，audit 行 799–845）

| turn | 触发 | plan_resolved | 计划动作结果（非 rejected） | 波形引用 / 错误 | 用户可见后果 |
| --- | --- | --- | --- | --- | --- |
| 1 | resume | ✅ 803 | 无（b1 rejected） | `tentacle-shadow:cilia-tickle` → UNKNOWN_WAVEFORM | 开场只有正文，无任何输出/效果框 |
| 2 | choice | ✅ 810 | 无（2 rejected） | `tentacle-shadow:saw-spin`、`builtin:tide` 全拒 | 同上 |
| 3 | autopilot | ❌ 814 | — | — | 正文有，不动作；无选项 |
| 4 | autopilot | ✅ 820 | b3 degraded 0%（成为 stop×2） | `tentacle-shadow:cilia-tickle` 拒；warning「no channel carries region(s) "inner-thigh"; falling back to every online level channel」 | 两个通道被 stop；效果框无正强度 |
| 5 | choice | ❌ 827 | — | — | 选了 `switch-region` 后，正文有、**计划无** |
| 6 | autopilot | ✅ 832 | **b1 dispatched 4%/4s**（coyote:a） | b2 `stinger-burst`（来自包 `suggest.waveform`）→ UNKNOWN_WAVEFORM | 整局唯一一次真实刺激 |
| 7 | autopilot | ❌ 837 | — | — | 正文有、计划无；无选项 |
| 8 | autopilot | ❌ 839 | — | — | 正文有、计划无；无选项 |
| 9 | autopilot | ✅ 841 | 无（`narrativeOnly:['b1','b2']`，coyote-2 断线） | — | 正文有、计划有、但设备离线 → 无输出 |

统计（可复核）：

- 9 回合中 **5 回合有 `plan_resolved`（1/2/4/6/9），4 回合没有（3/5/7/8 = 44%）**。
- 全日志 21 次带 `waveformId` 的 `run_pattern`/`set_waveform`：**19 次 rejected，2 次 ok**；两次 ok 都是裸 builtin 名（`breathing`、`staccato`）。**44d8e1c 之后（行 ≥799）5 次带波形下发，5 次全 rejected**。
- 9 回合中 `choices_offered` 仅出现在有 plan 的回合（1/2/4/6/9）；no-plan 回合连选项也没有 → 自动运行“没选项”的旧问题在 v9 后仍会在 44% 的回合复发（choices 挂在 plan 上）。

---

## 3. 逐项证据与裁定

### (a) v9 的“波形合法 id 注入”没有修好 dispatch：**不成立**

**v9 声称**（commit 44d8e1c / `analysis/ui-v9.md` §2.2 / 最后答复§2）：给 `apply_plan.change.waveformId`
注入包 namespaced enum、prompt 列 `可用波形：<packId>:<id>=<name>`，模型只能选真实 id，选中后
右轨 canvas 出现，修复审计里反复的 `UNKNOWN_WAVEFORM`。

**事实**：enum 确实注入了（机制正确），模型也确实照做了——**然后照样被拒**：

- audit 行 801/802（turn 1）：`waveformId: "tentacle-shadow:cilia-tickle"` → `UNKNOWN_WAVEFORM: no waveform with id "tentacle-shadow:cilia-tickle"`。
  0.3.0 的 `cilia-tickle` 建议波形是**裸** `cilia-tickle`（`scenario.json`）；这里是 namespaced，只能来自模型
  按新 enum 输出的 `change.waveformId` → **enum 生效了，dispatch 仍然失败**。
- audit 行 807–809（turn 2）：`tentacle-shadow:saw-spin` 拒；`builtin:tide` **也拒**（host library 明明有 `tide`）。
- audit 行 830（turn 6）：裸 `stinger-burst` 拒——这次不是模型自造，而是**包自己的
  `feedbackIntents[].suggest.waveform`**（0.3.0 `scenario.json` 的 `stinger-burst` 意图），走 `suggest.waveform`
  路径，enum 根本没参与。

**根因（两套 id 空间 + 未 canonicalize）**：

1. resolver 侧用 pack-aware lookup 放行：`apps/desktop/src/main/play.ts:363-365`（`pack.resolveWaveform(id) ?? env.waveforms.get(id)`），`PlanExecutor` 拿的就是它（`play.ts:419-425`）；`packages/core/src/execution/executor.ts:387-392` 的 `checkedWaveformId` 因此认为 id 合法，原样放行。
2. 但 resolver 返回的是**入参原样 id**，没有 canonical：`packages/core/src/scenario/intents.ts:565-584`（`return { waveformId, degraded: undefined }`）。所以 `builtin:tide` 不会变成 `tide`，裸 `stinger-burst` 不会变成 `tentacle-shadow:stinger-burst`。
3. registry 侧用的是**host WaveformLibrary**：`packages/core/src/devices/registry.ts:523-543`（`library.require(waveformId)`）；`apps/desktop/src/main/bootstrap.ts:414` 只 `new WaveformLibrary()`（内建波形），`bootstrap.ts:633` 把它注入 `DeviceRegistry`。
4. HEAD 的 `PlaySession` **没有**把包波形注册进 host library：HEAD `apps/desktop/src/main/play.ts` 只有 `pack.waveforms.map(w=>w.id)`（:940）和 prompt 菜单（:1174-1176），**没有** `addSessionWaveform`（该调用只出现在工作区未提交修复里，`play.ts:580-581`）。
5. 包 id 是 namespaced 的：`packages/core/src/scenario/loader.ts:383-384`（`<packId>:<id>`）；host 内建库没有这些 key。

**用户可见**：`UNKNOWN_WAVEFORM` → 通道没有选中波形 → 右轨没有波形可画 → 用户说“右侧滚动柱状图没生效”。
另外 `builtin:` 前缀路径（包内 `ambient-field`/`soothe` 的 suggest 就是 `builtin:tide`/`builtin:breathing`）
也是坏的：`builtin:tide` 被 registry 拒绝，只有模型恰好写裸 `breathing` 才成功。

> 结论：v9 把“模型 id 合法性”修到了 model→resolver 这一段，但**resolver→registry 这一段从未打通**；
> 声称“模型只能选真实存在的包内波形，选中后 canvas 出现”**不成立**。工作区修复（`addSessionWaveform` +
> canonical id）才触及根因——见 §7 复核。

### (b) effectSummary 只留 beat.regions 命中项：会把 fallback 藏掉 → 小框偶尔出现：**部分成立**

代码（HEAD `apps/desktop/src/main/play.ts`）：

- `:1092` `if (action.status === 'rejected') continue`（丢弃 rejected，合理）；
- `:1100-1102` 若 beat 声明了 regions 且不含 `whole-body`，则要求 `channel.region ∈ beat.regions`，否则 `continue`。
  注释写明“fallback 到其它通道的无关部位不进效果框”；`ui-v9.md` §2 也明确“未匹配 plan regions 的 fallback action 直接不显示”。

后果：当模型用**包 region id**（`inner-thigh` 等）而通道 `region` 是玩家词（`小穴`/`阴蒂`）时，
resolver 走 fallback 把动作打到全部在线通道，这些是**真实下发**；`effectSummary` 却因
`channel.region ∉ beat.regions` 把它们全部隐藏 → 小框为空。**用户看不到“其实所有通道都被驱动了”**，
也看不到 turn 4 的 stop。

但必须纠正归因：本局里小框“偶尔”的主因是上游——4/9 回合无 plan、5/5 波形引用被拒、
其余动作 degraded 0%（stop）。按审计数据，整局**只有 turn 6 b1 一个正强度真实下发**；即使不做
region 过滤，小框也只在 turn 6 可能有内容（turn 4 只有 0% stop）。所以：

- 过滤**确实**会藏 fallback（代码级确认）；
- 它不是“偶尔出现”的唯一/主要成因；把它当“清理噪音”的修法反而让真实下发更不可见。
- 另一个隐藏点：`play.ts:963-975` 效果只在 `line.trim() !== ''` 时入 transcript；**有 plan、无正文**
  的回合连效果框都不会建。与 (c) 的“有正文、无 plan”正好互补。

### (c) turn 3/5/7/8 没有 `plan_resolved` 说明什么；loop 重试漏“有正文无 plan”：**成立**

- 审计：turn 3（行 813-814，2.67s）、turn 5（826-827，2.90s）、turn 7（836-837，2.25s）、
  turn 8（838-839，2.05s）都只有 `turn_started` → `turn_completed`，**没有 `plan_resolved`、没有 choices**。
  时长 2–3s 与“一次没调工具的模型调用”吻合（有 plan 的回合 3.9–5.4s）。
- loop 的纠偏条件（HEAD `packages/core/src/agent/loop.ts:337`）：
  `lineParts.length === 0 && plan === undefined && !applied && …` → **只有“正文和 plan 都空”才重试**
  （`EMPTY_TURN_REMINDER`，:69）。模型“写了正文但忘了 apply_plan”时 `lineParts` 非空 → 不重试、不告警。
- 结果：`runTurn` 返回 `plan: undefined, dispatch: undefined`；engine `result.outcome ?? 'completed'`
  （HEAD `packages/core/src/engine/turn-engine.ts:935`）→ 记 `turn_completed outcome=completed`；
  执行器没跑，所以连 `plan_fallback` 审计都没有（该审计只在 `executor.recordResolved` 里写）。
- 用户可见：屏幕上出现一段正文，但没有任何设备动作、没有效果框、没有选项、没有任何错误提示。

> 这是“导演感觉没起作用”的结构性原因：**单次调用把“写作”修好后，模型学会了只写正文不调工具，
> 而引擎把这当成功回合**。v9 的最后答复完全没提这一类回合。

### (d) 部位词表 vs 包 region id：**成立**，且是“文本与部位完全分离”的核心

- 宿主把两套词表并集喂给模型：`play.ts:1209-1219`（`worldFacts`，regions=`sessionRegions(scenario, snapshot)`）；
  `sessionRegions` = 包 `scenario.regions` + 快照里每个 `channel.region`（玩家自由词，`play.ts:1592-1610`）。
  `buildWorldFacts` 渲染（`packages/core/src/agent/context/world.ts:196-213`）：
  - `可用部位：whole-body=全身；inner-thigh=核心敏感区（…阴蒂…）；anal=…；chest=…；waist=…；小穴=小穴；后穴=后穴；阴蒂=阴蒂；乳房=乳房`
  - `已就位部位：小穴、后穴、阴蒂、乳房`（`readyRegionIds` 只认真实 `channel.region`，`:159-168`）
  两套词同时在 prompt 里，模型没有规则该选哪套；而包 `feedbackIntents[].regions` 用的是包 id。
- resolver 是**精确相等**匹配：`packages/core/src/scenario/intents.ts:269-272`（`channel.region === region`）；
  一个都匹配不到就 **fallback 到所有在线 level 通道**并标 `no-region-match`（`intents.ts:253-266`）。
- 证据：audit 行 819（turn 4）warning 原文
  `beat b3: no channel carries region(s) "inner-thigh"; falling back to every online level channel`，
  随后 b3 在两个通道 `degraded 0%`；行 841（turn 9）两个 beat 因 `coyote-2` 断线变 `narrativeOnly`。
- 触发条件就是用户自己的操作：行 797 `previous:"chest" → next:"后穴"`，行 798 `null→"小穴"`。
  `chest` 是包 id 时能精确命中；改成「后穴」后，包 id 永远命不中，正文/意图仍然按包语义写
  （`posture`/phases 都是包词），于是“文本写小穴、实际驱动所有通道或不给”的分离被放大。
- 附带矛盾：v9 最后答复说 protocol 要求“narration 必须体现本回合 beats 的 regions（使用玩家词表
  label）”，但 beat 若用包 id，其 label 是「核心敏感区（阴部/阴茎/阴蒂/大腿内侧）」，不是玩家词；
  **这条 protocol 本身就和 resolver 的 fallback 语义互相打脸**（`play.ts:1188-1192` 的 `TURN_PROTOCOL`
  中新增项）。

> 结论：这是产品级设计裂缝——v6 承诺“包部位只作推荐、玩家自由命名是主词表”，但 engine/intents/effectSummary
> 仍以包 region id 为第一真值。只加 prompt 一句“要体现 regions”不可能修好，必须让 resolver 能按
> channel 词表/意图地域展开，或在 worldFacts 中只给一套可命中的词。

### (e) choices / 超时修复（9a61b93 后半 + 44d8e1c）：**成立**，但“选项回送”只到 prompt 层

**成立的证据**：

1. 超时从 60s 改为自动间隔：修复前 `choice_timeout` 与 `choices_offered` 差 **60.01s**
   （audit 行 771/778/786）；修复后为 **15.014s / 15.029s**（行 812/835），与用户设置的 15s 自动间隔一致。
   代码：HEAD `packages/core/src/engine/turn-engine.ts:1244`
   `const configured = this.autopilotOn ? this.intervalSec : this.config.choices.timeoutSec`；
   `setAutopilotInterval` 重排已开菜单（:348-358 附近）。
2. passive 不伪造选择：行 812 `choice_timeout` 后紧接行 813 `turn_started trigger=autopilot`，
   全程**没有** `choice_selected`；turn 5/6 的选项超时也都是如此。终态：菜单消失、下一自动回合开始。
3. 自动运行下仍有选项：`choices_offered` 出现在行 803/810/820/832/842（turn 1/2/4/6/9）；
   前提是模型调了 `apply_plan`（见下面限制）。

**局限/细节错误**：

- 最后答复说“你设置的自动间隔是 10s”，审计实际是 **15s**（如 23:41:41.8 完成 → 23:41:56.8 下一回合；
  超时也是 15.0s）。不影响结论，但说明答复没核对运行值。
- “选项文字回送模型”：代码确实保存 `{id,label,tag}` 并在下一回合发 `（玩家选择：label（tag））`
  （HEAD `play.ts:406-413/705-725/playerTextOf`；单测 `apps/desktop/tests/play.spec.ts:1175` 断言 prompt 含
  `玩家选择：退开`）。但真实运行里，**turn 5 是由 `choice_selected c2 / tag=switch-region` 触发的，
  却是一个无 plan 回合（行 825-827）**：模型收到了选项文字，仍只写正文、不调工具 → 用户“选项也不会引起
  LLM 行为变化”的体感在修复后依然成立。根因是 (c) 的无 plan 回合，不是选项文字没送到。
- 最后答复把“下回合没动作”解释成“passive 默认：不额外做动作”——**这是错误归因**。passive 的语义是
  “不替玩家补选择”，不是“下一个正常回合不下发”。审计里 turn 3/7/8 是普通 autopilot 回合，模型有正文
  但没 plan；把它们说成 passive 会让用户继续误以为系统正常。

### (f) 内容包重复导入：**用户诉求未实现（不成立/未闭环）**

**HEAD 现状**：

- `packages/core/src/scenario/pack-registry.ts:388-397`：同 `id@version` 已装 → `throw PackRegistryError('already-installed', 'pack "…"@… is already installed')`。
- HTTP：`apps/desktop/src/main/dashboard.ts:1270-1290` `/api/packs/import` → `sendPackFailure`（:278-285）
  把 `already-installed` 映射成 **400** `{code:'already-installed'}`。
- UI：HEAD `apps/desktop/src/ui/play.js:1539` → 状态行「导入失败：…is already installed」。
- 运行实例同样是这套代码：`apps/desktop/dist/dev-server.mjs`（07:36:01 构建 = HEAD 源）第 **9865** 行就是
  `throw new PackRegistryError("already-installed", …)`；用户失败局用的 `main.mjs`（07:39:31 构建）当时内容相同
  （08:09 已被实现者用修复后代码重建，见 §0 追记）。
- HEAD 单测把拒绝当契约：`packages/core/tests/scenario-pack-registry.spec.ts:314-325`
  （`it('installs the same id and version only once')` → `expect(duplicate.code).toBe('already-installed')`）。
- 工具/文档也写“拒绝”：`deliverables/content-pack-kit/内容包格式要求.md:336`
  「已安装同 `id@version` 再次导入会被拒绝（`already-installed`）；改版本号再装。」
  `analysis/ui-v6.md` §3.4 也把 `already-installed` 当作应在状态行展示的“正常错误”。

**用户诉求**：“复制解压到项目自己所需的目录，**文件名重复就覆盖**而不是不能导入”。
与 HEAD 的差距：

1. 目的地语义 OK：`<dataDir>/content/packs/<id>/<version>/` + `content/registry.json`（pack-registry 模块头 :7）；
2. **覆盖语义完全缺失**：同 `id@version` 直接拒绝，连“同名文件重写”都没有；用户更新自家包时被迫改版本号；
3. 文档/测试/工具都在固化这个错误行为，**即使改了实现也要同步改 3 处**（kit 文档、HEAD 单测、ui-v6 文档）。

**旁证**：本机 `content/registry.json` 的 `tentacle-shadow` 只有 0.2.0（06:12:49）与 0.3.0（07:22:09）两次
不同版本安装；`installedAt` 在 07:40 前后**没有**被刷新，而仓库根 `tentacle-shadow.zip` 是 0.2.0 内容
（缺 cilia/stinger/stroker 三个波形）→ 与“07:40 左右重复导入 0.2.0 被拒、未产生任何写盘”一致
（07:40:48 成功的是**新包** `tentacle-freeform`，它没有重复 id，所以能装）。

> 结论：v9 的最终答复没有覆盖导入问题；HEAD 行为与用户要求**相反**。按 HEAD 状态是 P0 级产品差异
> （工作区修复已闭环，见 §7.6），不是“用户误解”。

---

## 4. 对“上次会话最后答复”的逐条裁定

以下是 44d8e1c 提交后那段最终答复（session 事件 seq 11221，本地 07:36:21）的逐条核对：

| # | 答复原文（要点） | 裁定 | 证据 |
| --- | --- | --- | --- |
| 1 | “`choice_timeout` 确实有触发，但时间点是 60 秒” | **成立** | 行 771/778/786 差 60.01s |
| 2 | “自动运行中选项超时 = 当前自动运行间隔（10–60s）” | **成立** | 行 812/835 差 15.0s；`turn-engine.ts:1244` |
| 3 | “passive：不伪造选择、不补动作，菜单消失，开下一回合” | **部分成立** | 不伪造选择成立（无 `choice_selected`）；“不补动作/下回合可能没动作”是 (c) 的无 plan 回合，不是 passive 语义 |
| 4 | “手动模式仍然无限等你选” | **成立（代码）/未实测** | `maybeArmChoiceTimeout` 只在 `autopilotOn` 时 arm；审计里手动选择均未超时 |
| 5 | “根因：模型一直用短名/自造名，执行器拒绝；包 id 是 namespaced” | **不成立** | v9 后行 801 用了 namespaced 的 `tentacle-shadow:cilia-tickle` 仍被拒；行 830 裸 `stinger-burst` 来自包 `suggest.waveform`，与模型命名无关 |
| 6 | “注入 enum + prompt 后模型只能选真实波形，选中即右轨 canvas 出现” | **不成立** | 5/5 波形下发被拒（行 801/807/808/816/830）；HEAD 没把包波形注册进 host library（§3a）；canvas 从未有波形数据 |
| 7 | “选项之前只回送 `（选择：c1）`，现在回送 label/tag” | **成立（代码+单测）**，但行为未闭环 | HEAD `play.ts:406-413/705-725`；`play.spec.ts:1175`；然而 turn 5 由选项触发仍无 plan（行 825-827） |
| 8 | “protocol 要求 narration 必须体现 beats regions（玩家词表 label）” | **部分成立** | 代码加上了（HEAD `play.ts` TURN_PROTOCOL）；但 (d) 的包 id/玩家词裂缝使要求自相矛盾，审计 turn 4 仍 fallback `inner-thigh` |
| 9 | “效果框只保留该 beat 实际请求的部位；rejected 不显示；不再显示未下发/降级” | **成立（代码）但与用户诉求反了** | HEAD `play.ts:1092/1100-1102`；它会把 fallback 真实下发藏掉（§3b），用户反而觉得“小框没了” |
| 10 | “真实模型 + mock 设备：自动运行开局有 3 个选项，效果框不再出现无关部位，右轨强度条出现” | **部分成立** | 强度条/选项在 mock 截图里成立（`.ui-shots/v9/v9-effect-live.png`：channels 用包 label「胸部/乳房」「大腿根/阴蒂」→ 恰好能命中；框里还带「未下发」，与“已清理”矛盾）；真实设备波形路径从未验证 |
| 11 | “波形 canvas 需要真实波形通道（郊狼）和已选中的包内波形，重启后可以看到” | **不成立** | 用户就是重启后（07:39 构建、07:41 开局）用 coyote 跑的；包波形 100% rejected，永远不会“选中” |
| 12 | “core 683 / desktop 216 tests，tsc/构建全过” | **无法证伪，但不构成证据** | 测试通过 ≠ 路径可用；(a)(f) 的缺陷均无测试覆盖（见 §5） |

---

## 5. 上次会话遗漏的验证（为什么“验证过”仍然失败）

1. **波形路径从未端到端验证**：v9 的“真实浏览器”用的是 **mock 通道**（`supportsWaveform=false`），
   文档自己也写了“mock 通道没有波形能力，所以无 canvas”。也就是说 canvas 这条主诉求**只验证了不需要
   波形的降级分支**；“装上真实郊狼 + 选中包内波形”这条唯一能证明修复的路径，恰恰没测。审计证明它坏。
2. **区域词表用的是“包 label 恰好被填进 region”的配置**：`.ui-shots/v9/v9-effect-live.png` 里两个 mock 通道
   显示「胸部/乳房」「大腿根/阴蒂」，这是 0.2.0 的 **label**（UI 精确 label 匹配会折算成包 id `chest`/
   `inner-thigh`），所以 effectSummary 的 `channel.region ∈ beat.regions` 成立、小框能显示；
   用户真实配置是自由词「小穴/后穴/阴蒂/乳房」（行 796-798），**从不命中**。v9 的“效果框验证”对用户场景无效。
3. **没有检查“无 plan 回合”**：上一轮只盯 `choice_timeout`（60s），没统计 4/9 回合根本没有 `plan_resolved`；
   loop 的 `EMPTY_TURN_REMINDER` 纠偏条件也没覆盖“有正文无 plan”。
4. **选项回送只做了 prompt 字符串单测**：没有用真实模型验证“给了 label 后模型会改动作”；turn 5 反证。
5. **导入只测了“首次安装”**：`ui-v6.md` §3.4/`ui-v6` 的浏览器验证是空 dataDir + 首次导入；
   HEAD 单测甚至把“重复导入必须拒绝”写成契约。用户要的“同名覆盖”从未被测过。
6. **“重启后可以看到”是未验证承诺**：答复明确说“需要重启后生效/重启后可以看到”，但重启后的真实运行
   （07:41 起）恰恰是反例；没有在答复前做一次重启后的真实设备回归。

---

## 6. 修复验收清单（复核后逐项判定）

针对两个用户问题的**最小闭环**。判定：✅ = 已有实现且被测试真断言/真实数据支撑；◐ = 主路径已实现但有残余边界（原因见 §7）；❌ = 未闭环。

| 项 | 判定 | 依据 / 残余 |
| --- | --- | --- |
| A1 包波形 namespaced/裸/`builtin:` 三形态到 registry | ✅ | `library.ts:138` + `play.ts:581-582` + `intents.ts:600-620`；`scenario-resolve.spec.ts:555`、`play.spec.ts:1261`（真实 registry+executor，`run_pattern` ok） |
| A2 resolver 返回 canonical id | ✅ | `intents.ts:619`；`scenario-resolve.spec.ts:555/585` |
| A3 包 `suggest.waveform` 裸 id 路径 | ✅ | 同上（turn 6 的 `stinger-burst` 属此路径） |
| A4 真实 coyote/BLE 端到端 | ❌ | 本环境无硬件；mock `supportsWaveform` 只覆盖数据链（ui-v10 §4 #1 自认）。见 §7 P1-5 |
| B1 部位词表唯一化、禁止两套词并列 | ◐ | 有标注且就绪通道时 ✅（`targetableRegions`，play.ts:1689-1703；play.spec.ts:1355）；**未标注硬件仍回退完整包词表** → fallback 全通道（§7 P1-1） |
| B2 禁止 fallback 全通道成为常态 | ◐ | 别名/菜单把主路径收窄；但断线设备 + 同词 + `primary` 会静默无输出（§7 P1-2）、模型不遵守 enum 仍可 fallback（§7 安全节） |
| B3 “有正文无 plan”纠偏，不得静默 completed | ◐ | 纠偏一次已实现（`loop.ts:354-405`；`agent-loop.spec.ts:135`）；**两次都 prose-only 时仍静默**、无 `plan_fallback` 审计/UI 提示（§7 P2-3） |
| B4 效果框显示真实下发（含 fallback）+ plan 无正文占位 | ✅ | `play.ts:995-1001/1125-1170`；`play.spec.ts:1375/1424` |
| B5 选项后的回合有 plan 且可验证 | ◐ | 未直接改选项链；依赖 B3 纠偏；无真实模型断言（§7 P2-2） |
| C1 同 `id@version` 重导=覆盖（重写/清陈旧/刷新 installedAt/active/replaced） | ✅ | `pack-registry.ts:388-454`；`scenario-pack-registry.spec.ts:345/402/431/463/484`；HTTP e2e `dashboard.spec.ts:963`（真实 FsPackStore） |
| C2 UI 文案区分首装/覆盖，HTTP 不再 400 | ✅ | `play.js` import 分支；`dashboard.spec.ts:1454` 静态断言 |
| C3 文档/工具/旧断言同步 | ◐ | kit README/格式要求/install-pack/前端设计已改；**`analysis/ui-v6.md` §3.4 仍写 `already-installed` 是应展示错误**（未改） |
| C4 校验失败不动已装；写盘失败回滚契约说明 | ✅/◐ | 校验前置 + 仅回滚新建 key（测试覆盖）；**registry 写失败/陈旧删除中途失败会半新半旧**（文档承认，§7 P2-6 未测） |

原始验收意图（保留作对照）：

**A. 波形/控制链**
- 包波形（namespaced + 裸引用 + `builtin:` 前缀）能真正到达 registry 并选中：统一一个 canonical id
      或把包波形注册进 host library 的 session 作用域（`addSessionWaveform`），并在 `get` 两处一致；
- `intents.resolveWaveform` 返回**可被 registry 解析的 canonical id**（裸→namespaced、`builtin:`→裸，
      或注册时保留全名）；
- `suggest.waveform`（包自带的裸 id）路径同样通过——审计 turn 6 的 `stinger-burst` 不是模型自造；
- 真实 coyote 端到端：`run_pattern` 带 waveform → `set_waveform`/`run_pattern` 审计 ok → snapshot 有
      `channel.waveform` → `/api/waveforms/preview` 有数据；用真实审计行证明，不接受 mock 代证。

**B. 导演/部位一致性**
- 玩家自由词（`小穴/后穴/…`）与包 region id 的映射策略唯一确定：要么 resolver 能把 beat 的包 id 映射到
      玩家通道，要么 worldFacts 只给“可命中”的一套词，禁止 prompt 同时列两套互不命中的词表；
- 禁止“命中不到就 fallback 到所有在线通道”在**正常玩法**里成为常态（至多降级为 narrativeOnly 或显式告警）；
- 无 plan 回合：`runTurn` 要能识别“有正文、无 apply_plan”并纠偏（重试/降级到 `plan_fallback` 审计/UI
      提示），不能静默 `completed`；
- 效果框：只显示“真实下发”不够，fallback 下发也必须可见（否则用户无法判断“为什么所有通道都在动”）；
      有 plan 无正文时也要产出 transcript entry/效果框（`play.ts:963-975` 的 `line.trim() !== ''` 门槛）。
- 选项后的回合有 plan（turn 5 反例），并把“选项→动作差异”做成可验证断言，而不是只断言 prompt 字符串。

**C. 导入**
- 同 `id@version` 重导 = 覆盖：重写同名文件、清理旧版多余文件、刷新 `installedAt`、`replaced:true`
      （工作区已按此方向改，需验文件级语义与失败回滚）；
- UI 文案区分「已导入」（首装）/「已导入（覆盖）」；HTTP 不再 400；
- `内容包格式要求.md:336`、`analysis/ui-v6.md` §3.4、HEAD 单测断言同步改为覆盖语义；
- 失败（坏包/坏 zip）不破坏已装版本；覆盖写入中途失败的回滚契约（pack-registry 文档 :375-380）要覆盖
      “已覆盖字节无法恢复”的现实，并给出可重试修复路径。

---

## 7. 修复复核（任务 2，对抗式）

### 7.0 范围与状态

- 复核对象：工作区未提交 diff（HEAD 仍为 44d8e1c；工作区 **23 个文件 +1551/−130**）。
  其中 3 个文档是 08:10–08:11 追加的（`README.md`、`内容包规范.md`、`导演与写作上下文契约.md`，已纳入 7.5），
  **源码 mtime ≤ 08:07、复核期间未再变化**。`dist/*` 为 gitignored 构建产物，08:09 被实现者重建，不计入 diff。
- 本节行号均为**工作区文件**行号（修复未提交）；HEAD 对照行号见 §3。
- 本审计员未改任何代码；唯一写入是本报告。未 `git commit`。

**独立验证执行记录（本机 08:10–08:25）**

| 命令 | 结果 |
| --- | --- |
| `packages/core && ./node_modules/.bin/vitest run` | **52 files / 701 tests passed** |
| `apps/desktop && ./node_modules/.bin/vitest run` | **17 files / 223 tests passed** |
| 两包 `./node_modules/.bin/tsc --noEmit` | 均 exit 0 |
| esbuild `src/main/index.ts` / `src/dev-server.ts`（`--outfile=/dev/null`，不落盘） | 均 exit 0（main 604.0kb / dev 835.5kb） |
| `node --check src/ui/play.js` | ok |
| 真实数据推导（0.3.0 pack + `state/regions.json` + 审计里的在线状态） | `targetableRegions` = `乳房/阴蒂`；`aliases` = `inner-thigh→[阴蒂]`、`anal→[后穴]`、`chest→[乳房]`；`小穴` 无别名（只能靠显式玩家词命中） |
| resolver 复现（离线设备 + 同词 + `primary`，见 P1-2） | `commands=[]`，仅 warning `aaa-offline/a is disconnected; command not sent (narrative only)` |

### 7.1 总体结论

- **P0（可阻断上线/数据或安全）**：**0 项**。用户问题 2（导入覆盖）已真正闭环；波形数据链已闭环（真机未验）。
- **P1**：5 项——未标注硬件仍回退全通道（P1-1）、离线设备 + 同词 + primary 静默无输出（P1-2）、
  包内波形 >64 会让开局直接失败（P1-3）、人类导入的 session 波形被开局/结束清掉（P1-4）、
  真实郊狼波形端到端仍未验证（P1-5）。
- **P2**：8 项，详见 7.2。
- 安全边界（LOCKED/cap/不伪造选择/台词不入控制/已 dispatch 不回滚/executor 只吃 plan）**未被破坏**；
  但“模型不遵守 region enum 时仍 fallback 驱动全部在线通道”这一残余风险还在（见 7.4）。

### 7.2 问题清单

#### P0

无。

#### P1

**P1-1｜未标注硬件（或仅离线通道有标注）时仍回退完整包词表 → fallback 驱动全部在线通道**
- 位置：`apps/desktop/src/main/play.ts:1689-1703`（`targetableRegions` 的 `reachable.size === 0` 返回
  `vocabulary`）、`:1718-1745`（别名把非 ready 通道也算进来）、`packages/core/src/scenario/intents.ts:264-280`（fallback 全部在线通道）。
- 问题：`reachable` 只统计 **ready 且已标注** 的通道。刚开一局、玩家还没填部位时 `reachable.size===0`，
  菜单/枚举回退为“完整包词表”（`inner-thigh=…` 等）；模型按包语义选 `inner-thigh` → resolver 精确匹配失败 →
  fallback 把**所有在线 level 通道**驱动一遍（`degraded:'no-region-match'`）。用户问题 1 的“文不对部位”
  对 fresh 用户/未命名通道**仍然复现**；副作用是这些 fallback 行现在又会全部出现在效果框里（B4 的真实性目标与
  “不显示无关部位”的用户要求冲突）。
- 证据：`play.spec.ts:1261` 的测试明确断言这一路径（`已就位部位：无` + 菜单含 `inner-thigh=`），即行为被有意保留；
  `scenario-resolve.spec.ts:624` 断言无别名时 fallback 全通道。审计里用户给 4 个通道都命了名，所以主路径被掩盖。
- 建议：`reachable.size===0` 时菜单只保留 `whole-body`（worldFacts 本来就会加 wildcard；whole-body 同样能驱动
  全部 ready 通道，但叙述不会伪造具体部位）；或在 resolver 中把“无别名且无精确匹配”的 region 降级为
  `narrativeOnly` 而不是 fallback。补测试：2 个 ready 未标注通道 + 模型选 pack id → 断言**不**产生
  `no-region-match` 对全部通道的下发。

**P1-2｜断线设备 + 同词通道 + `distribution:'primary'` → 静默无输出（primary 选中离线通道后被丢弃）**
- 位置：`packages/core/src/scenario/intents.ts:227-280`（`collectMatches` 遍历所有 device，不按 lifecycle 过滤）、
  `:308-330`（`primary` 取 `matches[0]`）、`:326-331`（`buildCommand` 对非 ready 设备返回 `undefined` 只留 warning）。
- 问题：别名/等值匹配会把离线设备通道排进候选（按 deviceId 排序）；`primary` 只取第一个，若它是离线设备，
  命令被整体丢弃，**后面的 ready 通道永远轮不到**。用户场景（两台设备，一台断线，两侧同词如都叫“小穴”）会
  “这一回合什么都没发生”，只有一条 audit warning。
- 证据（本机复现）：`aaa-offline`(disconnected, 阴蒂) + `zzz-ready`(ready, 阴蒂)，`regionAliases{inner-thigh:[阴蒂]}`，
  `primary` → `commands=[]`；仅 `beat b1: aaa-offline/a is disconnected; command not sent (narrative only)`。
- 说明：这是 HEAD 已有缺陷（`collectMatches` 本来就不滤 lifecycle），但本轮的 player-vocab 化/别名让跨设备同词
  命中更常见，且用户审计里 coyote-2 正是断线设备（只是当前 sort 恰好让 ready 的 `coyote` 在前，没触发）。
- 建议：`collectMatches` 先只收 `device.lifecycle==='ready'` 的通道（离线设备本来也下发不了），或在 `selectMatches`
  里 ready 优先；补 `play.spec` 的 offline-device 用例。

**P1-3｜包内波形数 > 64 时 `PlaySession.start` 直接抛错（开局失败），且 loader/规范未限制数量**
- 位置：`packages/core/src/waveform/library.ts:24`（`MAX_SESSION_WAVEFORMS = 64`）、`:138-146`（`addSessionWaveform`
  到第 65 个抛 `INVALID_WAVEFORM`）、`apps/desktop/src/main/play.ts:581-582`（开局时逐个注册）。
- 问题：zip/loader 最多允许 2048 个文件、规范未限制 `waveforms/*.json` 数量；一个含 65 个波形的合法包会让
  **开局失败**（错误文案还是“session already holds 64 waveforms…promote and clear”，与内容包场景不匹配），
  且被跳过的部分波形留在 scratch 直到下次 start 清空。
- 建议：load/validate 阶段校验波形数量（≤ `MAX_SESSION_WAVEFORMS`，给出可读错误），或让 host 注册走独立的
  pack 作用域不受 session cap 限制；补 >64 用例（当前无测试）。

**P1-4｜复用 `clearSession()` 会清掉人类导入/创作的 session 波形（本轮新引入的行为回归）**
- 位置：`apps/desktop/src/main/play.ts:581`（开局前 `clearSession()`）、`:863`（dispose 再清）、
  `apps/desktop/src/main/play.ts`（`PlayHost.start` 失败分支 `session.dispose()`，工作区 ~:1345）、
  `packages/core/src/waveform/library.ts:149-161`（`importFrames` 也写 scratch）、
  `apps/desktop/src/main/bootstrap.ts:1478-1482`（人类导入入口），UI `apps/desktop/src/ui/app.js:975`。
- 问题：HEAD 只在进程 shutdown 时 `clearSession()`；本轮为了让“包波形不跨局泄漏”在 **start 与 dispose** 清空
  整个 scratch。但 scratch 同时承载**人类导入的波形**（产品 UI 的波形导入/创作）。于是“导入波形 → 开局/结束 →
  波形消失（未 promote 的）”，且**失败的开局也会清**（dispose 失败分支）。
- 说明：ui-v10 §2/§4 把“agent 会话波形也按设计丢弃”写成预期，但没区分“host 注册的包波形”与“人类导入波形”；
  用户动线里这是可见的资产丢失。
- 建议：新增 `removeSessionWaveform(id)`/pack 专用作用域，只移除本局注册的 `<packId>:*`（或记录注册集合），
  不要全量 `clearSession()`；补测试“导入波形 → start → 仍可列出/选中”。

**P1-5｜真实郊狼/BLE 波形端到端仍未验证（数据链已用 mock 覆盖）**
- 证据：ui-v10 §4 #1 自认；本轮 tests 用 `supportsWaveform: true` 的 mock 后端覆盖
  `resolver→registry→channel.waveform→preview`（`play.spec.ts:1261/1323`），但没有真实 `applyWaveform`/`BF`
  时序；用户上一轮失败正是“真实郊狼 + 包波形”。
- 建议：用户机回归清单（真实 coyote：开局后 `run_pattern` ok、snapshot `channel.waveform` 有值、
  `/api/waveforms/preview` 有帧、右轨 canvas 滚动）；取得 1 条真实审计行再宣布闭环。

#### P2

**P2-1｜纠偏轮与 turn 预算/abort 的交互**：`packages/core/src/agent/loop.ts:376-391` 在纠偏轮期间
`timedOut` 直接 `throw timeoutError`（**未 await `settleDispatch`**），caller abort 时亦然；对比主路径
`:351-352` 是先 `await settleDispatch()` 再继续。后果：①首轮已有可用正文的回合，可能因纠偏轮吃满预算而
从“成功 narrative-only”变成 `timeout`（正文丢失、engine 记 fallback）；②若纠偏轮已开始 dispatch，会先抛错
再让 `plan_resolved`/in-flight 效果在回合“失败”之后落地（效果不回滚是契约，但审计时序不一致）。
建议：纠偏前检查剩余预算（或给纠偏独立小预算）；timedOut/abort 且 `hadProse` 时保留首轮按 narrative-only 收尾；
无论如何先 `await settleDispatch()`。补测试：SlowRunner + FakeClock 让纠偏超时。

**P2-2｜纠偏消息形状未在真实 provider 验证**：`loop.ts:370-375` 把首轮正文作为 `{role:'assistant'}` 回灌。
v8 已踩过 DeepSeek thinking-mode 对“assistant 结尾/缺 reasoning_content”的 400；虽然这里末尾是 user，但
history 中多了一条无 reasoning 的 assistant 消息，仍未在真实 DeepSeek 配置上验证。ui-v10 的“真实模型冒烟”
4/4 回合都有 plan，**没有触发纠偏路径**，因此不能作为该路径的证据。建议：真实模型下构造 prose-only 回合验证；
失败时至少走“保留首轮”分支（不会崩，但修复退化）。

**P2-3｜两次都 prose-only 时仍静默成功（无 plan、无审计、无 UI 提示）**：`loop.ts:354-405` 只纠偏一次；
仍无 plan 时 `PlaySession` 的 `needsPlaceholder` 为 false（`play.ts:995-1001`），若两次都没有正文则连 transcript
entry 都没有。建议：第二次仍无 plan 时写一条 `plan_fallback` 审计或 host warning，并让 UI 显示“本回合模型未给出动作”。

**P2-4｜纠偏轮有 plan 但 narration 为空时回灌旧正文**：`loop.ts:401-404` 在纠偏轮无正文时把**首轮正文**当 line；
若首轮正文描述的是“没动作”的场景，而新 plan 已驱动部位，正文与动作再次不一致（用户问题 1 的同类症状）。
建议：纠偏轮有 plan 时要求 narration 非空，否则用 `WRITER_TEMPLATE_LINE` + warning，而不是回灌旧正文。

**P2-5｜覆盖安装的 Windows 大小写重命名竞态**：`pack-registry.ts:400`（`incoming` 用新归档大小写）、
`:423-429`（`stale = previous.filter(!incoming.has)`）；`FsPackStore` 的 list 返回磁盘上的真实大小写，
`remove` 在大小写不敏感文件系统上解析到同一文件。旧包 `Host.md` → 新包 `host.md` 时，写入 `host.md` 后
“删除陈旧 `Host.md`”**有可能**删掉刚写入的新文件 → 版本缺文件、registry 仍提交（NTFS rename 的 casing
行为依实现细节而定，需实测）。建议：stale 比较用 casefold（Windows）或写入前先删同名 case 变体；
补 Windows 集成测试（当前 dashboard e2e 不覆盖大小写改名）。

**P2-6｜覆盖安装“半新半旧”没有 UI 恢复提示**：`pack-registry.ts:417-452` 陈旧文件删除后若 `writeRegistry`
失败，旧版本文件已缺失、registry 仍旧（文档 :430-440 承认“重导修复”）。产品 UI 只显示“导入失败”，没有
“请重新导入一次以修复”的提示。建议：错误映射为明确的可重试文案；长期用临时目录原子 swap。

**P2-7｜别名的子串启发式边界**：`play.ts:1739` `region.label.includes(channel.region)`：
①玩家用「敏感」「部」「深处」等泛词会同时命中多个包 region（多义）；②一个包 region 可命中多个通道词
（「大腿内侧」「阴蒂」都在 inner-thigh label 里），`primary` 会按 device/channel 字典序任选，未必是用户所指；
③不过滤 offline 通道（放大 P1-2）。建议：最小长度/字符集白名单、或按作者显式 `aliases` 取代子串猜测；
补歧义测试。

**P2-8｜文档/旧接口漂移**：`analysis/ui-v9.md` §2.2/§2 仍写“fallback action 不显示”“波形 enum 已修”
（已被 ui-v10/本修复推翻，未加“superseded”标记）；`analysis/ui-v6.md` §3.4 仍把 `already-installed`
当应展示错误。另：`deliverables/content-pack-kit/安装内容包.bat:7` 帮助文本 `templatesreeform`（缺 `f`，
HEAD 既有小 typo，未随本轮 docs 更新修正）。建议：ui-v9 顶部加 superseded 指针、ui-v6 §3.4 改覆盖语义、bat 修 typo。

#### 顺带发现（非本轮 diff 引入）

- `effectSummary` 现在会显示 `degraded:'no-region-match'` 的 fallback 行（`play.ts:1125-1170`），但 UI 不再标注
  “降级/未下发”，用户看到“所有通道都亮了/都在框里”却不知道是回退——这是“真实 vs 解释”的取舍，ui-v10 §4 #4
  已承认；建议给 fallback 行一个轻量标记或 tooltip（不恢复噪音标签）。
- `TURN_PROTOCOL` 新增“有已就位部位时 beats 至少一个动作带 regions”（`play.ts:147`）：对“只想停顿观察”的
  剧情可能过度强制（caps 仍保护硬件，不是安全边界）。可接受，观察真实模型是否被这句话带偏。

### 7.3 测试是否真断言

**真断言（有行为/字节/审计级证据，非只跑通）**

- 覆盖安装：`scenario-pack-registry.spec.ts:345`（同名文件字节变化 + 陈旧文件删除 + `installedAt` 刷新 +
  active 不变）、`:402`（非 active 旧版本重导不影响 0.2.0）、`:431`（坏包重复导入磁盘/registry 零变化）、
  `:463`（清理失败保持旧 key 集）、`:484`（只回滚本次新建 key、已覆盖字节保留）；`dashboard.spec.ts:963`
  用真实 `FsPackStore` 走 HTTP 两次导入 + 磁盘文件断言 + stale ENOENT 断言。这部分**不是造假测试**。
- 波形：`waveform.spec.ts:358`（`require` / `scopeOf==='session'` / 不进 durable）、`scenario-resolve.spec.ts:555/585`
  （三种引用 → canonical id 且 host library `require` 通过）、`play.spec.ts:1261`（真实 registry+executor：
  `run_pattern` 全 ok、transcript effects 带 `waveformId/name/percent`、换局后 scratch 清空）。
- 部位：`play.spec.ts:1323`（别名把 `inner-thigh` 落到「阴蒂」通道，效果框 `percent:4` 验证了 20%→0-20 区间映射未变、
  `plan_resolved` 无 fallback warning）、`:1355`（菜单只含玩家词 + enum 断言）、`:1375`（fallback 行不再被过滤、去重）。
- 纠偏：`agent-loop.spec.ts:135/182/214/249/283`（采用纠偏 plan、纠偏无正文保留首轮、纠偏传输失败保留首轮、
  abort 时拒绝、纠偏仍无 plan 用纠偏正文）；`play.spec.ts:1396`（host 层 2 请求后 1 条 transcript + 真实 dispatch）。
- 占位：`play.spec.ts:1424`（plan 有动作但正文为空 → 模板句 + 效果框，且不伪造 `plan_fallback`）。

**被“适配”的既有测试（合理但要注意覆盖面）**

- 大量既有 play/settings/pipeline 测试为了“每回合请求数”改成 scripted turn 带 `planCall`（`play.spec` 几十处、
  `settings.spec:664`、`agent-pipeline.spec:309`）。这是本轮行为变更的正当调整，但意味着**旧的“prose-only 回合成功”
  语义不再被这些测试覆盖**；新的覆盖只在上述少数纠偏用例里。建议保留一条“两次 prose-only 仍 narrative-only”的
  host 级测试（含审计/UI 期望），避免未来回归。

**未覆盖（建议补测）**

- P1-1（未标注 ready 通道 + 模型用包 id → 不应把全部通道驱动）、P1-2（offline + 同词 + primary）、
  P1-3（>64 波形）、P1-4（导入波形跨 start/end 存活）、P2-1（纠偏超时）、P2-2（真实 provider 纠偏形状）、
  P2-3（两次 prose-only 的审计/UI）、P2-5（大小写改名覆盖）、P2-6（registry 写失败后的修复提示）、
  并发导入（`runPackOp` 序列化，但无显式测试）。

### 7.4 安全回归检查

| 约束 | 结论 | 依据 |
| --- | --- | --- |
| LOCKED 仍然阻断控制 | ✅ | 执行器/registry 未改；新代码只在 prompt/transcript/snapshot 读取；既有 lock/panic 测试全过 |
| cap / percent 映射不变 | ✅ | `intents.buildBody` 未改；`play.spec.ts:1323` 断言 20% 相对量 → 4%（0–20 区间）；ceiling 测试通过 |
| 不伪造玩家选择 | ✅ | choice 路径未改；passive 超时依旧不产生 `choice_selected`；loop 纠偏不碰 choices |
| 台词不入控制 | ✅ | 纠偏只把正文作为 prompt 的 assistant 消息；控制仍只来自 `apply_plan`；executor 只吃 plan |
| 已 dispatch 不回滚 | ✅ | 纠偏条件 `!applied`；dispatch 出错按契约抛错、效果不回滚；测试覆盖 |
| executor 只吃 plan / 无新控制入口 | ✅ | 新增 `addSessionWaveform`/`clearSession` 为 host API，非 agent 工具；模型工具集未变 |
| 残余风险：fallback 驱动全部在线通道 | ◐ | 模型若不遵守 region enum，resolver 仍 fallback-all（P1-1/P1-2）；caps/LOCKED/ceiling 仍兜底，但“只刺激玩家指定部位”的用户意图不保证。建议 resolver 对“非 targetable 且无别名”的 region 直接 narrativeOnly |

### 7.5 文档声明核对（`analysis/ui-v10.md`，实现者自述）

- ✅ **可复核且成立**：`addSessionWaveform`/canonical id/菜单收窄/别名/效果框/占位/导入覆盖的代码与文档位置
  均与实际一致；测试数字 **core 701 / desktop 223**、两包 tsc、esbuild 5 产物构建——本审计独立复现一致；
  kit 文档/install-pack/前端设计同步更新，`deliverables/content-pack-kit.zip` 已于 08:05 重打包（含新文案）。
- ⚠️ **未验证声明**：§3“真实模型端到端冒烟”（A/B 两个场景、4/4 回合有 plan、0 rejected）——临时数据目录已删，
  无审计/日志产物可复核；且它 4/4 都有 plan，**没有触发本轮最关键的 prose-only 纠偏路径**；也没有真实 BLE 设备。
  只能当作“作者口述”，不能替代用户机回归。
- ⚠️ **口径问题**：“会话 scratch 生命周期（agent 会话波形也按设计丢弃）”掩盖了 P1-4（人类导入波形同 scratch）；
  “无 plan 回合 4/9→0”是 4 回合冒烟，不是对原失败配置的回放。
- ✅ ui-v10 §4 已自认“真实郊狼未验 / 覆盖安装不可逆 / 空目录 / 别名 fallback 残差”，与本节 P1-5/P2-6/P1-1 对齐。
- ✅ 08:10–08:11 追加的三份文档与本修复一致，无夸大：`README.md` 补 v10 段（包波形/无 plan 纠正/词表/效果框/
  覆盖导入）并登记 ui-v10 与本审计报告；`内容包规范.md` §6 写明“同 id@version = 覆盖安装、校验失败不触碰旧版”；
  `导演与写作上下文契约.md` 新增 v0.1.1 运行时修订三条（无 plan 纠正一次、可达词表+别名、效果框真实投影），
  并重申“控制仍只来自 `apply_plan`、LOCKED 不变”。README 里“所有波形下发被 UNKNOWN_WAVEFORM 拒绝”略有
  过度概括（审计中裸 builtin 名曾成功 2 次），不影响结论。

### 7.6 闭环判断（交给 Lead）

| 用户诉求 | 判定 | 说明 |
| --- | --- | --- |
| 2. 内容包导入“文件重名就覆盖，不要不能导入” | **已闭环** | 同 id@version 覆盖 + 清陈旧 + 刷新 installedAt + `replaced` + HTTP 200 + UI“已导入（覆盖）” + 文档/工具同步；core 单测与真实 FsPackStore HTTP e2e 双重覆盖。残余为 P2-5（Windows 大小写改名）/P2-6（半新半旧提示）/不可逆（已文档化）。 |
| 1a. 波形/右轨柱状图 | **数据链已闭环，真机待验** | resolver→registry→snapshot→preview 全链路测试通过；真实郊狼未验（P1-5）。 |
| 1b. 导演/部位一致、“小框偶尔出现” | **部分闭环** | 有标注且就绪的配置 + 遵守 enum 的模型：菜单/别名/效果框/无 plan 纠偏都能工作（P1-1 之外的路径已覆盖）；未标注硬件（P1-1）、离线同词 primary（P1-2）、两次 prose-only（P2-3）、真实硬件（P1-5）仍会复现用户症状；narration 与 plan 的一致性仍主要靠 prompt（无结构化校验）。 |
| 1c. 选项不改变行为/无选项 | **部分闭环** | 选择文字回送未改（上一轮已做），本轮靠“无 plan 纠偏”间接改善；没有真实模型验证选项→动作差异，且无 plan 回合仍然没有 choices（选项挂在 plan 上）。 |

> 结论：**可以交付用户做真机回归**，但必须在交付说明里明确：①需要把通道部位名填全（未填会退回旧的全通道 fallback）；
> ②波形柱状图需真实郊狼验证；③覆盖安装不可逆、失败重导修复。建议先修 P1-1/P1-2（改动小、用户症状直接相关），
> P1-3/P1-4 可排到下一批（一个影响极端内容包，一个是人类波形资产生命周期）。

> 2026-11-03 08:19 Lead 已落地 P1-1/P1-2/P1-3/P1-4/P2-5 五个修复；本节判定保留为修复前状态，
> 验收结论以 **§8** 为准（P1-1/P1-2/P1-3/P2-5 复核通过；P1-4 主路径修复、边界仍丢波形）。

---

## 8. P1/P2 修复复核（delta，2026-11-03 08:19–08:35）

### 8.0 范围与独立验证

- delta 对象：5 项修复（`play.ts` P1-1/P1-4、`intents.ts` P1-2、`library.ts` P1-3、`pack-registry.ts` P2-5）
  + 对应测试 + 文档。当前工作区 **23 files +1783/−134**；源码 mtime ≤ 08:18（复核期间未再变化），
  `analysis/ui-v10.md` 08:20 同步了 §1.6 P1/P2 段。HEAD 仍 44d8e1c；本审计员未改代码。
- 本节只复核增量；§7 已确认的架构/安全结论仍适用（本次 delta 未触碰 loop/executor/registry 安全路径）。

**独立验证执行记录（本机 08:21–08:33）**

| 检查 | 结果 |
| --- | --- |
| core `vitest run` | **52 files / 705 tests passed**（与 Lead 报告一致） |
| desktop `vitest run` | **17 files / 224 tests passed**（一致） |
| 两包 `tsc --noEmit` | 均 exit 0 |
| esbuild `main/index.ts`、`dev-server.ts`（`--outfile=/dev/null`，不落盘） | 均 exit 0（604.3 kb / 835.5 kb） |
| `node --check src/ui/play.js` | ok |
| resolver 对抗探针（见下） | primary ready-first / round-robin ready 池 / 全离线 narrative-only / 显式 targets 与 fallback 顺序均符合预期 |
| 人类导入 cap 探针 | 64 个 host 波形后 `importFrames` 抛 `INVALID_WAVEFORM`（新增 P2，见 8.2） |

**resolver 探针输出（关键）**

- A `primary`：`dead`(offline, 先) + `toy`(ready) 同词 → `['toy/a']`（旧实现会静默空命令）。
- B `synced`：命令按 `(beat,device,channel)` 归位为 `['toy/a']`；warning 顺序变为 ready 通道先、离线后（确定性保留，仅顺序变化）。
- C `round-robin`（`dead` 离线 + `toy` 的 a/b）：cursor 0/1/2/3 → `toy/a, toy/b, toy/a, toy/b`；**无 cursor 时 3 次均 `toy/a`**（生产未接线，见 8.2 P2-N2）。
- D 全离线 → `commands=[]`、`narrativeOnly=['b1']`、保留 disconnected warning。
- E 显式 `targets`（zzz/aaa 均 ready）→ 命令按 id 排序 `aaa, zzz`（与 HEAD 行为一致）。
- F region fallback（无匹配）→ id 序 + `degraded:'no-region-match'`（与 HEAD 一致）。

### 8.1 逐项判定

| delta 项 | 判定 | 依据 / 结论 |
| --- | --- | --- |
| P1-1 `targetableRegions` reachable==0 → `[]` | **✅ 正确** | `play.ts:1699-1713`；`worldFacts`/`withPlayableEnums` 因此只给 `whole-body`；`play.spec:1261` 附近已把断言改为 `可用部位：whole-body=…` + `enum=['whole-body']`。边界分析：①freeform 包无 labels 时本来就是 `whole-body` 词表，**无退化**；②部分标注（一个通道有词、另一个空）走 `reachable` 非空分支，菜单只含已标注词，与修复前一致；③已标注+ready 主路径不变。残余：resolver 仍用完整 `ctx.regions`（见 P2-N3）。 |
| P1-2 region matches ready 优先 / round-robin ready 池 | **✅ 正确** | `intents.ts:262`（region 展开 `sortMatches(matches,true)`）、`:350-365`（readyRank 稳定排序）、`:320-330`（round-robin 只在 ready 池轮转）；显式 targets `:250` 与 fallback `:278-282` 不传 readyFirst（探针 E/F 证实顺序不变）。+3 测试：`scenario-resolve.spec.ts:346/438/459`，断言到 device/channel id 级。副作用：`synced` 的 **warning 顺序**变为 ready-first（确定性仍在；commands 最终仍按 id 排序，JSON 稳定）。 |
| P1-3 `addSessionWaveform` 去掉 64 cap | **✅ 正确** | `library.ts:142`（host 路径直接 set）、`:197-205`（`author`/`importFrames`→`addToSession` 仍 64 cap）；`waveform.spec.ts:389` 注册 72 个 host 波形后 agent 路径仍抛 `INVALID_WAVEFORM`（断言 code+message+数量）。开局不再因包波形数失败。新边界：host 波形计入同一 scratch 使人类导入受限（P2-N1）。 |
| P1-4 `start` 不再 `clearSession` | **◐ 部分成立（主路径对，边界仍丢）** | `play.ts:581-588`（start 不清、按 id 覆盖注册；`play.spec:1327` 断言“开局前导入的人类波形跨 start 保留、dispose 丢弃”）；但：①`dispose` 仍 `clearSession()`（`:870`）；②`PlayHost.start` 在开新局前先 `dispose` 上一局 ended 会话（`:1325`）→ **结束一局后在设备页导入的未 promote 波形，下一局开局时仍被清掉**；③开局失败 catch 里 `session.dispose()`（`:1352`）也会清（此时可能根本没开局成功）。测试只覆盖“首局前导入”这一条，未覆盖②③。见 8.2 P1-4R。 |
| P2-5 覆盖安装大小写折叠 | **✅ 正确** | `pack-registry.ts:288`（fold）、`:431/438/449`（incoming/previousFolded/created/stale 均用折叠集合）、`remove` 用 `store.list` 的原 key；`scenario-pack-registry.spec.ts:553` 用 `CaseInsensitiveStore`（read/write/remove 全 casefold、write 记录新 casing）真实复现 NTFS 语义，断言“新字节在、旧 casing key 不在、真正被丢弃的文件仍被删、load 正常”——修复前该测试会失败。残余（文档已注明安全方向）：case-sensitive FS 上仅大小写改名会留下旧文件（见 P2-N6）。 |

### 8.2 新增 / 残余问题清单

**P0：0 项。**

**P1-4R（P1，P1-4 的边界）｜跨局与失败开局仍会清空人类导入的 session 波形**
- 位置：`apps/desktop/src/main/play.ts:870`（dispose 全量 clear）、`:1325`（新局前 dispose 上一局）、
  `:1352`（开局失败 dispose）、`packages/core/src/waveform/library.ts:180-182`（clearSession 全清）。
- 复现流程：①开局 A → 结束（此时 A 的 pack 波形 + 人类导入仍在 scratch）→ 在设备页导入波形 W
  （`importFrames` 写 scratch）→ 开局 B：`PlayHost.start` 先 dispose A → `clearSession` → **W 丢失**；
  ②开局 B 在 `session.start` 中途失败（如 engine/ledger/pack 注册异常）→ catch dispose → scratch 全清，W 丢失。
- 证据：代码路径如上；`play.spec:1327` 只覆盖“首局前导入 → start 保留 → dispose 清”，没有覆盖跨局与失败开局。
- 建议（局部小改）：`PlaySession` 记录本局 `registeredWaveformIds`，`dispose` 只 `removeSessionWaveform(id)`
  移除这些 id（失败开局同样只回滚这些），不要 `clearSession()` 全清；补两条测试（结束一局→导入→开下一局仍保留；
  start 失败保留）。

**P2-N1（P2，新）｜host 注册的包波形占用人类/agent 的 64 槽上限**
- 位置：`library.ts:142`（host 无 cap）与 `:197-205`（`addToSession` 用 `scratch.size >= 64` 判定）共用同一 scratch。
- 现象（已用脚本复现）：注册 64 个 host 打包波形后，`importFrames`（产品“设备页导入波形”入口）与 `author`
  直接抛 `INVALID_WAVEFORM`，错误文案仍是 “reuse one or ask the operator to promote and clear”（对内容包场景误导）。
  P1-3 修好“大包开不了局”的同时，把这类包的人类导入能力挤掉了。
- 影响：包波形 ≥64 时，会话期间（以及结束但未 dispose 期间）人类导入波形失败；普通包（8 个）不受影响。
- 建议：cap 只统计 agent 来源（或用独立计数器/独立 pack 作用域）；错误文案区分 host 与人类路径。

**P2-N2（P2，既有观察，非本次引入）｜`roundRobinCursor` 从未由宿主提供 → round-robin 实际不轮转**
- 位置：`play.ts:resolveContextOf`（`:1765-1788`）没有 `roundRobinCursor`；全仓库仅 `intents.ts:102/328` 与测试使用。
- 后果：生产环境 `cursor===undefined → 0`，`double-strike` 这类 round-robin 意图每回合都命中同一个（ready 池第一个）
  通道；P1-2 的 ready 池逻辑正确但只在测试里被 cursor 驱动。
- 建议：engine 维护一个 turn 计数并注入 cursor（或明确文档化为“当前不轮转”）；否则用户侧“双通道交替”永远看不到。

**P2-N3（P2，残余）｜P1-1 只收窄菜单/枚举，resolver 仍接受非 targetable 的包 region id**
- 位置：`play.ts:946`/`:1281`（enabled 用 targetable）vs `resolveContextOf`（`:1782` 仍传完整 `sessionRegions`）；
  `intents.ts:264-280` fallback 全通道。
- 后果：模型若无视 enum 继续写 `inner-thigh/waist`（例如按包文本惯性），`parseBeatPlan` 仍接受 → 无别名/无精确匹配时
  又 fallback 驱动全部在线通道；P1-1 降低了概率，但没有结构性禁止（尤其未标注硬件场景）。
- 建议：给 resolver 一个 `targetableRegions` 集合（host 注入）——非 wildcard、无别名、不在 targetable 的 region
  直接 narrativeOnly，而不是 fallback；或 parse 阶段把这类 beat 降级。

**P2-N4（P2，文档）｜`analysis/ui-v10.md` §1.3 与 §1.6 自相矛盾**
- 位置：`analysis/ui-v10.md:48` 仍写“没有任何已标注通道时才回退完整包词表”，而 §1.6（08:20）已改为返回空。
  建议同步 §1.3（并把 §4 #4 的“fallback 可见”说明按 P1-1 后的残余限定）。

**P2-N5（P2，边界）｜直接调用 `PlaySession.start` 失败时 pack 波形残留 scratch**
- 位置：`play.ts:581-588`（start 注册）与 `PlaySession.start` 的 finally 没有回滚；产品路径 `PlayHost.start`
  有 catch dispose（`:1352`），但直接使用 `PlaySession` 的调用方（测试/嵌入式）会留下本局已注册的 pack 波形，
  下一次同实例重试/换包可能看到旧包 id（host library `get` 可命中）。
- 建议：在 `openSession` 的 catch/finally 里回滚本局注册的 id（与 P1-4R 的 `registeredWaveformIds` 同一机制）。

**P2-N6（P2，文档化残余）｜case-sensitive FS 上仅大小写改名不再删除旧文件**
- 位置：`pack-registry.ts:288/449`（fold 后旧 key 视为 overwritten/非 stale）。
- 后果：Linux 上 `phases/Resist.md → phases/resist.md` 会保留两份；不影响加载（多出的文件对声明的 phase/waveform
  可能被扫描到），也不会误删。Windows 目标已由测试覆盖。建议把该行为写进包制作说明（或 Linux 下写入前按 folded
  key 精确清理，仅在 `process.platform` 分支做）。

**§7 未在本轮处理、仍开放的 P2**：P2-1（纠偏轮 timeout/abort 未 await settleDispatch）、P2-2（纠偏消息形状未在真实
provider 验证）、P2-3（两次 prose-only 仍静默无 plan/无审计）、P2-4（纠偏有 plan 无正文时回灌旧正文）、
P2-6（覆盖安装半新半旧无 UI 恢复提示）、P2-7（别名子串歧义）、P2-8（ui-v9/ui-v6 文档漂移）；**P1-5（真实郊狼 BLE 未验）
仍开放**。

### 8.3 测试是否真覆盖（delta 新增/修改）

**真断言（不是只跑通）**

- P1-1：`play.spec.ts:1261`（unlabelled harness）断言 `可用部位：whole-body=…`、`已就位部位：无`、
  `regions enum===['whole-body']`，并继续用真实 registry+executor 断言 `run_pattern` 全 ok——**测试真的把旧行为
  （inner-thigh 进菜单）反过来断言了**。
- P1-2：`scenario-resolve.spec.ts:346`（round-robin：cursor 0/1/2 → a/b/a，离线通道不参与）、`:438`
  （offline 排前的 primary → `toy/a`、无 disconnected warning）、`:459`（全离线 → narrativeOnly+warning），断言到
  device/channel id 级。
- P1-3：`waveform.spec.ts:389`（72 个 host 可注册 + agent `author` 仍 `INVALID_WAVEFORM` 且消息含 64），
  真实验证了“host 无 cap、agent 有 cap”这一不对称契约。
- P1-4：`play.spec.ts:1327` 断言 importFrames 波形跨 start 保留、dispose 后 `get` 为 undefined——只覆盖首发路径（见 8.2 P1-4R）。
- P2-5：`scenario-pack-registry.spec.ts:553` 的 `CaseInsensitiveStore` 真实模拟 NTFS 的 write/remove/list casing 语义；
  断言新字节、旧 key 删除、真正 stale 文件清理、`registry.load` 成功。修复前该用例会失败，属于有效回归测试。

**测试缺口（对应 8.2）**：P1-4R 的跨局导入/失败开局；P2-N1（host 波形挤占人类导入 cap）；P2-N2（生产 cursor 未接线）；
P2-N3（模型不遵守 enum 的 resolver 兜底）；P2-N5（直接 API 失败回滚）；case-sensitive FS 的别名/大小写残留；
真实 provider 纠偏（P2-2）与真实 BLE（P1-5）。其余全量测试、tsc、esbuild 均通过（705/224，0 error）。

### 8.4 结论

- delta 五项中 **P1-1 / P1-2 / P1-3 / P2-5 正确**，逻辑与测试都成立；**P1-4 主路径正确、异常/跨局边界仍会丢人类导入波形**
  （P1-4R，P1 残余，但**不是**两个用户诉求的阻断项）。
- **无 P0**；新增/残余为 1×P1（P1-4R）+ 5×P2（N1/N2/N3/N4/N5，另有 N6 为已文档化的安全取舍）+ §7 未处理的 P2。
- **给出“可交付（真机回归除外）”结论：认可。** 两项用户诉求（导演/部位闭环、内容包覆盖导入）已闭环，且本 delta
  修复了前一轮遗留的未标注 fallback、离线 primary、>64 波形开局失败、大小写覆盖误删；剩余项不影响这两项交付。
- **交付说明需补三条已知限制**：① P1-4R——结束一局后在设备页导入的未 promote 波形，下一局开局会被清（可先
  promote，或等后续“只移除本局 pack 波形”的小修）；② round-robin 意图当前不会真正轮转（P2-N2，既有问题）；
  ③ 未标注硬件时以 `whole-body` 驱动全部在线通道（P1-1 后的预期行为，不再伪造包 id）。
- 若要顺手消除 P1-4R：按 8.2 的 `registeredWaveformIds` 方案做局部修改（dispose/失败回滚只删本局注册的 id），
  并补两条测试即可；其余 P2 可排后续迭代。

---

### 8.5 最终 delta 复核（P1-4R / P2-N1 / P2-N2，2026-11-03 08:25–08:40）

> 本节只复核 Lead 最后一轮增量；§8.4 的结论由本节更新（P1-4R/P2-N1 已闭环；P2-N2 主路径闭环但有边缘推进问题）。

**范围与独立验证**

- 源码 mtime ≤ 08:25/08:26（此后冻结），工作区 **23 files +1987/−135**；`analysis/ui-v10.md` 08:28 已同步
  §1.3/§1.6（上一版的 P2-N4 矛盾已修）。HEAD 仍 44d8e1c；本审计员未改代码、未 commit。
- 本机独立复跑：**core 52 files / 706 tests**、**desktop 17 files / 226 tests**、两包 `tsc --noEmit` 均 0
  （与 Lead 数字一致）；`node --check src/ui/play.js` ok。main/dev-server 构建由 Lead 复跑（本 delta 未改构建入口）。

**逐项判定**

1. **`removeSessionWaveform` + `hostRegistered` 记账（P2-N1）— ✅ 正确**
   - 不变式检查：`hostRegistered ⊆ scratch` 在 add/remove/promote/clear 四处都同步维护
     （`library.ts:142-171/190-210`）；`promoteByHuman` 转 durable 时同步移除记账（durable 资产不会被会话边界误删）；
     `removeSessionWaveform` 对未知 id / 重复 id / durable builtin（`tide`）均为安全 no-op（`waveform.spec.ts:389`）；
     cap 只统计非 host 条目（`agentScratchCount`，`library.ts:244-252`），72 个 host + 1 import + 63 author 后第 65 个
     agent/human 写入才失败，host 资产不受影响（`waveform.spec.ts:408`）。**未发现记账不一致或 cap 回归。**
   - 理论 API 边角（非产品路径）：若 host 注册 id 与既有 human/agent scratch id 相同，会被标记 host 并在会话结束删除；
     但包波形 id 带 `:` 命名空间、human/agent id 经 slugify 不含 `:`，实际不会冲突。
2. **`packWaveformIds` + dispose 只删本局包波形（P1-4R）— ✅ 主路径与已知边界均修复**
   - `play.ts:410-420/605-612` 按 id 去重记账、`start` 重置；`dispose`（`:889-898`）只 `removeSessionWaveform`
     这些 id 并清数组，不再 `clearSession`；host shutdown 仍 `clearSession()`（`bootstrap.ts:1602`，人类 scratch 终点）。
   - 失败开局：before-registration 失败 → 清单为空 no-op；after-registration 失败 → `PlayHost.start` catch 的
     `dispose()` 只回滚本局包波形；跨局（ended 旧会话 dispose）也不再清人类波形。二次 dispose 空数组 no-op。
   - 测试：`play.spec.ts:1352`（跨 start/会话边界保留人类波形）、`:1370`（下一局开局 dispose 旧会话仍保留人类波形）。
   - 残余：**直接调用 `PlaySession.start`（不经 PlayHost）失败时无自动回滚**——P2-N5 仍开放；ui-v10 §1.6
     “失败开局也能回滚”严格说只对 PlayHost 产品路径成立（建议文案限定，或把回滚放进 openSession 的 catch）。
   - 测试缺口：没有“同一局包波形 + 人类导入，dispose 后只删包波形、人类保留”的端到端混合用例；失败开局保留人类波形
     也无用例（库单测覆盖 remove-only 语义，端到端仍缺）。
3. **round-robin 跨回合轮转（P2-N2）— ⚪ 主路径正确，推进策略有边缘 bug（P2-R1）**
   - 主路径：宿主每回合传 `roundRobinCursor`（`play.ts:975-985/1824-1842`），reset 于 start；1 个 RR beat/回合时
     实测轮转为 a→b→a→b（`play.spec.ts:1460` 断言 a→b）。**此前宿主从不供 cursor 的问题已修**。
   - **P2-R1（新，P2）**：`advanceRoundRobinCursor`（`play.ts:1157-1169`）按“本回合 RR beat 数”推进，但 resolver
     对同一 plan 内所有 RR beat 只用一个 cursor → 多 beat/plan 时推进步数与 reselect 步数不一致：
     实测 2 RR beats/plan、pool=2 → 每回合 `a+a`，**跨回合永不轮转**（cursor 0→2→4，恒 %2=0）；
     no-plan 回合 `+1` 与 pool=2 组合也会把下一 RR 回合拉回上一通道（实测 a → no-plan → a → b）。
     建议：**每回合最多 +1**（且仅在本回合确有 RR beat 被 dispatch/存在时），或长期改为 per-beat cursor；
     补两条测试（2 beats/plan 跨回合、no-plan 后下一 RR 回合）。属边缘策略问题，不影响主路径与安全。
   - hard-fail（`runOneTurn` 抛错）不推进 cursor——ui-v10 §4 #6 已记录，可接受。
   - 文档 nit：`intents.ts:101` 注释仍写“Held by the engine”，实际由 host 持有（P3）。
4. **安全/确定性** — 无回归：`removeSessionWaveform`/`hostRegistered` 都是 host-only API、不可被 agent 调用；
   resolver 仍是纯函数（cursor 由宿主每回合传入，会话内确定、start 重置）；LOCKED / cap / percent 映射 /
   不伪造玩家选择 / 台词不入控制 / executor 只吃 plan 均未改动；本次 delta 不改执行器与安全边界。

**最终结论**

- P1-4R（跨局/失败开局清人类波形）✅ 闭环（除直接 `PlaySession.start` 的 P2-N5 边角）；P2-N1（host 波形挤占
  agent/human 64 槽）✅ 闭环；P2-N2（round-robin 不轮转）⚪ 主路径闭环、多 beat/no-plan 推进为 P2-R1 边缘残留。
- **最终：可交付（真机回归除外）**。
- **残余清单（不阻塞交付）**：
  1. P2-R1：round-robin 在多 RR beat/plan 或 no-plan 回合穿插时的推进边缘（建议每回合最多 +1，补 2 测试）。
  2. P2-N5：直接 `PlaySession.start` 失败不自动回滚包波形（产品 PlayHost 路径安全；ui-v10 措辞可收窄）。
  3. P2-N3：resolver 仍接受非 targetable 包 region id → 模型无视 enum 时仍可能 fallback 全 ready 通道
     （效果框如实显示，caps/LOCKED 兜底）。
  4. P2-N6：case-sensitive FS 仅大小写改名保留旧文件（已文档化的安全取舍）。
  5. P1-5：真实郊狼/BLE 波形端到端未在开发环境验证（真机回归项）。
  6. §7 遗留 P2：纠偏轮 timeout/abort 未 await settleDispatch、纠偏消息形状未真机验、两次 prose-only 静默、
     旧正文回灌、覆盖安装半新半旧提示、别名子串歧义、ui-v9/ui-v6 文档漂移。
  7. 测试缺口：包波形+人类导入混合 dispose、失败开局保留、多 RR beat/plan、no-plan→RR 交替；文档 nit：
     `intents.ts:101` “Held by the engine”。
