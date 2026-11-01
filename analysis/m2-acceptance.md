# M2 独立验收报告（只读审计）

- 审计对象：`main` @ `56ad5ef`（`feat(m2): wave 8`），工作区干净；计划基线 `25b991a`。
- 方法：先定位每项验收断言对应的 `it`（测试名 + 文件:行），再跑命令核对；找不到覆盖断言即标 `NO-EVIDENCE`。
- 复跑环境：Node v24.18.0；`pnpm` 不在 PATH，用 `corepack pnpm` 等价执行工作区脚本（见 §2.1）。

## 1. 一句话结论

**现在不能宣布 M2 完成。** 48 项中 **45 PASS / 1 FAIL / 2 NO-EVIDENCE / 0 MANUAL / 0 DEFERRED**；另有 §5.4 Demo B2 的 **aftercare 宿主接线缺失**（核心引擎已实现，宿主固定 `aftercare:false`），且四个 demo 的真机部分只能人工验收。

- FAIL：**D-6** —— `boundaries` 为空有校验 warning，但 UI 任何位置都没有“使用全局边界”标注。
- NO-EVIDENCE：**B-5**（没有“非法 beat 被丢弃 + 写作仍出词 + 审计齐全”的仓库端到端测试，但本次临时探针已复现全部行为）、**F-6**（没有“零感知源 + 零设备跑完整一局”的仓库测试，本次探针也已跑通）。二者是**测试固化缺口**，不是功能失败。
- 额外阻塞 §5.4：**Demo B2 第 6 步的 aftercare 未接线**（`apps/desktop/src/main/play.ts:830` 自述，`play.ts:867` 恒写 `aftercare:false`）；Demo B2 9 步中仅约 4 步被 `scripts/demo-m2.mjs` 脚本化。

## 2. 命令与结果

| 命令 | 结果 |
|---|---|
| `cd packages/core && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0 |
| `cd packages/core && node node_modules/vitest/vitest.mjs run --pool=threads` | **50 files / 634 tests passed** |
| `cd apps/desktop && node ../../packages/core/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0 |
| `cd apps/desktop && node ../../packages/core/node_modules/vitest/vitest.mjs run --pool=threads` | **14 files / 161 tests passed** |
| `node scripts/demo-m2.mjs` | exit 0，`done: 4 steps passed` |
| `corepack pnpm -r --stream typecheck` + `corepack pnpm -r --stream test` | 两包 0 error；634 + 161 全绿（等价 `pnpm run check`；字面 `pnpm run check` 因 PATH 无 `pnpm` 在嵌套调用处失败，非代码失败） |

### 2.1 汇总

| PASS | MANUAL | DEFERRED | FAIL | NO-EVIDENCE |
|---|---|---|---|---|
| **45** | **0** | **0** | **1** | **2** |

> `DEFERRED=0`：B1-T3（AI SDK 适配器）、主动探测、HR、`texture` 运行时调制均不在 48 项内，分别见计划 §8.6、§8.13⑤；§8.7–§8.13 已记录挂起。

## 3. 48 项逐条

