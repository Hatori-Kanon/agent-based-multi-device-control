# M2 波次三 · 感知与契约方向独立审查（只读）

- 审查对象：commit `043c62d`（`git show 043c62d -- <file>`）。当前工作区 HEAD 已是 `f3aea94`，且 `probe.ts`、`turn-engine.ts` 等有未提交的并行产出（如 A2-T3 的 `auditDetail`）；本报告一律以 `git show 043c62d` 为准，不把未提交改动计入结论。
- 验证：审查开始时（23:52，`probe.ts` 尚未被并行改动）按任务给定命令跑过 `packages/core` **509 passed**、`apps/desktop` **108 passed**，与 commit 声明一致；此后树被并行任务改动，故未复跑，也未复跑 tsc。
- 安全前置结论：**未发现密钥泄漏，也未发现安全校验被放宽**（详见 Q6），无需"立刻上报"项。

## 阻塞

### B-1 缺失模态被当 0 参与 delta，可伪造 `responded`（`packages/core/src/sensors/probe.ts:289-291, 353-366`）

- 代码：`mergeWindowStats` 对缺失一侧用 `?? 0` 填 0（:361-364），而同一函数注释（:350-351）写的是"a source of one kind never invents the other's numbers"，与实现相反；`evaluate` 的可比性只要求 `baseline.samples > 0 && window.samples > 0`（:289），而 `samples` 是两模态的 `Math.max`（:359）。
- 后果：某模态"窗口有样本、基线无样本"时，基线被当成**实测 0**，delta 虚高。实测复现（FakeClock + 默认阈值）：cam 样本 @2000/@3000，mic 样本 @1000（2s 前，源仍 `ok`）与 @3100，action=3000 → `baseline` 只来自 cam、`baseline.audioLevelMeanPct=0`，`window.audioPeakPct=40` → `delta.audioPct=40`、verdict=`responded`；而麦克风基线根本没有样本。同一条 `baseline` 还会被原样写进审计 detail，读起来像"实测静音"。
- 反方向同样有害：`baselineAudioMaxPct` / `baselineMotionMax` 门控对缺失侧读 0，本应 `ambiguous` 的高基线会被放过。
- 纯 image-only / audio-only 不受影响（0-0=0，或另一侧本来就该为 0）；危害只在"分源 + 某模态只覆盖一侧窗口"。这正是 §4.2"两者可来自不同源"的常规情形。
- 修法：delta 与高基线门控按模态分别要求两侧样本数 >0；某模态只有一侧有样本时不参与 `responded`，且 verdict 至少 `ambiguous`（`degenerate` 或新增 reason）。补"image+audio 混合、音频仅窗口/仅基线"两类用例。
- 注意：现有测试把 0 填充写成了期望——`packages/core/tests/sensors-probe-thresholds.spec.ts:124`（image-only 时断言 `delta.audioPct` 为 0）、`packages/core/tests/sensors-probe.spec.ts:234-236`（断言 motion 为 0），修 B-1 时这两处必须一起改。

## 应修

### Y-1 S5 只在 loader 面闭合，"校验通过 ⇒ 运行时能解析"不成立（`packages/core/src/scenario/loader.ts:382-398, 408-427`；`packages/core/src/scenario/intents.ts:531-551`）

