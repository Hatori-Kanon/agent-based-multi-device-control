# M2 波次一独立审查 · 模块级（契约/纯函数方向）

- 审查对象：`HEAD eff3966`（39 文件，+9121/−24）。只读；未改源码/测试/文档。工作区另有 `sensors/look.ts`、`scenario/pack-registry.ts` 等**未跟踪文件**，属其他波次，不在本次范围。
- 验证：`packages/core` 26 文件 **406 tests 全绿**（23:32 运行，未含未跟踪 spec）；`tsc` 未重跑（只读）。
- 方法：`git show` 逐行 + `/tmp` 探针（semver 28 组手算、`parseBeatPlan` 18 组敌意输入、loader 结构探针、ceiling 探针、SSE/事件用例杀伤力推演）。证据均为 `文件:行` 或探针输出。

## 0. 模块结论速览

| 模块 | 证据 | 结论 |
|---|---|---|
| sensors/types.ts | 1-152；`FeatureSample/SensorSource/Snapshot/SensorStatus` 与 §4.1 一致 | 干净 |
| sensors/imaging.ts | 229-289；`nowMs` 窗口 248-260（`<=1000`，§8.7 #1 一致）；2 帧降级 263-267 与注释一致 | 干净；`MotionState` 字段漂移见 R2 |
| sensors/ring-buffer.ts | 143-152；`stats` 无样本 `undefined`；`== retainMs` 保留（严格小于才丢） | 干净；边界无用例 S6 |
| sensors/registry.ts | 99-120；不读 `source.freshnessMs()`（§8.7 #5 一致）；空源 `[]` | 干净；quality 优先级见 R6 |
| scenario/beat-plan.ts | 246-256 永不抛；58-68、496-509、613-624 | `change.texture` 漂移 R1；模型可写 turnId/phase R3；durationSec 越界接受 R4 |
| scenario/intents.ts | 144-162、588-594；无时钟/随机/环境读取；`planId` 564-582 纯函数 | 纯函数与排序覆盖成立；跨设备排序无用例 S9 |
| scenario/default-intents.ts | 24；全仓库唯一换算表（grep 确认） | 40/70/100 正确 |
| scenario/semver.ts | 142-148；28/28 手算通过（见 §4） | 正确；过度接受见 S2 |
| scenario/validate.ts | 349-392、463-464、660-667 | severity 与 §8.7 一致；无放宽 |
| scenario/loader.ts | 369-370、421-430、475-489、495-505 | **阻塞 B1/B2** |
| scenario/phases.ts | 122-130；50/80/90 闭区间（恰等即命中） | 干净；状态机按契约本就有状态 |
| agent/model.ts | 28-136 与 §4.9 同形；增量仅 `ModelError`/`apiKeyEnvOf` | 干净 |
| agent/transport.ts | 82-149、196-288、456-465 | 无定时器泄漏；尾路径 sentinel 缺判 R7；零网络 ✓ |
| agent/adapters/openai-compatible.ts | 187-242、282-314 | 回退链/能力缓存正确；`as unknown as` 债务 §8.7 B5 |
| devices/events.ts | 31-42 | 与 §4.2 一致；`durationSec` 增量未登记 S3 |
| index.ts | 232-342 | 无重复导出（330 名/88 块，脚本核对）；`FeedbackIntent` 仅 1 处；头部注释过期 S8 |

## 1. 阻塞（2）

**B1 · `loadPack` 对结构非法的 `feedbackIntents` 抛出裸 `TypeError`，不是 `ContentPackError`**
- 证据：`loader.ts:369-370` 只判 `Array.isArray(scenario.feedbackIntents)`，未判元素是对象；`const reference = intent.suggest?.waveform` 在 `intent === null` 时崩。探针：`{"feedbackIntents":[null]}` → `TypeError: Cannot read properties of null (reading 'suggest')`。调用点 `loader.ts:488` 早于错误抛出处 `495-505`。
- 影响：违反本模块文档 `@throws {ContentPackError}` 与 `scenario-loader.spec.ts:150` 的用例宣言（"never a TypeError"）；导入 UI 若 `catch (ContentPackError)` 会漏接并崩溃；错误不带 file/path，issue 列表丢失。
- 建议改法：在 `checkWaveformReferences` 内用 `if (typeof intent !== 'object' || intent === null) continue`（与 `phaseNotes` 循环 483-484 的防御一致）；或在 `loadPack` 里把所有非 `ContentPackError` 包装成 `ContentPackError{file:'scenario.json'}`。

