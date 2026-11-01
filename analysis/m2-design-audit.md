# M2 设计一致性审计报告

> 审计人：design-auditor（task-2）· 只读审计；本报告是唯一新增文件，未改动任何既有文件、未做 git 写操作。
> 代码事实基准：仓库 HEAD `31d546b`；测试基线 `packages/core` 263 / `apps/desktop` 84（`analysis/our-baseline.md:157-158`）。
> 文档 revision（sha256 前 8）：设计文档 `dadffa8f` · 感知闭环 `5e156939` · 回合引擎 `25e4c1e0` · 导演契约 `d6c11958` · 内容包 `9a675ff5` · 跨会话 `3e6a5d69` · 波形 `6022e84e` · 剧本 `6038a80d` · README `f18375c9`。审计期间无变动；若冻结时文件再改，仅需重核"状态行"类条目。
> 分组口径：阻塞=冻结前必须关闭（契约不可实现／虚构设施／安全边界）；应修=不改会引导错误实现；可选=不影响冻结。

## 0. 结论

- **不可放行**：阻塞 9 条（B1–B9）、应修 31 条（S1–S31）、可选 7 条（O1–O7）。
- 已知的 `SensorRegistry` 不是孤例：同类"把不存在当既有"共 6 类——`SensorRegistry`／`SensorSource`、`Channel.region`、`EffectRunner` 的 probe 登记点、`PolicyStore` 落盘、`DeviceRegistry` 的 region 与 intent 映射、"急停不进队列"。逐条见 §4。
- 最关键 3 条：**B4**（会话级上限可被 DLC/引擎自动升降＝安全边界回归）、**B2**（region 全链路虚构且"复用/新增"自相矛盾）、**B5**（同名 `scenario.json` 两套不兼容 schema）。

## 1. 阻塞冻结（9 条）