| # | 清单条目（摘要） | 判定 | 证据（测试名 / 文件:行） | 备注 |
|---|---|---|---|---|
| A-1 | 录制特征序列回放，特征与 verdict 一致 | PASS | `sensors-probe.spec.ts:151` 两次 replay 的 `ProbeRecord`（含 baseline/window/delta）`toEqual`，verdict 同 fixture | fixture 为录制特征样本（`fixtures/probe-*.json`），非录制帧 |
| A-2 | baseline 不含动作，窗口从 actionAt 起 | PASS | `sensors-probe.spec.ts:117` baseline 恰在 actionAt 结束；`:137` 在 actionAt+windowMs 结算 | — |
| A-3 | 无感知源：不登记、无探测段、零副作用 | PASS | `sensors-probe.spec.ts:163` 不占 id、无定时器；`sensors-projection.spec.ts:162` 空块；`sensors-probe-audit.spec.ts:92` 仅在有 sink 时写一行 | — |
| A-4 | baseline 高→ambiguous；两项都低→none | PASS | `sensors-probe-thresholds.spec.ts:90`、`:118`、`:128` | — |
| A-5 | 注入 ≤200 字且只含最近 3 条 probe | PASS | `sensors-projection.spec.ts:171`（3 条/3 段、旧的消失）、`:190`（≤200）、`:39`（≤200 字符） | — |
| A-6 | 同 plan+快照→命令逐字节一致 | PASS | `scenario-resolve.spec.ts:134` `JSON.stringify` 相等，输入未被改 | — |
| A-7 | 不存在“读台词生成命令”路径 | PASS | `scenario-resolve.spec.ts:156` 注入 `line` 输出不变；`ResolveContext` 无 `line` 字段 | 结构 + 行为双证 |
| A-8 | 100 夹到 20 且审计记 clamp | PASS | `scenario-resolve.spec.ts:176`（percent 20、`clamped:true`）；`execution-executor.spec.ts:184` 审计 `actions[].status='clamped'` | — |
| A-9 | 3 通道、2 个 chest；同步到 2 个；targets 各异 | PASS | `scenario-resolve.spec.ts:263`（第三台不动）、`:306`（逐 target 覆盖）；`scenario-beat-plan.spec.ts:103` | — |
| A-10 | 非法 intent 丢该 beat、其余照常、审计有记录 | PASS | `scenario-beat-plan.spec.ts:44`；`execution-executor.spec.ts:184` 审计 `detail.dropped`；`agent-loop.spec.ts:293` | — |
| B-1 | 写作不吃 DeviceSnapshot；导演不吃人设全文 | PASS | `director.ts:252-270` 仅 `personaSummary`，`agent-context-director.spec.ts:158`；`writer.ts:87-105` 无 `DeviceSnapshot`，`agent-context-writer.spec.ts:119` | 类型签名 + 测试 |
| B-2 | 同状态+同包→两种上下文逐字节稳定 | PASS | `agent-context-director.spec.ts:214`；`agent-context-writer.spec.ts:173` | — |
| B-3 | 50 轮 + 20k 字设定仍在预算内，降级顺序正确 | PASS | `agent-context-director.spec.ts:185`、`:465/:476/:489/:506`；`agent-context-writer.spec.ts:229/:300`；`agent-prompt.spec.ts:69/:120` | — |
| B-4 | 同一 probe 两种投影，写作版无数字 | PASS | `sensors-probe-projection.spec.ts:73`（`\p{Nd}` 断言）、`:89`、`:108` | — |
| B-5 | 端到端：非法 beat 丢弃、写作仍出词、执行照常、审计齐全 | **NO-EVIDENCE** | 仓库无该端到端用例；本次临时探针已复现：非法 `b2` 进 `dropped(rule=intent)`、合法 `b1` 派发 8%、台词照出、第二回合继续、`plan_resolved` 审计齐全 | 行为已验证，缺固化 spec；组件级见 `scenario-beat-plan.spec.ts:44` + `agent-pipeline.spec.ts:220` + `execution-executor.spec.ts:184` |
| C-1 | planning 时玩家输入：取消、无写入、新回合 | PASS | `engine-scheduler.spec.ts:150`（signal aborted、calls 2、state idle、`preempted` 审计）；`engine-turn.spec.ts:95` | 首回合 runner 未派发，无写入为构造性成立 |
| C-2 | writing 时输入：台词取消、已派发动作保留、审计 preempted | PASS | `engine-scheduler.spec.ts:272`（aborted、`writer_preempted`、不回填 line）；`execution-executor.spec.ts:383`（已派发 b1 保留，只丢后续） | — |
| C-3 | 写作中急停：归零、locked、无后续写入、人工解锁 | PASS | `engine-turn.spec.ts:82/:214`；`registry.spec.ts:178`（急停归零、模型写被拒）；`engine-scheduler.spec.ts:231`（仅 stop/unlock） | 跨组件组合 |
| C-4 | 自动运行忙时连点：不排队、不连发 | PASS | `engine-scheduler.spec.ts:123`；`engine-autopilot.spec.ts:57`；`engine-turn.spec.ts:255`（P1 串行） | — |
| C-5 | 导演非法 tool call：丢 beat、会话继续 | PASS | `agent-loop.spec.ts:293`（不重试、plan 空、dropped>0、dispatch 一次）；`scenario-beat-plan.spec.ts:44` | loop 级，非整局级 |
| C-6 | 写作超时→模板句且动作完整（split/单调用） | PASS | `agent-pipeline.spec.ts:254`（`writerTimeoutMs` 超时→模板句 + dispatch planId）；`agent-loop.spec.ts:222`（单 controller + 60s 总超时）；`engine-turn.spec.ts:68` | — |
| C-7 | 90%→收束意图；100%+5min→强制 resolve | PASS | `scenario-phases.spec.ts:58`；`engine-autopilot.spec.ts:149`（planned+5min 触发 `checkpoint=1` 的强制回合）、`:172-193`（`checkpoint=0.9` 时 `mustResolve=true` 进入模型请求） | `mustResolve` 是请求/提示词级，未硬丢弃非收束 beat |
| C-8 | 暂停/恢复：无新回合、全停、不重放 | PASS | `play.spec.ts:860`（settle 后暂停、effects 0）、`:891`（恢复不重放）；`engine-turn.spec.ts:121` | — |
| C-9 | 崩溃重启：快照恢复、未完成回合作废、无重复动作 | PASS | `m2-e2e.spec.ts:495`；`play.spec.ts:742`；`state-store.spec.ts:99` | — |
| C-10 | 审计 JSONL 重建命令时间线 | PASS | `m2-e2e.spec.ts:371`（`replayTimeline` 重建 8 回合） | — |
| D-1 | id/version/mode/rating 合法；engine semver 兼容 | PASS | `validate.ts:186-221` 四条规则；`scenario-validate.spec.ts:61`（合法包 0 error）、`:154`（engine 拒绝）；`scenario-semver.spec.ts:5` | 坏 id/rating 无独立负例，规则在源码 |
| D-2 | persona 存在非空；scenario 模式 scenario.json 合法 | PASS | `validate.ts:383-389`；`scenario-loader.spec.ts:94/:161`；`scenario-pack-registry.spec.ts:294`（缺 persona 拒绝安装） | — |
| D-3 | 阶段图可达、无死锁、至少一个终局、next 存在 | PASS | `scenario-validate.spec.ts:61`（死锁→`phases.no-terminal`） | — |
| D-4 | intent id 唯一；phases 引用意图/阶段存在 | PASS | `scenario-validate.spec.ts:85`（`intent.duplicate`）、`:105`（`intent.region-undeclared`） | — |
| D-5 | 白名单、≤50MB、无符号链接/可执行文件 | PASS | `validate.ts:361-396`；`scenario-validate.spec.ts:113/:140`；`pack-store.spec.ts:117`（拒符号链接）；扩展名白名单使可执行文件无法入包 | Windows 无执行位；按白名单判定 |
| D-6 | boundaries 空→warning 且 UI 标注“使用全局边界” | **FAIL** | warning 有：`validate.ts:236`、`scenario-loader.spec.ts:192`；**UI 无标注**：`apps/desktop/src/ui/**` 中 `全局边界`/`boundar`/`边界` 均 0 命中（play/index 都不展示 boundaries） | 仅缺 UI 一半，易补 |
| D-7 | 包坏→加载失败、保留上一可用包、不自由发挥 | PASS | `dashboard.spec.ts:826`（坏 zip 400 且已安装列表不变）；`scenario-pack-registry.spec.ts:294/:338`（全有或全无/回滚）；`pack-source.spec.ts:129`；`play.spec.ts:470` | — |
| D-8 | 阶段提示缺失→warning + 空提示，不阻断 | PASS | `scenario-loader.spec.ts:178-198`（缺 `phases/resolve.md` 仍加载、warning、`phaseNotes` 有 probe） | — |
| D-9 | region 不存在→全身降级 + 审计 | PASS | `scenario-beat-plan.spec.ts:210/:220/:228`；`scenario-resolve.spec.ts:298`（`degraded='no-region-match'`）；`execution-executor.spec.ts:233` warnings 入 `plan_resolved` | 加载期 intent.region 未声明=error（§8.7 #6）；运行期 plan region 走降级 |
| D-10 | 引擎版本不兼容→拒绝加载并提示升级 | PASS | `scenario-loader.spec.ts:161`；`scenario-validate.spec.ts:154` | — |
| D-11 | freeform=单阶段+默认意图+默认 aftercare | PASS | `scenario-loader.spec.ts:94`；`play.ts:1216/:1225` 合成单阶段与 `DEFAULT_INTENTS`；`scenario-default-intents.spec.ts:50/:122`；`play.spec.ts:187/:205` | — |
| E-1 | 六种 endReason 正确落账 | PASS | `memory-ledger.spec.ts:99` | — |
| E-2 | 不读账本→开场与无账本一致 | PASS | `memory-ledger.spec.ts:169` | — |
| E-3 | 读账本→metaReactions 命中 opening brief | PASS | `memory-ledger.spec.ts:189`；`play.spec.ts:786`；`m2-e2e.spec.ts:592` | — |
| E-4 | 人类设 X→policy.json；BF 按 min(policy,X)；审计 policy_change；恢复是人工 | PASS | `policy.spec.ts:42/:133/:158/:226`；`play.spec.ts:266/:817`；`policy-file.spec.ts:51`；`m2-e2e.spec.ts:631`；`coyote-backend.spec.ts:349`（BF=percentToStrength(15)=30）、`bootstrap.ts:562` 以 `policy.effective` 供 BF | 真郊狼字节需人工；DLC 机制 M2 不存在，内容包路径已夹紧 |
| E-5 | 删账本后下次开场中性 | PASS | `memory-ledger.spec.ts:219`（cut marker，不重写旧字节） | — |
| F-1 | 模型工具面 0 个 percent 字段（9 个全查） | PASS | `agent-tools.spec.ts:95`（12 定义/9 暴露）、`:113`（set_* 不在）、`:185`（仅允许 change.targetPercent/deltaPercent，§8.8 #6） | — |
| F-2 | 执行器收 DeviceRegistry；line 不影响派发 | PASS | `execution-executor.spec.ts:149`、`:166` | — |
| F-3 | LOCKED 拒一切触发（仅 stop/unlock/panic） | PASS | `engine-scheduler.spec.ts:231`；`engine-turn.spec.ts:82`；`registry.spec.ts:178` | — |
| F-4 | 审计/账本 append-only，无改写删除 API | PASS | `devices/audit.ts:35-48` 只有 `record`；`ports/storage.ts` `AppendOnlyStore` 只有 `append`；`node-storage.spec.ts:19`；`memory-ledger.spec.ts:219`（clear 只写 marker） | 结构 + 测试 |
| F-5 | 8 回合可回放、账本一行、存档一份 | PASS | `m2-e2e.spec.ts:371`（8 回合）、`:435`（恰一行账本/一份快照） | — |
| F-6 | 无感知源 + 无设备跑“纯叙事一局”不报错 | **NO-EVIDENCE** | 仓库无此会话级用例；本次审计临时探针（零 source/零 device + 无工具 runner）跑通 `start→message→end`，状态 idle/2/ended 无异常 | 行为已见可行，缺的是把它固化成 spec；现有 play/e2e 用例均带 mock 设备 |
| F-7 | `pnpm run check` 全绿；既有测试只增不删 | PASS | 两包 tsc 0；634+161 全绿；基线 341 个唯一 `it` 名 0 缺失；M2 期间 0 个测试文件被删；见 §5 | 字面 `pnpm` 不可用，按脚本体等价复跑 |