**B2 · 先 stat/read、后校验路径：`..` 清单项在被拒绝前已被读取**
- 证据：`loader.ts:421-430` 对 `list()` 全量调 `byteSize`；`475-489` 先跑 `loadWaveforms`/`phaseNotes`，`495` 才因 `validateFiles` 的错误抛出。探针（RecordingSource）：清单含 `waveforms/../../outside.json` 时调用序列为 `size:pack.json, size:persona.md, size:waveforms/../../outside.json, text:pack.json, text:persona.md, text:waveforms/../../outside.json` —— 该越界路径被**读取**，之后才 CPE。
- 影响：`ports/content-source.ts:10-13` 明确声称"loader 在读任何东西前就拒绝绝对路径、`..` 与控制字符"，实际不成立；宿主导入器若按字面映射路径（core 无法看 symlink，§8.7 #6 已把符号链接交给 host），即为包可控路径的根外读取。校验结论仍是拒绝（fail-closed），故不是数据外泄，但防线顺序错误。
- 建议改法：`loadPack` 开头先对 `[...files]` 跑 `pathProblem`/扩展名检查（把 `validate.ts` 的 path 检查提为导出的小函数），任一路径不合法立即 CPE，再 stat/read；`loadWaveforms`/`phaseNotes` 只在 `errors.length === 0` 后执行。

## 2. 应修（8）

**R1 · `BeatChange.texture` 缺失：§4.3 与实现/§4.9 自相矛盾**
- 证据：§4.3（`M2-实施计划.md:558-563`）在 `BeatChange` 上有 `texture?: WaveformModulation`；实现 `beat-plan.ts:58-68` 没有该字段，`499/506` 的 known-keys 也不含 `texture`。探针：`change:{kind:'waveform',…,texture:{rate:1.5}}` → `warnings:['beat b1: unknown change field "texture" was ignored']`，字段被丢。
- 影响：冻结契约的字段在"契约与校验器"交付里缺失；模型/剧本按 §4.3 写的 `change.texture` 被静默忽略。而 §4.9 的 `apply_plan` schema 只把 `texture` 放在 beat 级——两个契约源不一致，D16"只解析与校验"未覆盖 change 级。
- 建议改法：二选一——(a) `BeatChange` 补 `texture?`，`parseLevelChange`/`parseWaveformChange` 复用 `parseTexture`（`intents.ts:362-376` 已优先读 `beat.texture`，可再取 `change.texture`）；(b) 判定 §4.3 该行为笔误，删掉它并在 §8.7 登记。禁止两处契约并存。

**R2 · `MotionState` 由 §4.1 的 3 字段扩为 7 个必填字段，未登记**
- 证据：§4.1（`M2-实施计划.md:348`）为 `{ema,peak,peakAt}`；实现 `imaging.ts:32-47` 增加 `lastAt/frames/peakFrame/clocked` 且**非可选**；§8.7 #1 只记录了第 4 参 `nowMs`。
- 影响：按 §4.1 写宿主采集端（A1-T5）会在类型层面报错；纯函数签名漂移未进偏差表。
- 建议改法：把新增字段标 `?`（实现里全是 `?? 0`/`?? false` 的读取，改可选零成本），或在 §8.7 追加 R2 并同步 §4.1。

**R3 · `parseBeatPlan` 信任模型给的 `turnId`/`phase`**
- 证据：`beat-plan.ts:300-314` 从 raw 读取；§4.3/§4.9 均写"引擎注入，模型不写"（tool schema 不含这两个字段）；`planId`（`intents.ts:564-566`）与 `plan_resolved` 的 `turnId` 都取自它。
- 影响：若 B1-T10 以 `parseBeatPlan(modelArgs)` 直接入队，模型可伪造 turnId（审计归属/回放）与 phase（`phases.ts:141-145` 的漂移提示被绕过；仅提示，非硬约束）。
- 建议改法：契约层明确"调用方必须先合并引擎字段且引擎值覆盖模型值"，并补一条 B1-T10 用例；或 `parseBeatPlan` 忽略 raw 的这两个键、由调用方 `{...plan, turnId, phase}`。