| 编号 | 类别 | 涉及文件:行 | 问题（判定） | 建议改法 |
|---|---|---|---|---|
| B1 | 虚构设施 | 感知:305,312；设计文档:28,82-84,314-321 | 文档把 `SensorRegistry`／`SensorSource` 当既有设施"复用／扩展"；`packages/core/src/sensors/` 不存在，`grep -rn` 两个类名均 0 命中，`SensorSource` 只有设计文档里的伪代码 | 明写"M2-A1 新建 `sensors/registry.ts` + `SensorSource` 接口（kind image/audio/hr、features、quality、unavailable）"；设计文档 §9 同步 |
| B2 | 虚构设施 | 感知:230,235,310,339；内容包:126；导演:52 | `Channel.region` 不存在（types.ts:23-49 无该字段；registry.ts:101-120 `ChannelState` 无该字段）；同一文档 §4:310 列"复用"、§4:314 又列"新增"；"持久化进设备清单"缺 schema（bootstrap.ts:116-123 `DeviceManifestEntry` 无 region） | 定义为**新增**：`Channel.region?` + `DeviceManifestEntry.regions` + dashboard `POST /api/region` + 变更审计；解析器按 region→channel 映射；回退阶梯见 S15 |
| B3 | 虚构设施 | 感知:121,306 | `EffectRunner` 无 probe 钩子（effect.ts:164-316 仅 start/cancel/stop/settled/invalidate/snapshot）；它也不是"唯一派发入口"——setWaveform（registry.ts:425-435）、rawWrite（:276-301）、stop（:465-486）均绕过 | probe 登记放执行器 beat 派发处，或 registry 增 `onDispatch`；§4 改为"执行器经 DeviceRegistry→EffectRunner 派发；waveform/raw 旁路需显式注明" |
| B4 | 安全边界 | 跨会话:40-44；内容包:163；设计文档:234 | 「DLC 可以请求把上限提到 X」+「惩罚结束上限自动回到原值」+ 新 action `cap_raised/cap_restored` ＝在 `PolicyStore.setByHuman` 之外新增 cap 变更通道；且 policy 当前**无落盘**（bootstrap.ts:203 `new PolicyStore()`；落盘仅 devices/panic/dashboard/waveforms，bootstrap.ts:236,458,530,535） | 按 Lead 口径：引擎与 DLC **永远没有 raise 路径**；X 只由人类在会话开始时经 `setByHuman` 写入并落盘（新增 DocumentStore `policy` 键 + 启动载入）；DLC 只在该 X 内请求、越界夹紧；restore 也必须是人类动作；审计复用 `policy_change`，不新增 cap action；删除"自动回到原值" |
| B5 | 文档冲突 | 剧本:56-87 vs 内容包:87-121 vs 设计文档:302-308 | 同名 `scenario.json` 两套不兼容 schema：剧本版 id/title/host(profile 引用)/opening/npcs[]/secrets[]，intents 无 regions；内容包版 session/regions[]/boundaries/aftercare，intents 带 regions+strength，无 id/title/npcs/opening。宿主目录也是两套（`host/<profile>.md`+`scenarios/<id>` vs pack 目录+`persona.md`/`host.md`） | 二选一：建议以内容包为准，剧本 doc 降级为"历史/迁移说明"+ 迁移表（npcs/opening/secrets → persona.md/phases/*.md/state）；设计文档 §8 同步改 |
| B6 | 不可实现 | 感知:21,263-265；回合:49-72,119,169-170；导演:171-183 | MVP"单次调用+tool calling"与回合引擎 planning→executing→writing 三段状态机、模型/写作各一个 AbortController、两套超时冲突；单次调用没有独立写作流/独立取消/写作超时，导演契约 §7 的"结构隔离保证"也不成立 | 明确 MVP 状态折叠：planning=同一请求 tool_call 解析、executing=派发、writing=同请求文本流；只有一个 AbortController + 一个总超时；拆导演/写作时才启用双控制器与 §7 保证 |
| B7 | 文档冲突 | 回合:152（pause 不影响设备，"见待定 4"）vs 回合:203（决策 4"全停"） | 同文档两答案且"待定 4"已决策；pause 与 probe/效果时序未闭合——被停效果的在途 probe 窗口仍会结算 | 采纳决策 4：进入 paused 调 `DeviceRegistry.stop()`（cancel generation + 归零），并取消所有在途 probe 窗口（记 `probe_cancelled`）；恢复不自动重放；§8 改终态口径 |
| B8 | 不可实现 | 感知:207-218；内容包:111-118；设计文档:278 | BeatPlan `change.kind=waveform/level` 与 `deltaPercent` 无法映射到代码所需 `Envelope{preset,min/maxPercent,periodMs,jitter,durationMs}`；唯一带 preset 的 `suggest` 被标"只是建议"且解析器不消费；deltaPercent 无基准 | BeatPlan.change 增加 `preset/periodMs/durationSec`，或"缺省读 feedbackIntents[].suggest"；deltaPercent 改绝对 `targetPercent` 或定义基准=快照 percent；补 `strength→policy.maxPercent` 精确比例 |
| B9 | 文档冲突 | 设计文档:263-298 vs 感知:264,278；导演:11,108；设计文档:237,276 | 工具面两条写路径冲突：总纲 11 工具有 set_level/run_pattern/stop 直写，感知方案要求"plan 唯一事实源、执行器只读 plan"；§6 说模型"不能读或写 policy"，§7 又让 devices_list 暴露当前上限 | 明确 M2 模型写路径唯一化：`apply_plan(BeatPlan)`（第 12 个工具）；set_level/run_pattern/set_motion 只留 human/debug 或删除；devices_list 只给 region/档位不给百分比，或 §6 改为"不能写" |

## 2. 应修（31 条）

| 编号 | 类别 | 涉及文件:行 | 问题（判定） | 建议改法 |
|---|---|---|---|---|
| S1 | 命名漂移 | 设计文档:67；README:57；感知:17,34,231,307；导演:108；内容包:127 | 文档一律称 `SafetyPolicy`，代码实为 `PolicyStore`/`ChannelPolicy`，`index.ts:52-62` 无 `SafetyPolicy` 导出；"只有 setByHuman"断言成立（policy.ts:145） | 统一改称 `PolicyStore`（或代码加导出别名）；断言本身保留 |
| S2 | 审计契约 | 设计文档:251-259；感知:123,308；回合:104,113-114,184；导演:102；跨会话:43；波形:209；内容包:221 | ①"AuditLog 只暴露 append()"错，实为 `record()`；②JSONL 示例把 deviceId/envelope 放顶层，实际全在 `detail`（audit.ts:19-30）；③policy_change 用 from/to，代码是 previous/next（registry.ts:535-540）；④`actor:"sys"` 非法（合法 model/human/system，audit.ts:14）；⑤M2 新增十余个 action 无集中表，回合:192 的"审计回放"不可实现 | 补"M2 审计 action 总表"（action/actor/result/detail 键），并修正 ①②③④ |
| S3 | 文档-代码漂移 | 设计文档:104-129 | §3 接口过期：`Channel.hardCapPercent` 不存在（上限在 PolicyStore，types.ts:23-49 无该字段）；缺 outputFloorPercent（:48）、applyBounds/onLinkLost/onChannelsChanged/scan/writeRaw（:89-124）；applyWaveform 实际允许 undefined（:80） | 用 `packages/core/src/devices/types.ts` 实际签名回写 §3 |
| S4 | 文档-代码漂移 | 设计文档:50-96 | 结构清单大面积过期：`devices/backend.ts` 实为 types.ts；`waveform/{compile,parse,validate}.ts` 实为 dsl/hex/clamp.ts；`ports/serial.ts` 不存在（实际 ble/clock/fake-clock/http/mock-ble/mock-websocket/storage/websocket）；`sensors/*`、`agent/*`、`scenario/*`、`state/store.ts`、`apps/phone-web`、`apps/android`、`host/`、`scenarios/`、`waveforms/` 均未建；`backends/ankni-ble/` 实为 ankni/ | 拆"已实现／待建"两段重写 §2，待建项标里程碑 |
| S5 | 里程碑过期 | 设计文档:3,329-360；README:5 | ①状态行"等待开工确认"过期（M0/M1 已交付）；②M3 的 monsterparty/ankni/波形导入已在 M1 完成；③M2 写 phone-web，但感知:125-129 决策 3 说手机浏览器 getUserMedia 需 HTTPS/Secure Context、PC USB 优先；④M2 出口（:345）与草案 M2-A/B 出口（感知:321-328）不同源；⑤`/frame` token 上传（设计文档:324）与 PC USB 本地 IPC 采集冲突 | 回写 §10：M1 实际范围、M2 冻结范围（PC USB 优先，phone-web 顺延）、M3 删除已完成项；M2 DoD 合并草案子步 + 端到端验收 |
| S6 | 冻结卫生 | 感知:3；内容包:5；回合:5；导演:5；跨会话/波形无状态行 | 6 份冻结对象状态不一致，且感知明写"讨论稿（未冻结）" | 统一为"已冻结 v0.1（2026-11-01）+ 变更需 Lead 批准 + 未实现部分标注" |
| S7 | 文档冲突 | 导演:74-75 vs 回合:64,127,169 | 导演超时 2s vs 5000ms；"不重试猜" vs "超时重试 1 次"，边界未分 | 冻结单一值（建议 5s），仅传输超时重试 1 次、schema 非法不重试，两处同步 |
| S8 | 契约缺失 | 导演:121-126 vs 感知:94,99-101 | 导演消费 `off-body` 与 `ambiguous.reason`，生产者契约没有第 4 个 verdict／reason 字段；且单次调用 MVP 下"写作无数字"的隔离不成立（同上下文） | 感知 §2.3 增加 off-body+reason 枚举，或删除导演表；单次调用下数字过滤另定（并入 B6） |
| S9 | 文档内冲突 | 回合:96 vs :102；感知:220 | 选项 0–3 条与"校验 1–3 条"矛盾 | 统一 0–3；仅 >0 时校验上限 |
| S10 | 状态机/审计名 | 回合:49-59 vs :61-70；回合:114 vs :184 | 状态图含 fallback/template/cancelled/ended，状态表只列 8 态；同一抢占事件在 §5 叫 `writer_preempted`、验收叫 `preempted` | 补齐状态表 4 态；抢占统一命名（如 `preempted`+`reason:"writer"`） |
| S11 | 文档冲突 | 跨会话:27 vs :86；:32；回合:154-155 | endReason 列 6 值、验收说"五种"；"paused 清开放标记"又把 paused 当 endReason；引擎标注 aborted/recovered 与账本 panic/unexpected_exit 不对齐，内容包 metaReactions 会匹配不到 | 定唯一 endReason 枚举与"暂停是否结账"；崩溃统一 unexpected_exit；aborted/recovered 降为 UI 标签或删除 |
| S12 | 重复定义 | 内容包:71,:98,:120；:69,:119 | aftercare 三处定义（pack.aftercare.minMinutes／session.aftercareMin／scenario.aftercare.minMinutes）、boundaries 两处，均无优先级；plannedMinutes(:91) vs plannedMin(跨会话:28) 命名漂移 | 各保留一处（建议 session.aftercareMin + pack.aftercare.text）；补优先级规则；统一键名 |
| S13 | 契约不一致 | 内容包:168 vs :100 | freeform 生成 `regions=["whole-body"]` 字符串数组，scenario 契约为 `regions:[{id,label}]` | freeform 生成对象数组（`{id:"whole-body",label:"全身"}`） |
| S14 | 悬空常量 | 内容包:61 | `engine: ">=0.2 <1.0"` 无当前引擎版本常量可对（所有 package version 0.0.0） | 定义 `ENGINE_VERSION` 并纳入校验；否则所有包加载即失败或校验形同虚设 |
| S15 | 文档冲突 | 内容包:190 vs 回合:151-155；内容包:220 vs 感知:285-286,229 | 热切换无 currentPhase/存档迁移规则；同一"region 失败"两种处置（降级全身 vs 丢弃 beat） | 限定切包只在会话开始/结束，或定义迁移；统一阶梯：未声明 region→校验期拒绝、已声明但无 channel 映射→全身→全部 level 通道，均审计 |
| S16 | 陈述矛盾 | 导演:52 vs 设计文档:229,390 | 导演读"冷却中通道"，总纲明确不做强制冷却；"每 region 当前档位"无状态存储归属 | 删冷却或改为"最近 probe 的频率限制"；档位=执行器维护的最近 strength，进 snapshot |
| S17 | 文档内冲突 | 导演:57 vs :70 | 必读"上一回合台词原文"与不读"台词完整文本（只看摘要）"矛盾 | 改为"仅导演读上一回合 line 原文"，或删除该必读项 |
| S18 | 不可实现 | 回合:131 | "设备写失败→该通道标 failed"无落点：DeviceLifecycle 是设备级（types.ts:52），ChannelState 无 failed（registry.ts:101-120），写失败只产生 emit_failed 审计（:639-648） | 改为设备级 failed（已有）或新增 per-channel 健康位并进 snapshot |
| S19 | 配置表缺项 | 回合:159-177 vs :36,:65,:139-143 | 缺单 beat 派发 2s、probe 采样开关、probe.baselineSec、aftercareMin、retries/温度；P2 检查点"生成收束回合"(:36) 与 §7"50/80 注入提醒"(:142) 不一致 | 补全配置表，§2/§7 引用同一键；明确 P2 检查点只注入提醒、90% 才生成收束 |
| S20 | 契约缺失 | 感知:305 vs :73,:149,:155 | "缺源显式 unavailable"与 quality 枚举（ok/dim/bright/blocked/stale）无 unavailable 冲突；无源处置三处不同 | 定义 quality=unavailable，或统一"该源不出现"；补失败模式与质量枚举的对应 |
| S21 | 契约缺失 | 感知:86-95 vs :232 | probe 记录无 planId/beatId，审计要求 planId+beatId，回放与验收（:153-157）无法关联 | probe 增 planId/beatId/turnId |
| S22 | 契约缺失 | 感知:63 vs :68-82 | 音频源"只报 rmsDb/levelPct"，但特征 JSON 无音频字段；Δ音频（:58,92）无来源 | 给音频源单独 JSON schema 并纳入 §2.3 |
| S23 | 文档-代码漂移 | 波形:202-209 vs bootstrap.ts:216-219,535；library.ts:160-175 | 设计 `waveforms/library` 与 `waveforms/session` 两个目录，实际落盘为 `state/waveforms.json` + 内存 session；波形:209"两个动作都进审计"当前不成立——dashboard import/promote（dashboard.ts:397-425→bootstrap.ts:507）无审计 | 统一为 document store（或迁移目录）；补 human import/promote 审计（actor human） |
| S24 | 契约缺失 | 波形:95-103 vs types.ts:66；波形:262；内容包:141；导演:206 | 文档 `tags?` 可选、代码必填；`sensation` 被写入/检索路径消费但 Waveform 类型无该字段 | tags 与 sensation 二选一，或定义 sensation→tags 映射并写入类型 |
| S25 | 安全边界 | 感知:110-114,122 | 主动探测是系统自发设备写；例子硬编码 15% 未绑定 cap；未写 LOCKED/pause 门控与派发通道 | 按 Lead 口径：默认关；仅用户开启的试探阶段；经 DeviceRegistry/EffectRunner 派发；受 LOCKED/pause/policy 约束；目标值 `min(拟用值, policy.maxPercent)`；15% 标注"示例值，需夹紧" |
| S26 | 未决决策 | 波形:65-80；设计文档:368 | GPL 两条路仍写"需要你拍板"，但代码已按方案 D 实现（builtin 2 厂商 + 5 自创，无 dglab-kit 依赖） | 冻结记录一条"已决：方案 D；不依赖 dglab-kit"，删除开放措辞 |
| S27 | 范围不清 | 波形:231-256；设计文档:278 | WaveformProgram 标"待实现"却列入 M2 冻结集，不在任何 M2 子步；其 `texture?` 参数不在 run_pattern 签名 | 标 M3+，或新增 M2 子步 + 工具签名变更（并入 B9 工具表） |
| S28 | 计数过期 | README:5,:165-166 vs our-baseline.md:113,:157-158 | "四个真实后端"实为 5 个（coyote/xhtkj/ankni/monsterparty/buttplug）+ mock；测试 249/68 vs 263/84 | 改为"5 个真实后端 + mock"，重跑测试更新计数 |
| S29 | 文档冲突 | 剧本:173-186 vs 导演:44-70 | 剧本 §8 六层单 prompt 组装，与导演契约的双投影（以及 MVP 单次调用）都不同源 | 标注 §8 被导演契约取代，仅作历史决策保留 |
| S30 | 文档内冲突 | 剧本:47,:125-133 vs 跨会话:9-17,:80 | `state/<session>.json` 却声称"跨会话累积"，与跨会话"核心只记账本、不做跨包档案"边界冲突 | 明确存档键按 scenario 而非 session，或写清"跨会话累积 = 账本 + 存档文件"，并同步跨会话 §4 |
| S31 | 校验规则冲突 | 剧本:166 vs 内容包:18,89 | host 引用不存在→拒绝加载；内容包 host 可选、缺省用引擎默认 | 统一为可选 + 缺省审计警告 |

## 3. 可选（7 条）

| 编号 | 类别 | 涉及文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| O1 | 引用悬空 | `.archify/architecture-embodied-roleplay-20261101-213457`、`...-target-20261101-214358` | 两份新生成架构图未被任何设计文档引用 | 若是 M2 架构基线，在 README/设计文档挂链接；否则归档 |
| O2 | 引用计数 | 感知:359 | "21 个来源"与分析文档参考节 11 条编号文献不符（`analysis/hr-rr-arousal-analysis.md:240+`） | 改为"阅读 21 篇／正文引用 11 条"或更正 |
| O3 | 术语表 | 感知:348-353 | 缺 beat/region/host/persona/plan/turn 等新术语；host 与 persona 的层归属在 B5 处理 | 补术语表，与内容包 §2 对齐 |
| O4 | 精度问题 | 回合:11,34 vs registry.ts:495-512；queue.ts:9-10 | "急停不进队列／队列之外"不准确：emergencyStop 走 priority 队列（最坏等一个在途写） | 改为"priority 插队，延迟上界=一个在途写" |
| O5 | 前提遗漏 | 感知:126；dev-server.ts:19-26 | 复用隐藏 Electron 窗口属实（electron-bridge.ts:282-345），但纯 Node dev-server 只有 mock、无 BLE/窗口路径 | 注明 M2 采集需 Electron 壳；dev-server 模式下降级为无感知 |
| O6 | 待定项 | 内容包:264-269 | 5 个待定问题未标"M2 不做"，易被当未完成 | 标 M2 不做／M3 后评估 |
| O7 | 范围说明 | 波形:57 vs :154；types.ts:23 | "官方预设实测 freq≤160"与协议上限 240 并存，易被误收窄 | 注明"实测 160，协议允许 240" |

## 4. 复用／既有断言逐条核对（Lead 指定）

| # | 断言出处 | 文档声称的既有设施 | 代码事实（有／叫什么／文件:行） | 判定 |
|---|---|---|---|---|
| 1 | 感知:305 | `SensorRegistry`（命名源+新鲜度） | 无；`src/sensors/` 不存在，0 命中 | 不存在→B1 |
| 2 | 感知:312 | `SensorSource.kind` 扩展 | 无该类型/接口；仅设计文档:314-321 伪代码 | 不存在→B1 |
| 3 | 感知:306 | `EffectRunner`=probe 登记点+唯一派发入口 | 无 probe API（effect.ts:164-316）；setWaveform/rawWrite/stop 绕过 | 不存在→B3 |
| 4 | 感知:309 | `DeviceRegistry` 的 region 映射 | 无 region（registry.ts:101-120） | 不存在→B2 |
| 5 | 感知:310,339 | `Channel.region` UI 实时编辑+持久化 | types.ts:23-49 无；manifest 无（bootstrap.ts:116-123）；dashboard 无该路由（dashboard.ts:283-427） | 不存在→B2 |
| 6 | 感知:235 | dashboard API 可编辑 region | dashboard 路由 20 个（dashboard.ts:283-427），无 region | 不存在→B2 |
| 7 | 感知:308,123 | `AuditLog` 新 action 枚举 | action 是 string（audit.ts:24），可新增但无枚举表；actor 枚举 model/human/system（:14），`sys` 非法 | 部分成立→S2 |
| 8 | 感知:17,34,307 等 | `SafetyPolicy` | 无该类；实为 `PolicyStore`（policy.ts:127）、`ChannelPolicy`（:26），index.ts:52-62 导出 | 命名漂移→S1 |
| 9 | 感知:126 | 隐藏 Electron 渲染窗口模式 | 属实：electron-bridge.ts:282-345，bridge.ts 可单测 | 成立（前提见 O5） |
| 10 | 回合:119 | generation token（已有） | 属实：effect.ts:165,196-209,258-273；急停时 registry.ts:498-500 全部 cancel；lock 后 write() 拦截正数（:663-666）；**无 pause 实现**，暂停必须复用 registry.stop | 成立，pause 需新增（B7） |
| 11 | 回合:152 | 已有包络 | 属实：EffectRunner Envelope（effect.ts:39-46,196-209） | 成立 |
| 12 | 设计文档:251 | `AuditLog` 只暴露 append() | 实为 `record()`（audit.ts:48）；append() 在存储端口（storage.ts:13-16） | 不成立→S2 |
| 13 | 设计文档:207 | generation token | 属实（同 10） | 成立 |
| 14 | 设计文档:84 | `sensors/frame-store.ts` 原子写 | 文件不存在；原子写原语在宿主适配层 node-storage.ts:87-101（temp+rename），core `ports/storage.ts:19-22` 只声明接口、不承诺原子性 | 文件虚构／原语真实→B1、S4 |
| 15 | 内容包:127 | `SafetyPolicy` 夹紧 | 无该类；夹紧在 registry.ts:663-673 + policy.ts:117-120 | 命名漂移→S1 |
| 16 | 内容包:163 | 连接时写 BF=X | BF 链路属实（coyote/backend.ts:99-100,157-187；bootstrap.ts:293），但"会话级上限 X"机制不存在 | 部分成立→B4 |
| 17 | 跨会话:79 | 现有 policy/急停/LOCKED/审计不变 | 均属实（policy.ts:145；registry.ts:495-524；audit.ts:48-69） | 成立，但与 B4 冲突 |
| 18 | 剧本:91 | `DeviceRegistry` 把意图映射到设备 | registry 无 intent 概念，`grep feedbackIntent` 代码 0 命中 | 不存在→M2-B1 解析器新建 |
| 19 | 剧本:186 | 急停后 LOCKED、写工具拒绝 | 属实：registry.ts:495-524,677-694 | 成立 |
| 20 | 波形:254 | `promoteByHuman` | 属实：library.ts:145-155（agent 无等价路径） | 成立 |
| 21 | 波形:219 | 目标强度来自 EffectRunner | 属实：registry.ts:631-660 createRunner→write | 成立 |
| 22 | AI-for-Coyote 架构:234（README:15 引用） | 帧快照原子写"复用 ports/storage.ts" | ports/storage.ts 无原子保证；原子在 node-storage.ts:87-101 | 不成立（非本次审计对象，标注） |

## 5. 引用悬空／笔记与图

- 有效引用（已核）：`analysis/hr-rr-arousal-analysis.md`（§3.3、§4.2 均在；HW9"臂动关 RR"见 §8 与 `hr-armband-research.md:257-259`）；`_reference/dglab/coyote/{README,v2/README,v3/README,v3/example}.md`；`_reference/tentacle-esp32/{AGENTS.reference.md,剧本.txt}`；`analysis/our-baseline.md`、`coospo-hw9-test-plan.md`、`hw9-capture/INDEX.md`；README 文档表内路径均存在。
- 待建路径（未标"待建"，不影响冻结但需注明）：内容包:239 `templates/pack-*`；内容包:189 `content/registry.json`；跨会话:23 `memory/ledger.jsonl`；波形:202-209 `waveforms/library|session/`；设计文档 §2 的 agent/scenario/sensors/state（S4）；感知:323 `/frame` 在 M2 无宿主（S5）。
- 有意忽略（按任务口径只标注）：`_reference/ai-for-coyote/`、`*.cfa`、`bluetooth_*.log`、`analysis/hw9-capture/[0-9]*` 在 `.gitignore` 内。

## 6. 已核实为真（不构成问题，供冻结时引用）

- `EffectRunner` generation token：effect.ts:165,196-209,258-273（旧 tick/终止零失配）；锁定期正数写在 write() 被拦：registry.ts:663-666。
- `PolicyStore` 只有 `setByHuman`：policy.ts:145-155；`grep setByModel` 0 命中；绝对上限 100/100/600（:13,20,22）；`clampPercentToPolicy` fail-closed（:117-120）。
- `AuditLog.record()` 永不抛：audit.ts:48-69；actor/result 枚举 :14,:17；既有 action 16 个（grep `action: '`：connect/scan/set_level/run_pattern/set_waveform/stop/panic/unlock/policy_change/raw_write/channels_changed/device_removed/link_lost/emit_failed/effect_finished/shutdown）。
- 每设备串行队列、设备间并行、stop 可 priority：queue.ts:19-53（priority :34）；registry.ts:153-160,663-673。
- `Channel.outputFloorPercent`：types.ts:48；消费 registry.ts:591；来源 xhtkj/protocol.ts:144-159。`maxWaveIntensity` 在 `ChannelPolicy`（policy.ts:34）与 `ChannelSnapshot`（registry.ts:68,594），**不在 `Channel`**；发射端夹紧 coyote/backend.ts:329 + clamp.ts:34-48。
- append-only 存储原语：端口 storage.ts:13-16；宿主 FileAppendOnlyStore（串行追加防撕裂）node-storage.ts:19-39。原子写仅宿主 FileDocumentStore：node-storage.ts:87-101（core 端口不承诺原子性）。
- 端口抽象齐全：ble/clock/storage/http/websocket（ports/*.ts；index.ts:10-28 导出）。
- `DeviceRegistry.onChannelsChanged`：types.ts:106；registry.ts:164-176；仅 buttplug 实现（backend.ts:197），`scan` 亦仅 buttplug（:159）；`applyBounds` 仅 coyote（:207）；`writeRaw` 见 ankni:133/xhtkj:257/mock:133。
- 宿主事实：manifest `state/devices.json`（bootstrap.ts:232-272）；落盘 4 类 + 审计（同 B4）；dashboard 路由 dashboard.ts:283-427；隐藏窗口 electron-bridge.ts:282-345；BF 连接即写 coyote/backend.ts:157-187；`promoteByHuman` library.ts:145-155。

## 7. 冻结放行判断

**不可放行：需先修 9 条阻塞（B1–B9）。** 建议同批一并关闭 5 条高危应修：S2（审计 action 总表）、S25（主动探测门控）、S7（超时/重试）、S9/S10（契约枚举与状态名）、S23（波形入库审计）。

放行门槛：
1. B1–B9 全部关闭，并在文档内留下"冻结修订记录"（日期+条目+决定）；
2. B4 必须按 Lead 口径落成一行硬约束："引擎与 DLC 永不 raise cap；X 仅人类 setByHuman 写入并落盘；restore 为人类动作；审计复用 policy_change"；
3. B5/B6/B8/B9 必须有唯一决议（选哪套 schema、MVP 状态折叠、Envelope 来源、工具清单），否则实现会先长出一套用不上的流水线；
4. 状态行（S6）统一为"已冻结 v0.1" 后再宣布冻结。

风险提示：B4 若按原文实现，等于给 DLC/引擎开一条改上限的路（唯一一条安全边界回归）；B2+B8+B9 若照原文实现，M2 会先写一套 region/plan 解析器却没有对应类型与工具入口。

---
（本报告 200 行内；条目定位以 §0 所列 revision 为准。若 Lead 已并改文档状态行，请以本报告 §1–§3 的条目为待办清单复核。）