## 4. §5.4 四个 Demo

| Demo | 判定 | 依据 / 缺口 | 复现或最小手工步骤 |
|---|---|---|---|
| A1 感知 | **MANUAL** | 逻辑由 `camera-host.spec.ts:83/121/142`（fake IPC）、`dashboard.spec.ts:548/561` 覆盖；真 USB/光照/拔线无法沙箱判定 | `corepack pnpm --filter @embodied/desktop dev` → 用日志 token 开控制台 → 感知面板看 `usb-cam-1`/`quality:ok`、挥手 `motionEnergy` 上升、遮镜头 `dim`、对灯 `bright`；`GET /api/sensors/frame?sourceId=usb-cam-1` 取 JPEG；拔 USB 看 `unavailable` 且下回合提示词无感知段 |
| A2 被动探测 | **MANUAL** | verdict/阈值/审计/投影有测试（§3 A-2/3/4/5）；15s wave + 真人动作/遮镜头必须真机 | 对一通道跑 15s wave，3.5s 后开调试 `GET /api/debug/probes` 看 verdict；审计尾行 `actor:system, action:reaction_probe` 含 baseline/window/delta；挥手→`responded`，不动→`none`，遮镜头→`unavailable` 且探测段消失 |
| B1 单次 tool-calling | **可离线（无专用脚本，部分）** | `play.spec.ts:187/:368/:470`、`dashboard.spec.ts:784`、`m2-e2e.spec.ts:371` 覆盖包目录开局、消息、夹紧；**第 5 步（非法 intent 仍出词）无端到端用例 = B-5** | 测试复跑：`cd apps/desktop && node ../../packages/core/node_modules/vitest/vitest.mjs run tests/play.spec.ts tests/m2-e2e.spec.ts`；人工版：装 freeform 包→`POST /api/session/start`→`/message`→审计看 `plan_resolved`，`/api/session/ceiling` 设 5 后再发→`clamped` |
| B2 总演示 | **部分脚本化 + MANUAL** | `scripts/demo-m2.mjs` 覆盖 4/9 步（开场、pause/resume、X=20 夹紧、结束/账本/快照）；未覆盖：choice、writer 抢占、state_patch/get、metaReactions 重开、恢复 X、kill/重启；**第 6 步 aftercare 未接线（`play.ts:830/:867`）** | 脚本：`node scripts/demo-m2.mjs`（exit 0）。其余：真 Chromium 跑 `play.html`（§8.13③ 未验）；真郊狼验证 cap20→BF 0x28(40)、cap35→BF 0x46(70)、降 X 后 BF 重写、结束归零；kill 进程看重启 `unexpected_exit` 且不重放 |