- loader 的 resolver 接受三种写法：裸包内 id → `<packId>:<id>`、`<packId>:<id>`、`builtin:<id>`（loader.ts:387-396）；`checkWaveformReferences` 与 `LoadedPack.resolveWaveform` 共用同一个 resolver（:405-427），所以"warnings 为空 ⇔ resolver 能解析"是**同义反复**，不是运行时保证。
- 运行时仍是 `resolvePlan` 里的 `ctx.waveforms.get(waveformId)`（intents.ts:539）。`WaveformLibrary` 默认只装**无前缀**的内置 id（`packages/core/src/waveform/library.ts:78-94`），pack 波形进库是 `<packId>:<id>`。实测：`new WaveformLibrary().get('builtin:tide')` → undefined、`.get('gentle')` → undefined、`.get('tide')` 命中。
- 因此恰好相反：**校验接受的** `builtin:tide`、裸包内 id `gentle` 在运行时会 `unknown-waveform` 降级；**校验只告警的**裸内置 id `tide` 反而命中。仓库里没有任何生产代码调用 `pack.resolveWaveform`（grep 只有 loader 与测试）。
- `packages/core/tests/scenario-loader.spec.ts:247-277` 的 `it('guarantees that every accepted suggest.waveform resolves at runtime')` 名不副实：它从未调用 `resolvePlan`，断言的两件事由同一 resolver 决定，构造上不可能失败。
- 结论：commit 里"a local waveform id resolves at runtime"不能采信，S5 不应记为已闭合。修法：load 时把 `suggest.waveform` 归一化成运行时 id，或 B1-T16 组装 `ResolveContext` 时先过 `resolveWaveform`；并补一条走 `resolvePlan` + `WaveformLibrary` 的集成测试。

### Y-2 verdict/reason 枚举与 §2.3/导演契约不一致（`probe.ts:24-31, 294-312` vs `感知闭环与控制分离-设计草案.md:97-115`、`导演与写作上下文契约.md:120-131`）

- 实现与 §4.2 一致（`unavailable`；reason=`no-source|stale|baseline-high|degenerate`），但草案 §2.3 与导演契约 §5（D21 冻结）写的是 `off-body` + `motion|baseline|quality`。§8.1/§8.7 没有记录这次改名（只记录了 actor `system` 等）。
- 当前没有消费者所以不会立刻出错；但 A2-T4/T5 就要消费这个枚举，届时投影出的 `baseline-high` 与导演契约的 `motion|baseline` 对不上。
- 建议：在 §4.2/§8.7 显式记录裁定并同步 §2.3、导演契约 §5；或改回草案枚举。

### Y-3 结算时没有 quality 门控，blocked 窗口会报 `none`（`probe.ts:260-266, 302-311`；A2-T6 标题含"quality 门控"）

- 只有注册时筛 `quality === 'ok'` 的源（:260-266、:331-344），窗口内质量降级不再检查；`window.quality` 记下了但 verdict 不使用。
- 实测：注册后摄像头被遮，窗口只有 `blocked` 样本 → `verdict: 'none'`、`reason: undefined`。草案 §2.3 明确"画面质量降级 → ambiguous，宁可报不确定，也别报错"。
- §4.2 的 verdict 表没有 quality 分支，所以严格说实现符合 §4.2；需与 Y-2 一起裁定，并补"窗口内 blocked/dim → ambiguous"用例。

### Y-4 审计面行为正确、测试偏弱（`probe.ts:231-256`；`tests/sensors-probe.spec.ts:249-271`）

- 成立的部分：detail 只是 record 字段的副本（:237-250），`targets` 只有 deviceId/channelId（`ProbeTarget` :60-63），没有任何设备百分比；`actor: 'system'` 与 `AuditActor`（`devices/audit.ts:14`）一致；`settled.push` 在审计之前（:228-229），审计在 try/catch 内（:252-255），所以审计失败/没有 sink 不影响 verdict 与 `recent()`。
- 弱断言：`expect(detail.verdict).toBeDefined()`（:269）恒真；`not.toHaveProperty('percent')`（:270）只防一个字段名，证明不了"无设备百分比"。另缺三个用例：无源时不写审计、sink 抛错时仍结算、`ProbeAuditSink` 与真实 `AuditLog` 的结构兼容（对比 executor 对 `ProbeRegistrar` 的编译级用例 :239-247）。
- 建议：改为断言 detail 的键集合恰为 §4.2 的集合，并补齐上述用例。

### Y-5 B1-T15 两个小缺口（`apps/desktop/src/main/settings.ts:43-49`；`apps/desktop/src/main/llm.ts:179-194, 203-205`）