**R4 · level change 接受 `change.durationSec` 作为保持时长，超出 §4.3 授权**
- 证据：§4.3 只对 `kind='waveform'` 写 `durationSec: 1..600`（`beat-plan.ts` 接口注释 66 行也自认"also accepted on level"）；`parseLevelChange` `560-573` 接受 1..600，`intents.ts:384-385` 用它当 level 保持时长。用例 `scenario-beat-plan.spec.ts:236-243` 固化该行为。
- 影响：模型可让一条 level 指令保持 600s（仍受 `maxDurationSec` 夹紧），与"level=steady 瞬时档位"的契约读法不符；审计里 `durationSec` 语义模糊。
- 建议改法：要么在 §4.3/§4.9 正式加"level change 可带 durationSec（保持时长）"并给上限，要么拒绝该字段。

**R5 · 会话上限 X 只接到 Coyote BF，`RegistrySnapshot`/夹紧仍用 `get()`，§4.4 "maxPercent 已含 X" 当前为假**
- 证据：`policy.ts:156-158` 的 `get()` 不含 X，`effective()` 203-206 才取 min；仅 `bootstrap.ts:320-321`（Coyote）调 `effective`；`registry.ts:653`（snapshot）、`761-762`（write 夹紧）、`785`（prepare）全用 `get()`。探针：cap=80、X=30 时 `snapshot().maxPercent === 80`，`setLevel(80)` 被接受并生效。
- 影响：目前无 UI 路由调用 `setSessionCeilingByHuman`（B2-T9 才做运行时执行），故非现网漏洞；但 §4.4 的括号句已写"已含 X"，B1-T16 若照此实现会把未夹紧快照当有效上限，非 Coyote 后端不受 X 约束。
- 建议改法：`registry.snapshot()`/`write()`/`prepare()` 改用 `policy.effective()`（一处 3 行），或在 §4.4/§1.4 I2 明确标注"X 的运行时执行归 B2-T9，当前快照不含 X"；`apps/desktop/tests/policy-file.spec.ts:61-63` 只断言 `effective()`，应补一条设备级断言。

**R6 · `unavailable` 质量会被 3s 后的 `stale` 覆盖，§8.7 #5 的"push 一条 unavailable"机制 3s 后失效**
- 证据：`registry.ts:105-109` 的优先级是 `freshness >= staleAfter` → `'stale'`，否则 `newest.quality`；`sensors-registry.spec.ts:77-89` 未覆盖"pushed unavailable + 3s"。
- 影响：拔 USB 后若只推一条 `quality:'unavailable'`（§8.7 #5 的写法），3s 后投影说"stale"而非"unavailable"，与 `SensorQuality` 文档语义（`types.ts:19-23`）不符；A1-T5/投影波次会踩到。
- 建议改法：优先级改为 `newest.quality === 'unavailable' ? 'unavailable' : freshness…`，或改 §8.7 #5 为"持续推 unavailable 样本"并补用例。

**R7 · SSE 尾路径不判 `[DONE]`**
- 证据：`transport.ts:258-264`（末尾残行）与 `254/262` 都判 `isDoneSentinel`，但 `266-271`（流结束时 `dataLines` 非空）直接 `yield`。若上游最后一条事件缺尾随空行（`…data: [DONE]` 后直接 EOF），`[DONE]` 会作为 payload 进入 `ChatCompletionAccumulator`，`parseJson` 抛 `invalid-response`。
- 影响：只影响"无尾空行"的异常上游；正常 SSE 每事件以空行结束，故现网概率低，但三条尾路径行为不一致。
- 建议改法：`266-271` 的 `yield` 前加 `if (isDoneSentinel(payload)) return`；补一条"EOF 紧接 `data: [DONE]`"用例。