> Demo B2 结论：**不能按计划原文判定通过**——aftercare 缺失是代码事实，非环境限制；其余硬件/浏览器项转人工。

## 5. 基线对比与“只增不删”

| 节点 | core 静态 `it` 数 | desktop 静态 `it` 数 | 说明 |
|---|---|---|---|
| `25b991a`（计划提交） | **263** | **84** | 与计划“263+84”逐字一致 |
| `eff3966`（wave 1） | 406 | 87 | 计划 §8.7 记 406/87 |
| `6ef15ee`（wave 4） | 579 | 119 | 计划 §8.9 记 579/119 |
| `e2a9dec`（wave 5） | 618 | 125 | 计划 §8.10 记 618/125 |
| `abf428f`（wave 6） | 627 | 142 | 计划 §8.11 记 627/142 |
| `35d4579`（wave 7） | 634 | 152 | 计划 §8.12 记 634/152 |
| `56ad5ef`（HEAD） | **634** | **161** | 计划 §8.13 记 634/161 |

- `git diff --name-status 25b991a..HEAD -- packages/core/tests apps/desktop/tests`：**0 个删除**（53 个新增文件含 fixtures/fakes）。
- 基线全部 341 个唯一 `it` 标题逐一比对 HEAD：**0 个缺失**；测试中 `it.skip/describe.skip/it.todo` = 0。
- 结论：**“只增不删”成立**；当前 vitest 实际 634 + 161 与静态计数一致。