- `resolveApiKey` 固定用 `config.default.apiKeyEnv` 找 key，而 runner 绑定的是 `singleCallModel`（director 优先）。M2 director 恒为 null 所以无影响；B2 拆分后若 director 自带不同 `apiKeyEnv` 会取到 default 的 key（显式 apiKey 会覆盖 runner 自己的 env 查找）。
- `saveLlmConfig` 在调用方不传 `apiKey` 时会把文件里已有的 key 删掉；当前无生产调用者，但"只改模型配置"的 UI 一旦接上就会静默丢 key。建议拆成 config 与 key 两次写，或读旧值保留。

## 建议

- J-1（R4 文档漂移）`BeatChange.durationSec` 注释（`beat-plan.ts:66-74`）与 `intents.ts:385-388` 声称"level 保留 durationSec 是 §4.3 授权"，但 §4.3 的规则 #5 与接口注释（`M2-实施计划.md:561, 632`）仍把 durationSec 限定在 waveform；工具 schema 其实已允许（`agent/tools.ts:58-63`）。行为正确，只需把 §4.3 补一句。
- J-2（R1 可达性）`change.texture` 的解析与范围校验正确（`beat-plan.ts:629-640, 764-796`），也不再被当未知字段（白名单 :547/:556）；M2 不生效成立（`modulation` 只进 `ResolvedCommand` body :350/:375/:411/:425，executor 不转发，`execution/executor.ts:259-283`）。但 `apply_plan` 的 change schema 没有 `texture`（`agent/tools.ts:57-75`，`additionalProperties:false`），只有 beat 级有（:104-113）——模型路径写不出 `change.texture`。另 `texture.blend`（`波形系统设计.md:267`）未解析，未知键静默丢弃。
- J-3（fixture 回放）确定性成立：probeId 每 recorder 递增（`probe.ts:175-177`），record 没有 settledAt（:314-327），窗口上界被 `Math.min` 夹住（:286）。但测试只做两次内存回放 `toEqual`（`sensors-probe.spec.ts:151-161`），没有 golden record 或字节对照；两个 fixture 也都没有"恰在 actionAt 的样本"，抓不住 baseline 边界。建议加一份期望 record 的 `JSON.stringify` 快照。
- J-4（settleAll 截断）窗口未走完即结算（`probe.ts:196-205, 286`），record 没有截断标记。实测同一组 4 个 probe 在 1300ms `settleAll`：b1/b2 得到 `responded`（实际窗口仅 100/200ms），b3/b4 `ambiguous/degenerate`。契约只说"立即结算"，可接受；建议加 `windowTruncated` 或让截断结算强制 `ambiguous`。
- J-5（小项）`settled` 无上限、`recent()` 只切片（:139, 188-192）；`settleAll` 等待审计期间新 register 的 probe 不在快照内（:200-205）；`dispose()` 不取消已 in-flight 的 settle（:207-212）。

## 必答问题

**Q1 probe 正确性**
- baseline 排除动作：**成立**。`probe.ts:285` 传 `[at-1500, at-1]`；`FeatureRing.between` 是闭区间（`ring-buffer.ts:71-81`），样本 ts 取自 `Clock.now()`（整数），所以 `at` 时刻样本确被排除；`sensors-probe.spec.ts:117-135` 专门锁这条（baseline.samples=1、window.samples=2、delta 0.45）。前提是"整数毫秒"，而 `FeatureSample.ts` 只声明为 number（`types.ts:69`），外部 `pushFeatures` 若送小数 ts 会多排除一个合法点；更稳的是在 ring 层提供真半开区间。
- 只用注入 Clock：**成立**。`schedule` 走 `this.clock.timeout`（:214-221），全文件无 `Date.now`/`setTimeout`。
- settleAll 截断：见 J-4，语义与 doc 一致，只是没有截断标记。
- dispose：取消全部 pending 定时器并 clear、不结算（:207-212），之后 `register` 返回 undefined（:171）；`sensors-probe.spec.ts:204-216` 覆盖。
- 无 ok 源零副作用：**成立**。`selectSources` 为空时在 `probeSerial++` 之前 return（:170-175），不排定时器、不写审计。测试 :163-180 覆盖了 id 与定时器，但**没有注入 audit sink，所以"不写审计"没被验证**（代码上 audit 只在 settle 里，成立）。