**R8 · `state/policy.json` 键用第一个 `:` 还原，deviceId 含 `:` 时把 cap 恢复到错误设备**
- 证据：`policy.ts:209-215` 编码 `device\0channel → device:channel`；`248-254` `decodeSnapshotKey` 以首个 `:` 切分。`decodeSnapshotKey` 不校验 device 段；`bootstrap` 的设备 key 来自可手改的 `devices.json`（`bootstrap.ts:201` 只校验非空字符串）。
- 影响：若某设备 key 含 `:`，重启后 A 的收紧 cap 会被挂到 B（A 回默认、可能更宽）——静默 fail-open；正常 slug key 不受影响。
- 建议改法：`setByHuman`/`decodeSnapshotKey` 拒绝含 `:` 的 deviceId（或在编码时用 `\0`→`:` 且 deviceId 校验 `[a-z0-9-]+`）；补一条往返用例。

## 3. 建议（6）

**S1 · region severity 文档冲突**：实现按 §8.7（`validate.ts:660-667` `intent.region-undeclared`=error）✓，但 §4.6 表 row 8（`M2-实施计划.md:897`）仍写 warning；修文档，别让下一波按旧表写用例。**这正是安全相关校验没有被放宽的证据**（探针：未声明 region → CPE）。
**S2 · `satisfiesVersion` 过度接受**：`semver.ts:125-129` 把精确 `"1.2"` 当 `1.2.0`（注释只承诺 `x.y.z`）；`106-115` 重复比较符后者覆盖前者（`">=2.0 >=1.0"` → lower=1.0，npm 语义应为 2.0）。建议收窄或写入注释+用例。
**S3 · 长字符串放大**：`beat-plan.ts:204-221` 的 `describe()` 把整个 2M 字符的 `intentId` 原样拼进 `dropped[].reason`（探针：不抛、0ms，但内存/审计体量被放大）。建议截断 300 字符（transport 已有 `snippet` 模式）。
**S4 · SSE/传输覆盖空白**：多行 `data:` 拼接（实现于 212、266）、CRLF（209）、`text()` 兜底（178）、Unicode 跨 chunk 均无用例；`FakeClock.pendingCount` 全仓库未被使用——成功/abort/timeout 后断定时器无泄漏缺用例（代码 `finally` 已 `timer.cancel()`，属回归防护缺口）。
**S5 · 波形 id 前缀不闭合**：`loader.ts:372-373` 的 `checkWaveformReferences` 用**未加前缀**的 localId 判存在，`LoadedPack.waveforms` 却已加 `<packId>:`（`loader.ts:525`）。B1-T16 若直接用该库，`suggest.waveform:"tide"` 会全部 unknown-waveform；统一映射或让引用检查用前缀。
**S6 · 测试永真断言**：`scenario-default-intents.spec.ts:148-153` 在 138-144 已精确 `toEqual` 后再对同一常量做 `>0`/`<=1` 不等式（恒真冗余）；同文件 92 行 `if (waveform !== undefined)` 是可跳过的条件断言；`index.ts:4-7` 的"M0 scope"注释已过期；`CapabilityCache.get`（openai-compatible.ts:67-69）直接返回共享常量对象，类型只读但运行时可被改。

## 4. 数值边界（手算 28/28 全过）

| 组 | 断言 | 结果 |
|---|---|---|
| `>=0.2 <1.0` | 0.2.0✓ 0.1.9✗ 1.0.0✗ 0.99.99✓ | 通过 |
| `^0.2.3` | 0.2.3✓ 0.2.9✓ 0.3.0✗ 0.2.2✗ | 通过 |
| `^0.0.3` | 0.0.3✓ 0.0.4✗ | 通过 |
| `^0.1` / `^0` | 0.1.9✓ / 0.9.9✓、1.0.0✗ | 通过 |
| `^1.2.3` / `^1.2` | 1.2.2✗ / 1.9.0✓、2.0.0✗ | 通过 |
| `~1.2` / `~1` / `~0.2.3` | 1.2.0✓ 1.3.0✗ / 1.9.9✓ / 0.2.9✓ 0.3.0✗ | 通过 |
| 精确 / 单比较符 | `1.2.3`✓、`1.2.4`✗、`>=0.2`✓、`<1.0` 边界✗ | 通过 |

- `FeatureRing`：`prune` 用 `sample.ts < now - retainMs`（`ring-buffer.ts:143-152`）→ **恰等于 retainMs 保留**，与注释"strictly older"一致；无用例锁定该边界（S6 同类空白）。
- `PhaseMachine.at`：`>=` 语义（`phases.ts:122-130`），0.5/0.8/0.9 恰等即命中，`phaseWindows` 无关；用例 58-72 已逐点锁定，含 NaN/1.4。✔
- `analyzeFrame`：给 `nowMs` 时 `now - peakAt <= 1000`（`imaging.ts:248-260`）恰等保留，与 §8.7 #1 "≤1000ms" 一致；不给时 `frames - peakFrame < 2`（263-267）即"当前 + 上一帧"，与注释一致。恰等 1000ms 无用例。