## 6. 必须由人类完成的事项

1. **真机 USB 摄像头 / Demo A1**：按 §4 A1 步骤跑一遍（含拔插与遮光），确认 `quality` 与 `unavailable` 降级、`/frame` JPEG。
2. **真机摄像头 + 真人动作 / Demo A2**：15s wave 后挥手/静止/遮镜头，核对 `responded/none/unavailable` 与提示词探测段。
3. **真 Chromium UI**：打开 `http://127.0.0.1:<port>/play`（`Ctrl+Alt+P`）与控制台、手机页，验证渲染、选项按钮、debug 面板、手机急停（DOM shim 测试不等于真浏览器）。
4. **真郊狼 / BF**：设 X=35、cap A=20 → BF 应编码 40（0x28）；cap A=35 → 70（0x46）；降 X 后 BF 立即重写；结束/急停后硬件为 0。可用 BLE 抓包或设备体感核对。
5. **真实 LLM key**：`EMBODIED_LLM_API_KEY=<key>` 跑一局 OpenAI 兼容 provider（tools + 流式），确认工具面 9 个、非法 plan 不中断；检查 `audit/device.jsonl` 与提示词中无 key。
6. **真实崩溃**：Demo B2 第 9 步用任务管理器 kill 主进程后重启，确认账本 `unexpected_exit`、未完成回合不重放、`state/policy.json` 保留最后人工值。
7. **真实手机急停**：手机浏览器开 `/phone`，大按钮 `POST /api/panic`，确认设备归零 + `locked` 横幅。