**Q2 verdict 与阈值**
- 四态与默认值逐项符合 §4.2：`probe.ts:50-57` 与 `M2-实施计划.md:419-426` 完全一致；`responded` 用 `>=`（:308）。`ambiguous/degenerate` 多覆盖了"baseline.samples<1"（:299，§4.2 只写窗内样本<1），属良性扩展。
- `ambiguous` 的 reason **不符合** §2.3/导演契约（Y-2），符合 §4.2。
- image/audio 分源合并：缺失一方**会被当 0**（:361-364），并可产生假 `responded`（B-1，已复现）。
- fixture 回放：确定性成立（J-3）；但"byte-identical"只是两次内存 deep-equal，无 golden、无字节对照；probeId 确定性、record 无时钟字段，所以"时钟泄漏进 record"这一项本身没问题。

**Q3 审计面**
- detail 只有 id、targets 的 `{deviceId,channelId}`、特征、verdict、reason（:237-250），**没有设备百分比**（`audioLevelMeanPct` 等音频特征是 §4.2 审计样例明确允许的）。
- actor=`'system'`（:234），与 `AuditActor`（`devices/audit.ts:14`）一致。
- 审计失败不影响结算：**成立**（:228-229 先落 record，:252-255 吞错）；但缺"审计抛错/无源不写"的测试（Y-4）。

**Q4 R1/R3/R4**
- R1：`change.texture` 真被解析且范围校验（rate 0.5-2、intensityScale 0-1、phaseOffset 0-1；`beat-plan.ts:629-640, 764-796`），不在"unknown change field"警告里（:547/:556）；测试 `scenario-beat-plan.spec.ts:305-330`。
- M2 不生效：**成立**。`modulation` 只出现在 `ResolvedCommand` body（`intents.ts:350/375/411/425`），executor 组 registry 参数时只取 envelope/percent/duration/waveformId（`execution/executor.ts:259-283`）；测试 `scenario-resolve.spec.ts:469-491` 只断言 body。
- R3：raw `turnId`/`phase` 被忽略并各给一条 warning（`beat-plan.ts:354-361`；测试 :156-168）；ctx 缺省静默为 0/''、无 warning（:340-352；测试 :170-181）；loop 确实从 ctx 注入（`agent/loop.ts:169-177`）。**成立**。
- R4：level `durationSec` 已授权（parse 1-600，:614-627）+ 夹紧到 `channel.maxDurationSec`（`intents.ts:385-395, 476-495`；测试 `scenario-resolve.spec.ts:239-259`）。**成立**；§4.3 文档未同步（J-1）。

**Q5 S2/S5**
- S2：`>=` 取 max、`<` 取 min（`semver.ts:110-124`），`>=2.0 >=1.0` 两种 token 顺序下界都是 2.0.0；测试 `scenario-semver.spec.ts:34-50` 覆盖 1.5.0=false、2.5.0=true、反序 1.5.0=false、两个 `<` 顺序、混合三段、空交集。**成立**；不足是未测精确边界（2.0.0 应 true、1.5.0 对 `<1.5` 应 false），把 `>=` 改 `>`、`<` 改 `<=` 的变异大多不会红。
- S5：三种引用在 loader API 层都对（`loader.ts:387-396`；`scenario-loader.spec.ts:228-245`）；未知引用返回 undefined 且只 warning。但"校验通过 ⇒ 运行时能解析"**不成立**（Y-1）。