## 5. 测试质量：变异杀伤力（红/绿 + 空白）

| 变异 | 会红 | 不会红（空白） |
|---|---|---|
| `parseBeatPlan` 改为抛错 | 非对象输入（`scenario-beat-plan.spec.ts:131-138`，无 try 直接取值）、空 beats（184-189）、非法 pacing（140-147）等直接取值型用例全红 | **仅对"深层嵌套/抛错 getter/cyclic/2M 字符串/坏 ctx"抛错的变异全绿**（这些输入无用例；本次探针补测 18 组均不抛，属实现正确、测试未锁） |
| `resolvePlan` 排序打乱 | 字节稳定用例 `147-153`（断言 keys 有序 + `['a','b','a']`）会红；region 路由 247 也会红 | **跨设备次序未锁**：无"两台 ready 设备同时有命令"的用例（349 行只有一台 ready），只按 channel 排序的变异可通过 |
| region 检查降为 warning | `scenario-validate.spec.ts:105-111`（断言 error `intent.region-undeclared`）必红；若去掉 `parseBeatPlan` 的 region 过滤，`scenario-beat-plan.spec.ts:193-219` 红 | 无（validate 侧已锁；但 loader 侧无"未声明 region 必须拒绝加载"的端到端用例） |
| semver `^` 实现错 | `^` 当 `~`（1.9.0 应 true→红）、0.x 上界错（`^0.2.0` 接受 0.3.0→红）、上界为下一 patch（`^1.2.3` 拒 1.9.0→红） | **缺下界断言**：`^1.2.3` 接受 1.0.0、`^0.2.3` 接受 0.0.1 的变异全绿；`~1.2`/`~1` 部分形式、`^0.2` 部分形式无覆盖 |

其他：`scenario-resolve.spec.ts:156-163` 的"注入 line 后输出相同"是有效断言；`140` 的 `JSON.parse(JSON.stringify())` 往返只覆盖同键序；`scenario-loader.spec.ts:150` 的"never a TypeError"宣言与 B1 实测不符（宣言宽于用例）。

## 6. 导出面 / `any`·`as` 清单

- `index.ts`：88 个 export 块、330 个导出名，**无同名值/类型重复**；`FeedbackIntent` 仅从 `scenario/intents.ts` 导出一次（loader 只 import type）。§4.1/§4.3/§4.4/§4.6/§4.9 列出的签名均有导出；增量（`isSensorError`/`*Options`/`ModelError`/`apiKeyEnvOf`/`CapabilityCache`/`DEFAULT_CHECKPOINTS` 等）与 §8.7 #10 一致。
- `any`：新模块 **0 处**。`as unknown as`：`transport.ts:117,165`（FetchLike 端口债务，§8.7 B5 已登记）、`loader.ts:445,462`（JSON.parse 的受检前置，validate 兜底）、`validate.ts:82,173,399`（typeof 守卫后，必要）。可消：`loader.ts:310` 的 `segmentsField as readonly WaveformSegment[]`（可传 unknown 给校验器）、`policy.ts:295-297` 三个 `as number`（可由 `assertValidPolicy` 直接收 unknown）。非空断言仅 `phases.ts:76`、`policy.ts:212`，均已被前置条件保证。

## 结论

本波次纯函数纪律与排序/字节稳定成立（`resolvePlan` 两次调用逐字节相同、输入未被改写；无时钟/随机/环境读取），semver 28/28、门禁 severity 未被放宽、网关测试零网络（仅 `stubFetch`/`RecordingFetch`）。但 `loadPack` 存在 **1 个裸 TypeError** 与 **1 处"先读后校验"的路径顺序缺陷**，另有 8 条契约/边界应修项；逐条闭合（B1/B2 必修，R1-R8 至少登记偏差）后可放行。**是否可放行：否（2 阻塞 + 8 应修；无安全校验被放宽，B1/B2 修完即可复评）。**