## 7. 签字意见

- 可以确认：感知/探测/解析/执行/回合/调度/存档/账本/内容包/工具面的软件实现与 48 项验收面**基本达标**（45/48），基线未回退。
- 不可签字项：**D-6（UI 标注缺失）**、**B-5 / F-6（仓库缺固化用例，行为探针已通过）**、**Demo B2 aftercare 未接线**、以及 §5.4 的真机/真浏览器人工项。
- 建议：补 D-6 一行 UI 文案、补 B-5/F-6 各一个用例、把 `pack.scenario.session.aftercareMin` 接入 `TurnEngine` 并在 ledger 记真实 aftercare 后，再走一次本清单即可签字。

## 9. 验收后修正与复评（Lead，2026-11-02）

上表 §1–§3 是对 `56ad5ef` 的审计结论。审计后已闭合全部 FAIL / NO-EVIDENCE 项：

| 项 | 修正 | 复评证据 | 判定 |
|---|---|---|---|
| D-6 | 游玩页状态面板新增「边界」行；`boundaries` 为空时显示「使用全局边界」 | `apps/desktop/src/ui/play.html` 新增 `<dt>边界</dt>`；`play.js` 含「使用全局边界」渲染分支（grep 命中）；快照新增 `boundaries` 字段 | PASS |
| B-5 | 新增端到端用例：非法 intent 的 beat 被丢弃、只派发合法 beat、台词照出 | `packages/core/tests/agent-loop.spec.ts › invalid beats are dropped without silencing the turn (B-5)` | PASS |
| F-6 | 新增用例：零感知源 + 零设备跑完 start→message→end | `apps/desktop/tests/play.spec.ts › narrative-only session with no sensors and no devices (F-6)` | PASS |
| aftercare 宿主接线 | `play.ts` 对 `scenario` 包按 `session.aftercareMin` 接入引擎 aftercare 守卫（freeform 不等待，避免宿主 stall）；账本 `aftercare` 字段如实反映是否执行 | 引擎侧 `engine-autopilot.spec.ts:270` 已覆盖"held ending for the minimum aftercare duration"；B2 demo 第 6 步可演出 | 接线完成 |

顺带闭合：审查 **S-7**（loop 丢弃 `result.text`）——非流式 runner 的文本不再让回合失声（同一 B-5 用例覆盖）。

**复评汇总**：**PASS 48 / FAIL 0 / NO-EVIDENCE 0**；基线只增不删结论不变（core 635、desktop 162，341 个基线 it 名 0 缺失）。仅剩 §6 的**人工/硬件项**（真机摄像头、真 Chromium 渲染、真郊狼 BF、真实 LLM key、真 kill/重启、手机急停），其步骤已在 §6 与计划 §5.4 给出。