**Q6 密钥卫生（B1-T15）**
- 逐路径检索：审计 detail（probe 不含 key，B1-T15 不写任何 LLM 审计）、`snapshot()`（`bootstrap.ts:643/739` 返回 registry snapshot，不含 llm）、`LlmSummary`（`settings.ts:51-72, 89-98`，类型上无 key 字段；`apiKeySource` 只是来源标签）、`log.ts`/`recentLogs`（`bootstrap.ts:376/517/541`，只有 camera/device/intiface 行）、`recentErrors`（:280-285，只存 `error.message`；adapter 的 401 消息只给 env 名，`openai-compatible.ts:325-330`）、`saveLlmConfig` 落盘（`llm.ts:179-194`，只有显式传入的 `options.apiKey` 才写，且 `FileDocumentStore` 0600）。
- `env` 密钥永不落盘：**成立**（生产无 `saveLlmConfig` 调用者；`llm-settings.spec.ts:92-116` 断言 env key 不在文件/审计/snapshot/summary；:139-163 覆盖 file key 同样不外泄）。注意 API 层面并不禁止调用方把 env 解析出的 key 再传进去（Y-5）。
- 无 key：**启动正常、不联网**（`openai-compatible.ts:145-161` 构造只算 URL/headers）；首个回合在 `attempt` 先抛 `ModelError('config')`（"no API key ... set EMBODIED_LLM_API_KEY or pass apiKey"），发生在 fetch 之前（:210-215；core 用例 `agent-openai-adapter.spec.ts:321-332` 断言 callCount=0）。桌面端没有对应的 no-key 用例（测试空白，不是行为缺陷）。
- 结论：**未发现泄漏**；B1-T15 的"密钥永不进审计与提示词"成立。

**Q7 测试空白、永真断言、变异**
- 永真/弱断言：`sensors-probe.spec.ts:269`（verdict toBeDefined）、:270（只防 `percent` 键名）；`scenario-loader.spec.ts:247-277`（warning 与 resolve 同源，同义反复，且不过 `resolvePlan`）；`sensors-probe.spec.ts:159`（两次内存回放，无 golden）。
- 变异分析：
  - baseline 改闭区间：**红 3 条**——`sensors-probe.spec.ts:117`（baseline.samples 变 2、verdict 变 ambiguous）、`sensors-probe-thresholds.spec.ts:118`（delta 0.0133 ≠ 0.03）、:127（motion 0.0633<0.08、audio 10<15 → none）。fixture 回放与其余用例**不会红**（两个 fixture 都没有恰在 actionAt 的样本）。
  - audio 缺失当 0：**0 条红**（当前实现就是它）；反向把 0 改成 undefined/ambiguous 会让 `sensors-probe-thresholds.spec.ts:124` 与 `sensors-probe.spec.ts:234-236` 变红——0 填充是被测试固化的。
  - 忽略 `resolveWaveform` 的 `builtin:` 前缀：**红 3 条**——`scenario-loader.spec.ts:94-115`（freeform 用例）、:228-245、:247-277（warnings 非空）。
  - semver 交集改回"后者覆盖"：**红 1 条**（`scenario-semver.spec.ts:34`），具体 2 个断言：`>=2.0 >=1.0`@1.5.0 与 `<1.5 <2.0`@1.6.0；反序/混合那几条在 last-wins 下仍绿，说明测试是特意写成双向的。
- 其它空白（本轮未见用例）：desktop 的 no-key 启动/首回合用例；probe 的 audit 抛错、无源不写审计；窗口内 quality 降级；image+audio 分源且某模态只覆盖一侧；semver 的精确边界（2.0.0 / 1.5.0）；`resolvePlan` 消费 `pack.resolveWaveform` 的端到端链路。

## 是否可放行

- **代码层面：可合并放行**——没有安全/密钥问题，A2-T1 的窗口/时钟/dispose/零副作用、R1/R3/R4/S2 的代码行为、B1-T15 的密钥路径都成立。
- **验收层面：不放行 A2-T6 的 ✅ 与" S5 已闭合"的宣称**。B-1 是 verdict 正确性缺陷（现有测试还反向钉住了 0 填充），必须修掉并补"分源缺失窗口"用例；Y-1 的运行时链路要接到 `resolveWaveform`（B1-T16）并用集成测试证明，否则 commit 里"runtime resolves"不成立。
- Y-2/Y-3 需在 A2-T4/T5 之前由 lead 裁定（§4.2 与 §2.3/导演契约的枚举漂移、quality 门控），并同步文档；J-1 的 §4.3 文档同步、J-3 的 golden fixture 一并做掉最省事。
- 一句话：**代码可合、宣称不可签；修完 B-1、补上 Y-1 的端到端测试、记录 Y-2 裁定后，A2-T1/T6 与 S5 可重新签收。**
