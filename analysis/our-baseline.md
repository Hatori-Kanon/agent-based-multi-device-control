# 我方项目现状盘点（以代码为准）

> 盘点对象：`Embodied Roleplay`（工作区根，git HEAD `fea2776`，branch `main`）与 `coyote-hub/`（无 git，工作区未跟踪目录）。
> 盘点方式：**只读**。未运行任何测试、未安装依赖、未构建。行号均基于本次读取时的文件内容（HEAD `fea2776` + 工作区未提交改动）。
> 日期：2026-11-01。盘点人：our-baseline（供 Lead 综合）。

## 结论摘要（给 Lead 的 10 条）

1. **主工程实际完成度 = M0 + M1 + 一部分 M3**。设计文档把 MonsterParty / 安可尼直连排在 M3（`设计文档.md:347-348`），但代码里已实现 5 个真实后端 + mock（第 1.4 节），所以**代码领先于里程碑表**。
2. **M2 的全部内容（agent 循环 / providers / 11 tools / 三层剧本 / feedbackIntents / sensors / phone-web / state store）在代码中为 0**。不是"部分完成"，是目录与依赖都不存在（第 2 节逐项反证）。
3. **测试实际是 core 263 条 / desktop 84 条**（grep 统计，第 1.6 节），与最近提交 `6747c03` 的 commit message "core 263 / desktop 84 green" 一致；README 里的 249/68 已过期。
4. **安全骨架是真实的、可按行抽查的**：per-device 串行队列、generation token、LOCKED latch、append-only 审计、`BF` 连接即写失败即拒控。第 3 节 18 条决策全部有代码落点。
5. **发现 1 处"文档写了、代码做了相反决定"的实质矛盾**：README/设计文档说郊狼物理滚轮的外部改动会被**采纳**，代码与测试明确**不采纳**（`backend.ts:346-349`、`coyote-backend.spec.ts:302`）。这是本次最重要的文档失真（附录 A8）。
6. **发现 1 处能力承诺未兑现**：`设计文档.md:234` 说 `ChannelPolicy` "落盘"，实际 `PolicyStore` 只在内存，重启回默认 20/80/60（附录 A9）。这会直接影响长会话体验。
7. **coyote-hub 是一个"砍掉安全层、放大互操作层"的自包含分支**：无 `BF`、无审计、无 LOCKED、无波形库、无持久化、无 agent（第 4.3 节逐条证据）；但它有**多设备管理 + 稳定对外 HTTP/WS API + 每通道频率上下限 + Hz 语义 + 同名设备配对排除**，这四样主工程反而弱。
8. **两工程在协议层重复实现**（V3 B0/B1、Web Bluetooth 桥），但**接口层互补**（coyote-hub 无 `@embodied/core` 依赖，见 4.4）。短期不建议合并，建议按第 5 节做点对点反哺。
9. 对外部方案（AI-for-Coyote）最值得吸收的落点是：**SocketAPI v4 中继后端 + 设备自报状态（comfortLimit/overheat）+ 每通道 step 限制 + 传感器反馈闭环 + 内容包（剧本 DLC）**，落点模块见第 5 节表。
10. 文档与代码矛盾共 **14 条**（附录 A）：其中 **A8（滚轮"采纳"）、A9（policy "落盘"）是两项实质矛盾**，A6/A14 是项目内部自相矛盾，其余 10 条为数字/目录/命名/注释滞后。

---

## 0. 盘点方法与口径

### 0.1 范围与命令

| 对象 | 范围 | 读取方式 |
|---|---|---|
| 主工程 core | `packages/core/src/**`（33 个 .ts，6239 行）、`packages/core/tests/**`（13 个 spec，4112 行） | `ops_read_files` / `grep -nE` |
| 主工程 desktop | `apps/desktop/src/**`（.ts/.js/.html，3954 行）、`apps/desktop/tests/**`（7 个 spec，1547 行） | 同上 |
| 主工程文档 | `README.md`、`设计文档.md`、`波形系统设计.md`、`剧本系统设计.md`、`项目分析报告.md` | 全文读取（1422 行） |
| git | `git log --oneline -20`、`git rev-list --count HEAD` | 27 个提交：8-21 一次，8-22 二十六次 |
| coyote-hub | `README.md`、`src/**`（8498 行）、`docs/API.md`、`docs/INTEGRATION-four-nights.md`、`tests/**` | 同上 |

未做的事（遵守任务约束）：`vitest run`、`pnpm install`、任何 build、任何写现有文件。产出仅本文件。

### 0.2 证据规则

- **"已实现"**：必须给出 `文件:行号`，且该行是定义/调用/断言，不是注释承诺。
- **"未实现"**：必须给出反证方式（目录不存在 / 文件不存在 / grep 无命中 / 依赖清单没有）。
- 文档（README、设计文档）只作线索，**不作为实现证据**；文档与代码冲突时一律以代码为准，并在附录 A 单列。

### 0.3 测试数量统计方法（可复现）

```bash
# 主工程 core：统计每行 it( 出现次数（含 it.each 之外的所有写法）
grep -rhoE '\bit\(' packages/core/tests/*.spec.ts | wc -l        # → 263
# 主工程 desktop
grep -rhoE '\bit\(' apps/desktop/tests/*.spec.ts | wc -l         # → 84
# coyote-hub
grep -rhoE '\bit\(' coyote-hub/tests/*.spec.ts | wc -l           # → 137
# 交叉验证：没有 skip/todo/only，没有 it.each
grep -rnE '\b(it|test|describe)\.(skip|todo|only)' packages/core/tests apps/desktop/tests coyote-hub/tests
```

口径说明：`grep -c 'it('`（按行计数）会漏掉同一行里的多个 `it(`；本次改用 `grep -o` 统计**出现次数**。这正好抓到 desktop 的 1 条：`apps/desktop/tests/bootstrap.spec.ts:393` 把 `describe(...) { it(...) }` 写在同一行，所以 desktop 是行数 83 + 1 = **84**。core 13 个 spec、desktop 7 个 spec、coyote-hub 8 个 spec，均为 vitest 单测，无 E2E。

---

## 1. 已实现能力清单（按模块，带 `文件:行号`）

### 1.1 core 安全运行时（`packages/core/src/devices/`）

| 能力 | 证据 | 说明 |
|---|---|---|
| `DeviceRegistry` 是模型写设备的唯一入口 | `packages/core/src/devices/registry.ts:127`（类）、`:677-694`（`prepare()`：LOCKED / 通道存在性 / `level` 类型 / `ready` 状态四项门禁） | 注释写明顺序：lock → channel → policy → effect → per-device queue → final clamp → audit（`registry.ts:1-16`） |
| 每设备一条串行队列，设备间并行 | `registry.ts:153-160`（`DeviceState.queue = new SerialQueue()`）、`:663-673`（`write()` 唯一落队列）；`packages/core/src/devices/queue.ts:1-11`（注释：BLE 一次一个未完成写；不同设备并行；停止可 priority 插队）、`:34`（`enqueue(task, priority)`） | 对应"多设备并行"需求 |
| `setLevel` 是 `steady` 包络的糖 | `registry.ts:360-386`（构造 `preset:'steady'` 后走同一 `EffectRunner`） | 注释解释：只有一条调度路径和一套 generation 机制（`registry.ts:10-12`） |
| `runPattern` 后台包络 + 可选波形 | `registry.ts:389-416`（`clampEnvelopeToCap` → 校验 → 可选 `selectWaveform` → `runner.start`） | 作者内容在 cap 内运行而不是被拒（`:390-391`） |
| `setWaveform` 纹理与幅度解耦 | `registry.ts:425-435`、`:437-458`（`selectWaveform`：非波形通道报 `WRONG_CHANNEL_KIND`） | |
| 单通道 / 单设备 / 全局停止 | `registry.ts:465-486`（`stop`，LOCKED 下仍允许） | |
| 急停 + LOCKED latch | `registry.ts:495-512`：先置 `locked=true`（`:496`）→ 取消全部 runner → **先写审计**（`:501`）→ 每设备 priority 队列 `stopAll()` | 审计先于传输，链路卡死也不丢事件 |
| 只有人类能解锁 | `registry.ts:515-524`（`unlock(_actor: 'human', …)`） | 类型层面只接受 `'human'` |
| 人工改 cap + 立即生效 | `registry.ts:527-542`（审计 before/after）→ `:553-573`（`applyPolicyChangeNow`：`invalidate()` + `applyBounds()` + 立即重写当前电平） | 修复"steady 去重导致降 cap 不生效" |
| 关闭：先急停再关传输 | `registry.ts:612-629` | `shutdown()` = `emergencyStop('shutdown')` + 逐设备 `close()` |

`EffectRunner`（`packages/core/src/devices/effect.ts`）：

- 每 `(device, channel)` 一个实例、5 种 preset（`steady|pulse|wave|random|ramp`）：`effect.ts:164`（类）、`:29`（preset 类型）。
- **generation token**：`:165`（`private generation = 0`）、`:196-208`（`start()` 先 `++generation` 再起 ticker，旧 tick 全部失配）、`:258-273`（`tick(generation)` 与 `:267` 二次校验，旧效果的终止零不会打到新效果）、`:212-218`（`cancel()` 也自增）。
- emit 合并（last-write-wins）：`:288-315`（`request()` / `drain()`，写超时丢中间值）。
- 去重与重试：`:171-179`（按"最后请求值"去重而不是"最后写入值"）、`:303-310`（写失败清掉去重记忆，下一 tick 重试）。

`SafetyPolicy`（`packages/core/src/devices/policy.ts`）：

- 绝对上限：`ABSOLUTE_MAX_PERCENT = 100`（`:13`）、`ABSOLUTE_MAX_WAVE_INTENSITY = 100`（`:20`）、`ABSOLUTE_MAX_DURATION_SEC = 600`（`:22`）。
- 默认值：`maxPercent 20 / maxWaveIntensity 80 / maxDurationSec 60`（`:50-54`）。
- 校验即拒绝：`assertLevelWithinPolicy`（`:92-108`，`percent===0` 必须 `durationSec===0`；**不允许无限输出**）、`assertValidPolicy`（`:69-83`）。
- 发射端最终夹紧且 fail-closed：`clampPercentToPolicy`（`:117-120`，`NaN/Infinity` 归 0 而不是归 cap）。
- **人类专属入口**：`PolicyStore.setByHuman`（`:127`、`:145-155`）——全仓库没有 `setByModel`（`grep -rn "setByModel" packages apps` 无命中）。

`AuditLog`（`packages/core/src/devices/audit.ts`）：

- append-only 且 `record()` 永不抛：`audit.ts:2-7`（类注释）、`:35`（类）、`:48-69`（`record()` 内部两处 try/catch，序列化失败降级成不带 detail 的行仍写）、`:71-78`（失败回调自身异常也吞掉）。
- actor 三值 `model|human|system`：`:14`；result 三值：`:17`。
- 代码中实际写入的 action 共 16 种（grep `action: '…'`）：`connect / scan / set_level / run_pattern / set_waveform / stop / panic / unlock / policy_change / raw_write / channels_changed / device_removed / link_lost / emit_failed / effect_finished / shutdown`。

### 1.2 平台边界（`packages/core/src/ports/`）

- `ble.ts`（94 行）、`clock.ts`（35）、`http.ts`（37）、`storage.ts`（46）、`websocket.ts`（36）是唯一平台边界；对应测试替身 `mock-ble.ts`（179）、`fake-clock.ts`（85）、`mock-websocket.ts`（94）齐全（`packages/core/src/index.ts:10-28` 导出）。
- 这解释 core 为何"零平台 API"：`packages/core/package.json` 的 dependencies 为空（只有 devDependencies: typescript/vitest/@types/node）。

### 1.3 波形子系统（`packages/core/src/waveform/`）

| 能力 | 证据 |
|---|---|
| 帧模型：4×25ms 槽 = 100ms 帧，freq 10–240 / intensity 0–100，最多 600 帧 | `waveform/types.ts:16,18,19`；`:22-23`；`:32-36`；`:42-45`（`PulseFrame`） |
| 段落 DSL → 逐 25ms 槽编译，4 种曲线 | `waveform/dsl.ts:28`（`linear/easeIn/easeOut/step`）、`:178`（`compileWaveformScript`） |
| hex 导入/格式化（厂商 16 进制互换格式） | `waveform/hex.ts:41`（`parseHexFrame`）、`:79`（`parseHexFrames`）、`:71`（`formatHexFrame`） |
| 发射端按通道 cap 夹紧（只夹 intensity，不动 freq） | `waveform/clamp.ts:31`（默认 80）、`:34-49`（`clampFrameIntensity`）、`:51`（`clampWaveformIntensity`） |
| library / session 双作用域，64 条 session 上限 | `waveform/library.ts:24`（`MAX_SESSION_WAVEFORMS=64`）、`:74`（类）、`:112-126`（`author` 只写 session）、`:145-155`（`promoteByHuman` 是唯一入库路径，注释："Human action only. There is no agent-reachable equivalent."）、`:155-160`（`clearSession`）、`:163-175`（`exportLibrary/loadLibrary` 供宿主落盘） |
| 7 个内置波形（2 个厂商公开数据表 + 5 个 DSL 自创） | `waveform/builtin.ts:18-31`（呼吸 hex 表）、`:34-58`（潮汐）、`:66-131`（试探/涌动/绵延/骤雨/攀升 5 个 DSL）、`:139-169`（`createBuiltinWaveforms` 组装 2+5） |

### 1.4 后端清单（`packages/core/src/backends/`，共 6 个 backend 实现）

| 后端 | 传输 | 通道 | 保活/失效语义（代码级） | 波形 | 证据 |
|---|---|---|---|---|---|
| **coyote**（DG-LAB Coyote V3） | BLE 直连（Web Bluetooth 经桥） | `a`、`b`（均 `level` + `supportsWaveform`） | **100ms `B0` 流 = 硬件 dead-man**；连接即写 `BF`，写不进则拒控 | ✅ `applyWaveform` | `backends/coyote/backend.ts:6-12`（两条协议事实）、`:157-187`（connect：先 `BF` 再起 100ms ticker）、`:76-79`（无波形时的默认 plain frame）、`:198-207` |
| **xhtkj**（谜姬直连 BLE） | BLE 直连 | `primary` +（识别后）`secondary`；标签随 capability | **无硬件 dead-man**，一包定值 | ❌（厂商波形不暴露，`backend.ts:18-22` 说明理由） | `backends/xhtkj/backend.ts:11-16`（no dead-man / 百分比非线性）、`:161`（`outputFloorPercent`） |
| **monsterparty**（云中继） | WebSocket 到 `api.monsterparty.cc` | `vibration` + 可选 `suction`（pid 含 DS） | **无 dead-man**；`op:8` 应用心跳只保中继 | ❌ | `backends/monsterparty/backend.ts:8-20`（三条运维事实：无 dead-man / 单次 token / 禁用协议层 ping）、`:39`（`OP_HEARTBEAT=8`）、`:52-53`、`:355`（9s 心跳，可配） |
| **buttplug / Intiface** | WebSocket 到本机引擎 | **集线器**：每 scalar feature 一个 `level`，含 `scan` 与 `onChannelsChanged` | **无 dead-man**；`MaxPingTime/2` 保活引擎 | ❌ | `backends/buttplug/backend.ts:64`、`:159`（`scan`）、`:176`（`applyLevel`）、`:197`（`onChannelsChanged`）、`:328-329`（`maxPingTime/2`） |
| **ankni**（安可尼 stream，新增于 `6747c03`） | BLE 直连，复用谜姬族布局（0xdddd/ddd1） | 单 `rotation` 通道 | **流式 = dead-man**（停喂帧即衰减） | ❌ | `backends/ankni/backend.ts:1-14`（族与安全性质）、`:58`、`:112-116`（默认 200ms ticker）、`:160-203`（所有写串进 writeChain，防 GATT 并发） |
| **mock**（M0 用） | 内存 | 可配 | **双语义**：`keepAliveMs` 有 = 流式（停刷新归零）；无 = 有状态（宿主死了还在输出） | ❌ | `backends/mock/index.ts:1-14`（语义说明）、`:52`、`:168-171`（`simulateHostDeath`：不写零、只停刷新循环） |

补充：`xhtkj` 的通道能力/pid 解析与 `outputFloorPercent` 在 `backends/xhtkj/protocol.ts:144-159`；`ankni` 协议帧编解码在 `backends/ankni/protocol.ts`；`coyote` 协议编解码在 `backends/coyote/protocol.ts`（BF/B0/B1、`percentToStrength`、`SILENT_*`）。

### 1.5 desktop 宿主（`apps/desktop/src/`）

**BLE 三层桥**（Web Bluetooth 只存在于渲染进程）：

- `main/ble/bridge.ts`：可单测编排层——`hexToBytes`（`:61`）、`BridgedPeripheral`（`:82`，每特征共享一个订阅 `:107-166`、断连扇出 `:145-156`）、`BridgedBleTransport`（`:171`）。
- `main/ble/electron-bridge.ts`：Electron 胶水——隐藏 worker 窗口（`:282`）、`executeJavaScript(code, true)` 提供 user gesture（`:125`）、`select-bluetooth-device` 先收 3s 候选再择优（`:229-233`、`:300`）。
- `renderer/ble.js`（198 行）：worker 页面内 `navigator.bluetooth` + GATT 对象常驻（`:8-9` 的 `links` Map、`:115-120` 断连清理）。

**dashboard HTTP API**（控制台本体，`main/dashboard.ts`）：

- 鉴权：`x-control-token` 头或页面 URL `token=` 查询参数（`:75-89`），token 长度下限 16（`:178`）；**静态页豁免 token**（`:244-250`，注释解释 `<script src>` 带不了头）。
- 绑定：默认 `127.0.0.1`（`:182`，`server.listen(port, host)` 在 `:203`）。
- 路由（`:283-427`）：`GET /api/snapshot`、`GET /api/waveforms`、`GET /api/audit`、`GET /api/errors`、`GET /api/logs`、`GET /api/devices`、`POST /api/devices`（添加）、`POST /api/devices/remove`、`POST /api/devices/raw`（人肉协议实验）、`POST /api/panic`、`POST /api/unlock`、`POST /api/cap`、`POST /api/demo`（15 秒试跑，`bootstrap.ts:477-484`）、`POST /api/stop`、`POST /api/connect`、`POST /api/scan`、`POST /api/waveforms/import|promote|select`、`POST /api/pattern`。
- 静态文件目录逃逸防护：`:161-166`（`resolve` 后要求 `startsWith(staticDir + sep)`）。

**panic server（带外急停，独立服务器/独立 token）**：`main/panic-server.ts`——token 至少 16 字符（`:96`）、默认绑 `127.0.0.1`（`:103`）、比较用等长常量时间式（`:34-45`）、`POST /panic`（`:139-150`）；与 dashboard 分离（`dashboard.ts:8-10` 注释说明理由）。

**持久化**：`main/node-storage.ts`——`FileAppendOnlyStore`（`:19`，promise 链串行追加，`:26-40`）、`FileDocumentStore`（`:73`，temp + rename 原子写 `:93-96`）、`readAuditTail`（`:48`，只读尾部）。宿主实际落盘的文件只有 4 类：`state/devices.json`（`bootstrap.ts:236,239`）、`state/panic.json`（`:458`）、`state/dashboard.json`（`:530`）、`state/waveforms.json`（`:535`）+ `audit/device.jsonl`（`:198-202`）。

**Intiface 进程礼仪**：`main/intiface.ts`——先探测端口，只有没人监听才 spawn（`:64`、`:98`、`:113`）；只杀自己启动的进程，SIGTERM→2s→SIGKILL（`:163-175`）；找不到引擎返回 `unavailable` 且不阻塞启动。**不实现**自动下载（`:8-22` 注释与 README:195-203 一致）。

**热键 / 生命周期**：`main/index.ts`——`PANIC_ACCELERATOR = 'Control+Alt+X'`（`:19`）、`globalShortcut.register(...)` 直达 `runtime.panic('global-hotkey')`（`:234-241`）、`before-quit`（`:167-172`）、`will-quit` 注销热键（`:174`）、`SIGINT/SIGTERM`（`:180-184`）。

**无 Electron 的开发服务器**：`src/dev-server.ts:1-12`（同一 runtime + 同一套静态 UI，纯 Node，mock 设备）、`:19-26`（`EMBODIED_DATA_DIR` / `EMBODIED_DASHBOARD_PORT`、`withPanicServer:false`、`withButtplug:false`）、`:47-52`（`EMBODIED_OPEN_BROWSER=1` 自动开浏览器）。

**设备清单**：`bootstrap.ts:145-149` 内置 3 个 well-known（coyote / xhtkj / `ankni`+`bleName:'ANKNI ZKRXB'`），版本迁移只注入一次；协议工厂 `:276-345`；MonsterParty 注册 `:352-359`；Buttplug 由 Intiface 探测决定 `:368-380`；**添加/移除设备走 `:393-438`**（添加时只打开一台，移除即停输出并断开）。

### 1.6 测试数量与验收覆盖

| 包 | spec 文件数 | test case 数 | 主要覆盖 |
|---|---|---|---|
| `packages/core` | 13 | **263** | registry 20、effect 19、waveform 32、policy 13、queue 4、coyote-backend 22、coyote-protocol 17、xhtkj-backend 28、xhtkj-protocol 30、monsterparty 27、buttplug-backend 26、buttplug-protocol 19、ankni-backend 6 |
| `apps/desktop` | 7 | **84** | ble-bridge 21、bootstrap 17、dashboard 12、intiface 8、node-socket 7、node-storage 10、panic-server 9 |

M0/M1 验收项在测试里有直接对应（可抽查）：

- generation token 竞态：`packages/core/tests/effect.spec.ts:168`（"does not let a superseded effect stop a newer one"）、`registry.spec.ts:258`（"survives replacing an effect just before its deadline"）。
- 上限下发前拒绝且 `writes` 长度不变：`registry.spec.ts:80`（"refuses a level above the human cap and writes nothing"）、`registry.spec.ts:99`（"refuses indefinite output"）。
- 急停后 LOCKED、停止仍可用、只有人类解锁：`registry.spec.ts:177`；latch 前入队写入不复活：`registry.spec.ts:216`。
- 流式硬件自动归零 vs 有状态硬件继续输出：`registry.spec.ts:345`、`registry.spec.ts:366`（后者名字直接写着"which is why a host-side timer is not enough"）。
- 两通道各跑不同 pattern 且可单独取消：`registry.spec.ts:295`。
- agent 创作波形被夹紧：`coyote-backend.spec.ts:511`、`effect.spec.ts:97`。
- 断 BLE 后状态恢复：`coyote-backend.spec.ts:551`、`registry.spec.ts` 的 link-lost 用例。
- `BF` 写失败拒绝进入可控状态：`coyote-backend.spec.ts`（bounds 段，`:536` "re-asserts the hardware ceiling when a human moves the cap"）。

---

## 2. M2 及以后尚未实现的部分（以代码为准，不以文档承诺为准）

**总判断：M2 全部为 0；M3 的"多后端"已提前完成；M4/M5/M6 全部为 0。**

| # | 设计文档承诺 | 代码现状 | 反证方式（可复现） |
|---|---|---|---|
| 2.1 | agent 主持循环（`loop.ts`，AI SDK + tool loop） | **不存在** | `packages/core/src/agent/` ABSENT（`ls packages/core/src` 只有 `backends devices ports waveform index.ts`）；`grep -rn "ai sdk\|@ai-sdk\|vercel" packages apps` 无命中；全部 workspace 的运行依赖只有 `@embodied/core`（workspace 内）与 `ws`（`apps/desktop/package.json:16-19`），core 自身无 dependencies |
| 2.2 | providers 注册（deepseek/openai/anthropic/google） | **不存在**，无任何模型 API 依赖 | 同上；`grep -rni "deepseek\|openai\|anthropic\|gemini" packages/core/src apps/desktop/src` 仅命中注释 |
| 2.3 | 11 个模型可见工具（zod schema） | **不存在**，全仓库零工具定义 | `packages/core/src/agent/` 不存在；`grep -rn "zod" packages apps --include=*.ts --include=*.json`（排除 node_modules）无命中；看不到任何 tool/schema 注册代码 |
| 2.4 | 三层剧本加载 `scenario/loader.ts`（host/scenario/state） | **不存在** | `packages/core/src/scenario/` ABSENT；根目录 `host/`、`scenarios/` ABSENT |
| 2.5 | 加载期校验 `scenario/validate.ts`（阶段可达图等，`剧本系统设计.md:158-169`） | **不存在** | 同上；`grep -rn "phases\|advanceWhen" packages apps --include=*.ts` 无命中 |
| 2.6 | 阶段推进与漂移检测 `scenario/phases.ts` | **不存在** | 同上 |
| 2.7 | `feedbackIntents` 运行时映射 `scenario/intents.ts`（`剧本系统设计.md:89-107`） | **不存在** | `grep -rn "feedbackIntent" packages apps --include=*.ts --include=*.js --include=*.json` 只命中 `packages/core/src/index.ts` 的一句注释；代码里没有该概念 |
| 2.8 | 轻量结构化存档 `state/store.ts` + `state_patch` | **不存在** | `packages/core/src/state/` ABSENT；dashboard 路由无 `/api/state`（`dashboard.ts:283-427` 全量路由可见） |
| 2.9 | 分层提示词组装 `agent/prompt.ts`（`剧本系统设计.md:173-186`） | **不存在** | 无 agent 目录；`grep -rn "system prompt\|prompt" apps/desktop/src --include=*.ts` 无命中 |
| 2.10 | sensors：命名感知源 + 新鲜度（`sensors/registry.ts`） | **不存在** | `packages/core/src/sensors/` ABSENT；`grep -rniE "sensor\|getUserMedia\|camera\|microphone" packages/core/src apps/desktop/src --include=*.ts --include=*.js` 只命中注释 |
| 2.11 | 帧快照原子写 `sensors/frame-store.ts` | **不存在** | 同上；只有 `node-storage.ts:69` 一行注释提到"未来的 sensor frame store" |
| 2.12 | `phone-web`（token + 急停大按钮 + `POST /frame`） | **不存在** | `apps/phone-web/` ABSENT（`apps/` 下只有 `desktop`）；dashboard 路由里无 `/api/frame`（`dashboard.ts:283-427`） |
| 2.13 | Android 瘦客户端 / 独立核心（M4a/M4b） | **不存在** | `apps/android/` ABSENT；全仓库无 `react-native`/`ble-plx` 依赖或代码 |
| 2.14 | 音频 M5（STT→TTS→环境音） | **不存在** | `grep -rniE "\bstt\b\|tts\|语音\|音频\|whisper" packages apps --include=*.ts --include=*.js` 无命中 |
| 2.15 | TCode（M6，motion 通道） | **不存在** | `packages/core/src/backends/tcode/` ABSENT；`ChannelKind` 定义了 `'motion'`（`devices/types.ts:20`）但 `grep -rn "'motion'" packages apps` 仅命中类型定义与错误文案，无 backend 实现 |
| 2.16 | `_reference/` 之外的内容包/剧本资产 | **不存在** | 根目录无 `waveforms/`、`scenarios/`、`host/`；`docs` 类资产只有 4 份设计 md |

**不是缺口的"明确不做"**（避免误判为未完成）：

- 会话级累计时长上限 / 强制冷却：设计明确不做（`设计文档.md:229`、`:390`），代码也没有。
- 通用设备驱动插件框架、跨设备时间线、可视化波形编排器（`设计文档.md:381-391`）：设计明确不做。
- Intiface 校验下载：明确不采用（`README.md:195-203`、`main/intiface.ts:8-22`），只保留"只停自己启动的进程"。

**旁证**：`apps/desktop/src/main/index.ts:69` 有一句"// M0 has no agent yet; this lets an operator confirm the runtime end to end."；`packages/core/src/index.ts:4-5` 仍写着"Waveforms, real backends, sensors, the agent loop, and the scenario system arrive in later milestones"——后半句（sensors/agent/scenario）是真的，前半句（waveforms/real backends）已过期（附录 A13）。

---

## 3. 关键设计约束 / 决策清单（18 条，均可在代码定位）

| # | 约束/决策 | 代码落点 |
|---|---|---|
| 1 | **policy 只能人类改**：`PolicyStore` 只有 `setByHuman`，全仓库无 `setByModel`；模型侧无任何可达工具 | `devices/policy.ts:127,145`；`grep -rn "setByModel" packages apps` 无命中 |
| 2 | **绝对上限连人类也不能越**：100% / 波形强度 100 / 单次 600s | `devices/policy.ts:13,20,22`；`assertValidPolicy` 拒越界 `:69-83` |
| 3 | **LOCKED latch**：急停后模型写入全拒，停止仍可用，只有人类 `unlock` 能解 | `devices/registry.ts:496-497`（置位）、`:677-694`（`prepare` 拒绝）、`:465-466`（stop 注释"Stops are permitted while locked"）、`:515`（unlock 签名 `_actor: 'human'`） |
| 4 | **latch 前入队的写不会复活输出**：写路径内二次检查 `locked && percent > 0` 直接 return | `devices/registry.ts:663-666` |
| 5 | **generation token**：被取代的效果不能关掉新命令；旧终止零被丢弃 | `devices/effect.ts:165,196-208,258-273` |
| 6 | **per-device 串行队列，设备间并行，停止可 priority 插队** | `devices/queue.ts:1-11,34`；`devices/registry.ts:153-160,663-673`（stopAll 用 priority `true` `:504-507`） |
| 7 | **保活/重发归 backend，不归 EffectRunner**：EffectRunner 只回答"此刻目标电平" | `devices/types.ts:1-9`（契约注释）；`coyote/backend.ts:100ms ticker`；`ankni/backend.ts:115` 200ms；`xhtkj/monsterparty/buttplug` 保活细节见 1.4 |
| 8 | **审计 append-only，且 `record()` 永不抛**（审计槽坏了不能挡住急停） | `devices/audit.ts:2-7,48-69`；desktop 落盘 `main/node-storage.ts:19-40`（串行追加） |
| 9 | **多后端失效语义必须显式区分**：只有郊狼是流式 dead-man；其余"宿主死了还在输出" | `coyote/backend.ts:6-12`；`xhtkj/backend.ts:11`；`monsterparty/backend.ts:8`；`buttplug` 属有状态；`mock/index.ts:1-14` 双语义 + `:168-171` `simulateHostDeath` |
| 10 | **limits 默认值**：20% / 波形强度 80 / 60s（20% 有 XHTKJ 实测依据） | `devices/policy.ts:50-54`；依据注释 `:39-49` |
| 11 | **波形分工**：创作/导入只校验协议范围（越界拒绝）；发射时才按 `maxWaveIntensity` 夹紧 | `waveform/dsl.ts:178`（编译期校验）、`waveform/clamp.ts:51`（发射夹紧）、`coyote/backend.ts:329`（每帧夹紧） |
| 12 | **撤销帧间强度跳变上限**（厂商预设本身 0↔100 方波，跳变限制会拒掉大多数社区波形） | 设计依据 `波形系统设计.md:162-170`；代码无该字段（`grep -rn "maxIntensityJumpPerFrame\|jump" packages/core/src` 仅命中 `jitter`） |
| 13 | **library / session 双作用域**：agent 只能写 session，入库唯一路径是人类 | `waveform/library.ts:112,145`；UI 文案也写明（`apps/desktop/src/ui/index.html:180`） |
| 14 | **`BF` 硬件软上限：连接即写，失败即拒控**（无回执、断电保存） | `coyote/backend.ts:157-187`（`writeBoundsNow` 在 subscribe 后、ticker 前，失败抛 `NOT_CONNECTED` 并 teardown） |
| 15 | **百分比跨后端不可比 → 发布 `outputFloorPercent`** | `devices/types.ts:36-48`（字段语义）；`xhtkj/protocol.ts:144-159`；快照暴露 `registry.ts:54-72` |
| 16 | **三条急停路径互不经过 agent**：全局热键 / 带外 `POST /panic`（独立 server+token）/ 被动停止发流 | `main/index.ts:19,234`；`main/panic-server.ts:1-14,96,103,139`；dead-man 由 backend 流保证 |
| 17 | **控制台：loopback + token；页面导航用 query token，API 用 header；静态文件有目录逃逸防护** | `main/dashboard.ts:75-89,161-166,182,244-251` |
| 18 | **单次命令必须有界时长，不允许无限保持**：`percent>0` 必须给 `durationSec`，上限 `maxDurationSec` | `devices/policy.ts:92-108`；`registry.ts:696-703` |

补充决策（实现时定案，值得保留）：

- `setLevel` 走同一套 envelope 机制而不是独立 auto-stop 定时器（`registry.ts:10-12` 注释里写着理由）。
- 发射端"按最后请求值去重"而不是"最后写入值"（`effect.ts:171-179`），否则终止零在途时新命令会被误判重复丢弃。
- cap 变更立即生效：`invalidate()` 去重记忆 + 立即重写 + 重下 `BF`（`registry.ts:544-573`）。
- 写失败计数达到 5 次判定链路丢失（`coyote/backend.ts:85-86,282-285`；`ankni` 同族）。

---

## 4. coyote-hub 现状

### 4.1 定位

- 从主工程"摘出"的**独立多郊狼中控**：`coyote-hub/README.md:3`（"把当前工作区大工程里的郊狼（DG-LAB Coyote V3）控制部分单独摘出来做成的独立软件"）。
- **自包含**：不 import `@embodied/core`（`grep -rn "@embodied" coyote-hub/src coyote-hub/tests coyote-hub/package.json` 无命中）；运行依赖只有 `ws`（`coyote-hub/package.json:24-26`）；独立 pnpm-lock、独立 start.bat/start-dev.bat、独立 vitest 配置。
- 只支持 V3 + Windows 桌面（`coyote-hub/README.md:9`）。
- **明确的安全立场**：只有一层保护——每通道软件上下限；不写 `BF`（`coyote-hub/README.md:11,166-175`）。

### 4.2 自身能力（每条带证据）

| 能力 | 证据 |
|---|---|
| **多设备管理**（逐台添加、命名、独立连接/断开/停止、同名设备配对排除） | `src/core/manager.ts:102`（`CoyoteManager implements Hub`）、`:107`（`slots: Map`）、`:111`（`pairing` 串行化，防两个配对同时打开选择器）、`:179`（`addDevice`）、`:199`（`connectDevice`）、`:227`（`removeDevice`）、`:246`（`renameDevice`）；`src/main/ble-bridge.ts` 的配对/排除编排、`src/main/electron-ble.ts:168-172`（`excludeDeviceIds` 传给 worker） |
| **绝对上下限**（强度 0–200、频率 1–100 Hz；UI/API 用 0–100% 映射到窗口） | `src/core/types.ts:17-27`（`ChannelBounds`）、`:166-172`（`LIMITS`）、`:179-184`（默认 0–100）；`src/core/channel.ts:33-45`（整体校验）、`:61-63`（percent 校验、**无夹紧**）、`:77-88`（percent→absolute，0% 绕过下限，非零至少 1）；`src/core/manager.ts:299-311`（改上下限立即下发，不等下一帧） |
| **HTTP REST + WebSocket 外部接口** | `src/main/server.ts:9-30`（路由清单注释）、`:348-466`（实际路由：`/api/status`、`/api/devices` CRUD/connect/disconnect/stop、`/api/devices/:id/channels/:ch/{control,on,off,stop,bounds}`、`/api/stop`、`/api/settings`）、`:662` 起（`/ws` 首帧 snapshot + 事件推流）；文档 `docs/API.md`（325 行）；示例 `examples/client.mjs` |
| **本地请求策略（无 token 但有 CSRF/DNS-rebinding 防线）** | `src/main/server.ts:539-587`：Host 必须是回环+当前端口（`:547,576`）、Origin 必须是回环页面/浏览器扩展（`:558-581`）、`Sec-Fetch-Site: cross-site` 拒绝（`:586-587`）、带 body 必须 JSON（`:199`）；只绑 `127.0.0.1`（`:76,91`） |
| **Web Bluetooth（Electron 隐藏 worker 窗口，零原生依赖）** | `src/main/electron-ble.ts:106`（`ElectronBleBridge`）、`:143`（user activation 说明）、`:229-233`（`select-bluetooth-device` 先开 3s 宽限窗收集候选再决定）、`:300` 起（chooser 事件处理）；`src/renderer/ble.js`（254 行）worker 内 GATT |
| **mock 传输（dev/测试不碰蓝牙）** | `src/main/mock-ble.ts:88`（`MockPeripheral`）、`:162-171`（解析 B0、`seq>0` 回 B1 强度）、`:205`（`createMockBleTransport`）；`src/dev.ts:43`（两个模拟设备）、`:66-79`（纯 Node 起 HTTP/WS） |
| **每通道频率窗口 + Hz 语义**（主工程没有的人可读层） | `src/core/protocol.ts:54-72`（1–100 Hz ↔ 协议周期字节 10–240 的分段换算，注释解释了"协议字段是周期不是频率"）；`src/core/channel.ts:85-88`（频率 percent→Hz） |
| **心跳超时（可选）**：外部超过设定时间没发命令 → 全部通道归零 | `src/core/manager.ts:113`（500ms ticker）、`:121`、`:630-659`（`checkHeartbeat`）；`src/core/types.ts:67-74`；默认关闭 `:189` |
| **关闭前归零且等待写入完成（5s 超时兜底）** | `src/main/index.ts:8-9`（注释："Shutdown order is the safety-critical part"）、`:104-127`（`manager.close()` 先发零帧并 await，再关 worker/server，带 `withShutdownTimeout`）、`:132-137`（`before-quit`） |
| **游戏联动 fourNights**（真实第三方对接案例） | `src/integrations/fourNights/`（12 个文件）：`args.ts`（CLI/参数）、`logTail.ts`（尾随 Unity `Player.log`）、`events.ts`（解析 `Left/Right <damage>`）、`mapping.ts`（伤害→百分比/频率、淡出）、`planner.ts`（节流/去重）、`hubClient.ts` + `bridge.ts:10,327`（只经 HTTP API 控制，不改游戏/hub 本体）、`pluginState.ts`（可选 BepInEx 状态插件）、`diagnostics.ts`（`--check` 自检 + 桥状态落盘 `:111`）；文档 `docs/INTEGRATION-four-nights.md`（308 行）；`integrations/fourNights-bepinex/`（C# 插件 + 预编译 dll + build.ps1） |
| **测试**：8 个 spec / **137** case + 11 项 UI 端到端 smoke | 见 4.5 |

### 4.3 它明显缺少的东西（逐条证据）

| 缺什么 | 证据（反证） |
|---|---|
| **谓词/策略引擎（policy）** | `grep -rn -i "policy" coyote-hub/src --include=*.ts` 只命中 CSP 常量与"local-only request policy"（`src/main/server.ts:105,112,149,539`），**没有任何输出策略模块**；`src/core/` 只有 `protocol/channel/device/manager/types/errors` 六个文件；保护手段只有数值 bounds（`src/core/types.ts:17-27`） |
| **审计日志** | `grep -rn -i "audit" coyote-hub/src` → **0 命中**；无 append-only store、无 actor 概念；`docs/API.md` 也没有审计接口 |
| **agent / LLM / 工具层** | `grep -rn -i "agent\|llm\|openai\|anthropic" coyote-hub/src` → 0 命中；`package.json:24-26` dependencies 只有 `ws`；没有任何模型调用代码 |
| **持久化（设备清单/名称/上下限/设置）** | `src/core/manager.ts:4`（"This app persists nothing by design"）、`src/core/types.ts:66`（"in-memory only"）；`grep -rn "localStorage\|writeFile" coyote-hub/src` 的 `writeFile` 只在 `src/integrations/fourNights/diagnostics.ts:111`（那是**联动桥**的状态文件，不是 hub 本体）；README:47,175 也自认 |
| **LOCKED / 急停 latch / 解锁** | `grep -rn "LOCKED\|emergency" coyote-hub/src` → 0 命中；只有 `stopAll`（`src/core/manager.ts:369-382`），停下后**模型/外部可直接再拉起来** |
| **`BF` 硬件软上限** | `grep -rn "encodeBF\|softCap" coyote-hub/src` → 0 命中；`src/core/protocol.ts:7-8` 注释明说"deliberately does not send BF"，README:11,174,179 承认会残留旧上限 |
| **波形库 / DSL / hex 导入** | `src/core/types.ts:193-194`（`FIXED_WAVEFORM_INTENSITY = 60` 固定波形强度）；`src/core/manager.ts:539`（每帧用固定值）；无 waveform 模块、无 library/session、无导入导出 |
| **多后端**（除郊狼 V3 以外） | `src/core/protocol.ts` 只实现 V3 B0/B1；无 xhtkj/monsterparty/buttplug/ankni/mock 后端（`src/main/mock-ble.ts` 只是**传输** mock，仍是郊狼协议） |
| **需求/设计文档**（我方那种 M0-M6 里程碑、policy 设计、风险表） | `coyote-hub/docs/` 只有 `API.md`、`INTEGRATION-four-nights.md`、`ui.png`；README 是使用手册 + 安全模型，没有立项/需求冻结/里程碑/验收标准 |
| **认证 / token / 多用户** | `grep -rn -i "token\|auth" coyote-hub/src` → token 只出现在注释"no token"；`src/main/server.ts:9`（"no auth"）、`:540`（"deliberately no token"）；README:175 自认 |
| **step 限制（单条命令强度跳变上限）** | 无 `maxStep`/`step` 概念；`src/core/channel.ts:61-64` 明确"there is deliberately no clamping"，percent 合法即透传 |
| **设备状态自报**（如 comfortLimit/overheat/电量） | `grep -rn "overheat\|comfort\|battery" coyote-hub/src` → 0 命中；只解析 B1 强度回执（`src/core/protocol.ts:decodeNotification`）与 PnP pid |
| **传感器/摄像头/麦克风/phone-web/Android/TCode/音频** | 全部 0：按关键词（sensor、camera、microphone、getUserMedia、android、tcode、stt、tts）grep `coyote-hub/src` 无命中；无 `apps/` 目录结构（只有 src/ui 静态页） |
| **无死代码/内部不一致（小）** | `src/core/types.ts:98-102` 定义了 `ClampFlags`（"Which fields were outside the channel's bounds and got clamped"）但全仓库无引用、`AppliedControl`（`:104-116`）也没有该字段——是"不夹紧"决策前的遗留类型 |

### 4.4 与主工程的关系：**同一协议的第二次实现 + 接口层互补**，不是简单重复

| 维度 | 主工程 Embodied Roleplay | coyote-hub | 关系 |
|---|---|---|---|
| V3 协议编解码 | `packages/core/src/backends/coyote/protocol.ts`（183 行） | `coyote-hub/src/core/protocol.ts`（212 行，多了 Hz↔字节换算） | **重复实现**；hub 版多一层人可读频率语义 |
| 单设备 100ms 流 | `coyote/backend.ts`（397 行，含波形流、BF、滚轮处理） | `src/core/device.ts`（309 行，固定波形强度 60、无 BF、不做滚轮采纳） | **分叉实现**：各取所需 |
| Web Bluetooth 桥 | `apps/desktop/src/main/ble/{bridge,electron-bridge}.ts` + `renderer/ble.js` | `src/main/{ble-bridge,electron-ble}.ts` + `src/renderer/ble.js` | **重复实现**；hub 版多了"已连接设备排除"（`electron-ble.ts:168-172`），主工程没有（依赖人工"一次只开一台"，README:132） |
| 设备模型 | 6 backend、多协议、per-device 队列、策略/审计/LOCKED | 单一 V3、`slots` Map、只有 bounds、无队列抽象（`manager.ts:502` 只有一个全局 `enqueue`） | **互补**（安全运行时 vs 互操作层） |
| 对外接口 | dashboard 私有 token+UI 驱动（`main/dashboard.ts`） | 稳定的 REST/WS 契约 + API.md + 客户端示例 | hub 版更适合做"被其他软件控制"的接口 |
| 持久化 | devices/waveforms/tokens + 审计 JSONL | 零持久化 | 主工程更完整 |
| 测试 | 263 + 84（vitest） | 137（vitest）+ 11 UI smoke | 都有测试，hub 的 UI 端到端是主工程没有的 |
| 代码关系 | — | 无 `@embodied/core` 依赖（README:223 自述，已核实） | 各自独立演化，**不存在构建耦合** |

结论：**短期不要合并**。coyote-hub 是一份"去掉安全层、换取互操作性"的产品化验证；它的价值在于告诉主工程"多设备管理/对外 API/频率语义/配对排除"这四块该长什么样。

### 4.5 coyote-hub 的测试口径

- `vitest.config.ts`：`pool: 'threads'`（注释说明沙箱下 fork 池不可用），`include: ['tests/**/*.spec.ts']`。
- 8 个 spec：`ble-bridge 25 / server 22 / four-nights 28 / manager 22 / channel 12 / protocol 11 / mock-ble 10 / device 7` = **137**，与 README:230 的"当前 137 个测试"一致。
- UI 端到端：`scripts/ui-smoke.ts` 里 11 个 `check(...)`（`:62,71,77,86,96,106,118,130,145,153` 等），与 README:232 的"11 项检查"一致；`npm run test:ui` 用离屏 Electron 跑（README:235）。
- 缺口：真实蓝牙路径（`select-bluetooth-device`、多台同名设备排除）只在有硬件时能验证，README:237 自认。

### 4.6 coyote-hub 风险点（供 Lead 判断能否作为我方组件复用的输入）

1. **没有 `BF`**：设备里可能残留旧软上限，百分比拉满但体感被压（README:179）；作为"我们缺 BF 时的对照"很有价值。
2. **物理滚轮写入会被 100ms 流拉回**（README:186；`src/core/device.ts` 每帧重发目标值）——与主工程文档的说法相反、与主工程代码一致（见附录 A8）。
3. **无持久化**：重启即丢设备列表/名称/上下限（README:47,175）。
4. **无 token 但只有回环策略**：本机任意进程可直接控制（README:182 承认），对"本机其他软件"是特性、对恶意本地进程是缺口。
5. **百分比是命令层保护**：外部程序绕过 hub 直连设备时不受约束（README:181）。

---

## 5. 吸收候选点：我们已有 vs 我们缺（每项标注落点模块）

说明：外部方案线索主要来自本工作区的 `项目分析-AI-for-Coyote.md`（对象 GPL-3.0，只吸收**思路与数值**，不搬代码）与 coyote-hub 的对照。以下"我们已有"均指主工程代码现状。

| # | 候选能力 | 我们已有 | 我们缺 | 建议落点（具体模块/文件） | 建议优先级 |
|---|---|---|---|---|---|
| C1 | **DG-LAB SocketAPI v4 中继后端**（手机 App 持 BLE，主机走 ws 中继；可拿 `comfortLimit` / `overheat` / `slots.patch` 状态） | 仅 BLE 直连 coyote（`backends/coyote/backend.ts`） | 无 relay backend（`packages/core/src/backends/` 下无 relay/socketapi 目录）；无状态自报通道 | 新建 `packages/core/src/backends/dglab-relay/{backend,protocol}.ts`，复用 `ports/websocket.ts`；`apps/desktop/src/main/bootstrap.ts:281-345` 注册进协议工厂；`apps/desktop/src/main/dashboard.ts` 增加配对二维码/连接方式；`devices/types.ts` 增 `onDeviceState?` | **高**（唯一能拿到硬件自报安全状态的路） |
| C2 | **设备状态自报 → 快照/审计/UI**（comfortLimit、overheat、当前 A/B 强度、slotState） | 只有 pid 猜测能力（`backends/xhtkj/protocol.ts:144`、`capabilityOf`）与 B1 强度回执（`coyote/backend.ts:338-350`） | `DeviceBackend` 没有状态事件（`devices/types.ts:97-106` 只有 `onLinkLost/onChannelsChanged`）；快照无硬件状态字段（`registry.ts:74-87`） | `devices/types.ts` 增 `onDeviceState` + `DeviceSnapshot` 扩展；`registry.ts:575-604` 快照聚合；`dashboard.ts:283-287` `/api/snapshot` 透出；`ui/app.js` 卡片展示；`audit.ts` 新增 action `device_state` | **高**（C1 的下游；也是 overheat 降额的前提） |
| C3 | **每通道 step 限制**（单条命令强度变化 ≤ 40/200，防跳变） | 有 cap 夹紧（`policy.ts:117`）与包络（`effect.ts`），但**没有跨命令变化速率限制**（`grep -rn "maxStep\|stepLimit" packages/core/src` 无命中） | 无 step 字段、无斜坡/拒绝逻辑 | `devices/policy.ts` 增 `maxStepPerCommand` 与 `ABSOLUTE_MAX_STEP`；`registry.ts:663-673` 写路径做"斜坡或拒绝"；`registry.ts:527-542` 随 policy 生效；测试 `packages/core/tests/policy.spec.ts`、`registry.spec.ts` | **高**（成本低、对模型最有效） |
| C4 | **过热降额**（overheat → 该通道 cap 临时降到 20） | 无温度/过热概念（`grep -rni "overheat" packages apps` 无命中） | 无临时降额机制（policy 只有人类持久 cap） | `devices/policy.ts` 增"临时 override/降额"或 `registry.ts` 计算 `effectiveCap`；依赖 C2 的状态源；`ui/app.js` 显示降额原因；`audit.ts` 记录 `derate` | 中（依赖 C1/C2） |
| C5 | **传感器反馈闭环**（摄像头周期检测黑屏/无人 → 怒气；麦克风声音分级 → 提示注入） | 无（`packages/core/src/sensors/`、`apps/phone-web/` 均不存在；dashboard 无 `/api/frame`） | 感知源、帧快照、token 化帧端点、新鲜度 | 新建 `packages/core/src/sensors/{registry,frame-store}.ts`（原子写复用 `node-storage.ts:73` 的 temp+rename 思路）；`apps/desktop/src/main/bootstrap.ts` 接线；`dashboard.ts` 增 `POST /frame`（独立 token，绑回环）；后续 `apps/phone-web/` 复用 4.x 静态 UI 模式 | 中（M2 核心体验；若 Lead 判断先做 agent 则排后） |
| C6 | **agent 循环 + providers + 工具层**（单次回复 `{line, actions[]}` 或 tool loop；重试注入治 JSON 思维链泄漏） | 无（`packages/core/src/agent/` ABSENT；三个 package.json 无 AI SDK） | 循环、provider 抽象、工具 schema、提示词组装、重试 | 新建 `packages/core/src/agent/{loop,providers,tools,prompt}.ts`（命名沿用 `设计文档.md:53-57`）；`apps/desktop/src/main/bootstrap.ts` 接 provider key（env）；`dashboard.ts` 增会话事件流；工具描述按 dsh-toy 的"description 即策略"写法 | **高**（M2 的主体；可与 C7/C8 并行） |
| C7 | **三层剧本 + `feedbackIntents` 映射**（我们自己的差异化设计，外部方案没有） | 只有设计（`剧本系统设计.md` 全文）与空目录 | loader/validate/phases/intents、`host/`、`scenarios/`、`state/` | 新建 `packages/core/src/scenario/{loader,validate,phases,intents}.ts`、`packages/core/src/state/store.ts`（用 `ports/storage.ts`）；内容目录 `host/`、`scenarios/<id>/`；`apps/desktop/src/main/dashboard.ts` 增剧本选择/阶段显示；`bootstrap.ts` 加载 | **高**（与 C6 同批；不要用外部的 `{line, actions[]}` 覆盖我们的意图抽象） |
| C8 | **内容包/DLC 分发**（设置+提示词+语料+设定 的 zip 机制） | 无内容分发概念 | 无打包/安装/校验/版本 | `packages/core/src/scenario/loader.ts` 增加"内容包"目录约定；`apps/desktop/src/main/node-storage.ts` 增加内容包安装与校验（版本/清单/白名单）；`dashboard.ts` 增导入接口 | 中（有 C7 之后才需要） |
| C9 | **空依赖降级**（摄像头/麦克风缺席 → 显式禁用而非崩） | 已有同类型模式：dev-server 无 BLE、Intiface `unavailable` 不阻塞启动（`main/intiface.ts:20-22,121`） | sensors/agent 还没有，自然没有降级 | 新建 `sensors/registry.ts` 时把 `unavailable` 做成一等状态；`bootstrap.ts` 用 feature flag；`dashboard.ts` 快照里显式列出不可用源 | 中（随 C5 一起做） |
| C10 | **长按空格/UI 内急停**（前台焦点在游戏窗口时的带外急停） | 有 Electron 全局热键（`main/index.ts:19,234`）+ panic server；**浏览器/WebView 模式没有** | UI 内长按/键盘急停；`apps/phone-web` 未建 | `apps/desktop/src/ui/app.js` 增加长按/组合键 → `POST /api/panic`；未来 phone-web 页的大按钮；`server.ts` 侧已有独立 panic 端点可复用 | 低-中（桌面已被热键覆盖，但 dev-server/手机场景需要） |
| C11 | **对外 API 契约化（coyote-hub 反哺）** | dashboard API 是私有 token+UI 驱动，不是稳定对外契约 | 无版本化 REST/WS 契约、无外部客户端示例/文档 | `apps/desktop/src/main/dashboard.ts` 抽出对外 API 契约（独立 token 或受限 scope）+ 新增 `docs/API.md`；可参照 `coyote-hub/src/main/server.ts:9-30` 与 `coyote-hub/docs/API.md` 的结构；WS 事件馈送可借 `coyote-hub/src/core/types.ts:137-142` 的事件模型 | 中（决定"能否被外部软件/游戏联动"） |
| C12 | **Hz 语义层（coyote-hub 反哺）** | `Waveform.freq` 是协议字节 10–240（`waveform/types.ts:21-23`），对人/对模型不可读 | 无 Hz↔字节换算、UI 只能显示原始字节 | `packages/core/src/waveform/types.ts` 或新 `waveform/frequency.ts` 增 `hzToProtocolByte/protocolByteToHz`（借用 `coyote-hub/src/core/protocol.ts:54-72` 的分段公式与注释）；`ui/app.js` 波形编辑器显示 Hz；`waveform/dsl.ts` 可选接受 Hz | 低-中（创作体验；不影响安全） |
| C13 | **同名 BLE 设备配对排除（coyote-hub 反哺）** | 主工程靠人工"添加时只打开一台"（README:132） | bridge 层无 `excludeDeviceIds`（`apps/desktop/src/renderer/ble.js` 的 `links` 里其实有已连接 device.id，但没有回传给 `requestDevice` filter） | `apps/desktop/src/main/ble/bridge.ts` 的 `BleBridge.request` 增加 `excludeDeviceIds`；`apps/desktop/src/renderer/ble.js` 的 `navigator.bluetooth.requestDevice({filters, optionalServices})` 增 `exclusionFilters`；`apps/desktop/src/main/ble/electron-bridge.ts` 传参。参照 `coyote-hub/src/main/electron-ble.ts:168-172` | 中（有多台同款设备时是硬需求） |
| C14 | **每通道独立频率窗口（coyote-hub 反哺）** | 主工程每通道只有 `maxPercent/maxWaveIntensity/maxDurationSec`（`policy.ts:25-37`），频率由波形数据决定 | 无"频率上下限"作为 operator 配置 | `packages/core/src/devices/policy.ts` 增 `minFreqHz/maxFreqHz`（可选）；`backends/coyote/backend.ts` 在每帧 `clampFrameIntensity` 旁对 freq 做窗口缩放；`ui/app.js` 增加频率上下限控件 | 低（与我们的"波形=质感"设计有张力，需 Lead 判断是否值得） |
| C15 | **多设备 UI/清单模型（coyote-hub 反哺）** | 已有 manifest + 添加/移除（`bootstrap.ts:416-438`、`ui/app.js`） | 无"逐台命名 + 物理标识展示 + 独立重连"的卡片范式 | 参考 `coyote-hub/src/ui/app.js`（1020 行）与 `docs/API.md` 的 `DeviceView`（`coyote-hub/src/core/types.ts:50-64`）；落点 `apps/desktop/src/ui/app.js` + `dashboard.ts` `/api/devices` 返回 `deviceId`（Web Bluetooth 物理标识） | 低-中（体验向） |
| C16 | **UI 端到端 smoke（coyote-hub 反查缺口）** | 主工程测试全是 vitest 单测（core 263 + desktop 84），UI 静态页无 E2E | 无离屏 Electron UI smoke | 新增 `apps/desktop/scripts/ui-smoke.ts`（参照 `coyote-hub/scripts/ui-smoke.ts` 的 11 项检查） + `scripts/run-electron.mjs`；纳入 `package.json` `test:ui` | 低（但能防 UI 回归） |

**明确不吸收**（避免被外部方案带偏，均有我方设计依据）：

- 外部的"输出格式 = `{line, actions[]}` 单角色单体"（`项目分析-AI-for-Coyote.md:130`）：我们的 `feedbackIntents` 是更通用的意图层，不换。
- 外部的"DLC 角色 = 提示词+语料"直接替换三层剧本：只借"内容包分发"机制，不借其内容结构。
- `coyote-hub` 的"去掉 BF/审计/LOCKED"：这是我们明确要保留的安全底座，绝不吸收。
- GPL-3.0 代码/数据（dglab-kit 预设、AI-for-Coyote 的 `device_ops.py`/`relay/v4-server.ts`）：只取事实与数值，不复制代码（`波形系统设计.md:65-80`、`项目分析-AI-for-Coyote.md:137`）。

---

## 6. 证据表（52 条，`文件:行号`，可逐条抽查）

| # | 文件:行号 | 证据内容 | 支撑结论 |
|---|---|---|---|
| E1 | `packages/core/src/devices/registry.ts:127` | `export class DeviceRegistry` | 安全运行时存在 |
| E2 | `packages/core/src/devices/registry.ts:153-160` | `DeviceState` 带 `queue: SerialQueue`，register 时为每设备 new 一个 | per-device 串行队列 |
| E3 | `packages/core/src/devices/registry.ts:663-673` | `write()` 内 `if (this.locked && percent > 0) return` + `clampPercentToPolicy` 后 `applyLevel` | latch 后不复活 + 发射端最终夹紧 |
| E4 | `packages/core/src/devices/registry.ts:495-501` | 急停先 `locked=true`，再取消 runner，**再写审计**，最后 `stopAll()` | LOCKED + 审计先于传输 |
| E5 | `packages/core/src/devices/registry.ts:515` | `async unlock(_actor: 'human', note?: string)` | 只有人类能解锁（类型强制） |
| E6 | `packages/core/src/devices/registry.ts:527-542` | `setPolicyByHuman` 调 `policy.setByHuman` 并审计 before/after | cap 只能人类改且留痕 |
| E7 | `packages/core/src/devices/registry.ts:677-694` | `prepare()`：LOCKED / 未知通道 / 非 level / 未 ready 四道门 | 模型写入统一前置校验 |
| E8 | `packages/core/src/devices/effect.ts:165,196-208` | `generation = 0`；`start()` 先 `++generation` 再起 ticker | generation token |
| E9 | `packages/core/src/devices/effect.ts:258-273` | `tick(generation)` 不匹配即 return；到点写零后再次比对 generation 才 `onFinished` | 旧效果终止零不穿透新效果 |
| E10 | `packages/core/src/devices/queue.ts:1-11` | 注释：BLE 一次一个写、不同设备并行、stop 可 priority 插队 | 并发模型的设计依据 |
| E11 | `packages/core/src/devices/policy.ts:50-54` | `DEFAULT_CHANNEL_POLICY = { maxPercent: 20, maxWaveIntensity: 80, maxDurationSec: 60 }` | limits 默认值 |
| E12 | `packages/core/src/devices/policy.ts:117-120` | `clampPercentToPolicy` 对非有限值返回 0 | 发射端 fail-closed |
| E13 | `packages/core/src/devices/policy.ts:145-155` | `setByHuman(...)` 是唯一变更入口，返回 before/after | policy 人类专属 |
| E14 | `packages/core/src/devices/audit.ts:48-69` | `record()` 序列化失败降级、append 失败不抛 | 审计 append-only 且不阻塞急停 |
| E15 | `packages/core/src/devices/types.ts:54-128` | `DeviceBackend` 契约：`applyBounds/onLinkLost/onChannelsChanged/scan/writeRaw` | 后端能力面（含集线器与协议调试） |
| E16 | `packages/core/src/waveform/types.ts:16-36` | `FRAME_MS=100`、`MIN_FREQ=10/MAX_FREQ=240`、`MAX_FRAMES=600` | 波形帧模型 |
| E17 | `packages/core/src/waveform/dsl.ts:178` | `compileWaveformScript(script)` | 段落 DSL 编译存在 |
| E18 | `packages/core/src/waveform/clamp.ts:51` | `clampWaveformIntensity(waveform, maxIntensity)` | 只在发射端夹紧（创作期不按通道拒） |
| E19 | `packages/core/src/waveform/library.ts:145` | `promoteByHuman(id)`，注释"Human action only" | 入库唯一路径 |
| E20 | `packages/core/src/waveform/builtin.ts:66,139` | 5 个 DSL 自创 + `createBuiltinWaveforms()` 返回 2 厂商 + 5 自创 = 7 | 内置波形实际 7 个 |
| E21 | `packages/core/src/backends/coyote/backend.ts:76-79` | `COYOTE_PLAIN_FRAME`（无波形时的默认质感） | "强度必须有波形"已解决 |
| E22 | `packages/core/src/backends/coyote/backend.ts:171-184` | connect 中 `await this.writeBoundsNow()`（`:174`）失败则 teardown 并抛 `NOT_CONNECTED`；之后才起 100ms ticker | BF 失败即拒控 |
| E23 | `packages/core/src/backends/coyote/backend.ts:291-319` | `composeFrame`：mode 仅在 target≠known 时 absolute，seq 递增 | 只在变化时下发强度 + 绝对模式 |
| E24 | `packages/core/src/backends/coyote/backend.ts:344-350` | `state.known = strength` + 注释"next frame re-asserts the commanded strength rather than following the hand" | **滚轮不采纳**（与文档矛盾） |
| E25 | `packages/core/tests/coyote-backend.spec.ts:302` | `it('ignores an uncommanded strength change and re-asserts the commanded target')`，`:320` 注释"The wheel is no longer adopted" | 代码与测试一致、与 README 相反 |
| E26 | `packages/core/src/backends/xhtkj/backend.ts:11` | "**No hardware dead-man switch.** One strength packet sets a level and the toy holds it" | 失效语义表 |
| E27 | `packages/core/src/backends/xhtkj/protocol.ts:144-146` | `outputFloorPercent(productId) = round(strengthBase * 100)` | 百分比不可比的可视化 |
| E28 | `packages/core/src/backends/monsterparty/backend.ts:8-20` | 无 dead-man、单次 token、禁用协议层 ping | 失效语义 + 运维约束 |
| E29 | `packages/core/src/backends/buttplug/backend.ts:159,197,328` | `scan()`、`onChannelsChanged()`、`maxPingTime/2` 保活 | 集线器后端与动态通道 |
| E30 | `packages/core/src/backends/ankni/backend.ts:1-14,115,160` | 流式 dead-man、默认 200ms ticker、所有写进 writeChain | 第 5 个真实后端 |
| E31 | `packages/core/src/backends/mock/index.ts:1-14,168-171` | 双语义 + `simulateHostDeath()`（不写零只停刷新） | M0 两种失效语义的对照 |
| E32 | `apps/desktop/src/main/bootstrap.ts:145-149` | `WELL_KNOWN_DEVICES` 含 coyote/xhtkj/ankni（ZKRXB）3 项 | 清单实际 3 项（README 说 2 项） |
| E33 | `apps/desktop/src/main/bootstrap.ts:198-204,225` | `FileAppendOnlyStore(audit/device.jsonl)`、`PolicyStore()`、`WaveformLibrary()`、`DeviceRegistry` | 宿主接线（policy 未加持久化） |
| E34 | `apps/desktop/src/main/bootstrap.ts:441,462,520,558` | panicToken/dashboardToken 随机生成并落盘；DashboardServer；shutdown | 两个独立 token + 关闭路径 |
| E35 | `apps/desktop/src/main/dashboard.ts:75-89,178,182,250` | token 头/query、长度下限 16、默认 `127.0.0.1`、API 才校验 token | 控制台鉴权与绑定 |
| E36 | `apps/desktop/src/main/panic-server.ts:96,103,139,144` | token≥16、默认回环、常量时间比较、`POST /panic` | 带外急停独立服务器 |
| E37 | `apps/desktop/src/main/node-storage.ts:19,73,93-96` | 串行追加 store、文档 store temp+rename 原子写 | 持久化正确性 |
| E38 | `apps/desktop/src/main/ble/electron-bridge.ts:125,282,300` | `executeJavaScript(code, true)`、隐藏 worker 窗口、`select-bluetooth-device` 处理 | Web Bluetooth 桥 |
| E39 | `apps/desktop/src/main/index.ts:19,234` | `PANIC_ACCELERATOR='Control+Alt+X'`、`globalShortcut.register` 直达 panic | 桌面急停不经过 agent |
| E40 | `packages/core/src/index.ts:4-5` | "M0 scope: the safety runtime only. Waveforms, real backends, sensors, the agent loop, and the scenario system arrive in later milestones." | 模块注释已过期（sensors/agent/scenario 缺失为真，waveforms/backends 已实现） |
| E41 | `coyote-hub/src/core/manager.ts:102,107,111` | `CoyoteManager implements Hub`、`slots: Map`、`pairing` 串行化 | hub 多设备核心 |
| E42 | `coyote-hub/src/core/types.ts:17-27,166-172,179-184` | 上下限结构、协议硬限（强度 200/频率 100Hz）、默认 0–100 | hub 的"唯一一层保护" |
| E43 | `coyote-hub/src/core/channel.ts:61-63,77-88` | percent 只校验不夹紧；0% 绕过下限；非零至少 1 | 百分比窗口语义 |
| E44 | `coyote-hub/src/core/protocol.ts:54-72` | V3 频率字段是周期：1–100 Hz ↔ 字节 240–10 分段换算 | hub 新增的 Hz 语义 |
| E45 | `coyote-hub/src/main/server.ts:9,91,348-466,539-587` | 无 auth、绑 127.0.0.1、REST 路由、本地请求策略 | 对外 API 与安全边界 |
| E46 | `coyote-hub/src/main/electron-ble.ts:168-172,229-233` | `excludeDeviceIds` 排除已连接设备；3s 宽限窗收候选 | hub 的配对排除（主工程没有） |
| E47 | `coyote-hub/src/main/mock-ble.ts:162-171` | mock 解析 B0 并在 `seq>0` 回 B1 | mock 是真协议级 mock |
| E48 | `coyote-hub/src/core/manager.ts:4` + `types.ts:66` | "This app persists nothing by design" / "in-memory only" | hub 无持久化 |
| E49 | `coyote-hub/package.json:24-26` | dependencies 只有 `ws` | hub 无 agent/SDK 依赖 |
| E50 | `coyote-hub/src/integrations/fourNights/bridge.ts:10,327` | 只经 hub HTTP API 控制；`hub.control(...)` | 游戏联动是外部控制器范例 |
| E51 | `coyote-hub/src/main/index.ts:8-9,104-127` | 关闭顺序：先归零并 await，再关 worker/server，5s 超时 | hub 的急停/关闭纪律 |
| E52 | `coyote-hub/tests/*.spec.ts`（8 文件） | `it(` 出现次数 grep 统计 = 137；`scripts/ui-smoke.ts` 11 个 check | hub 测试口径 |

> 说明：上表 52 条，超出任务要求的 ≥20 条；所有行号均为本次读取时的实际行号。

---

## 附录 A：文档与代码矛盾清单（14 条）

> 判定规则：以 `HEAD fea2776` 的代码事实为准。按编号列出；其中 **A8（滚轮采纳）、A9（policy 落盘）是两项实质性矛盾，优先级最高**；A6/A14 是项目内部自相矛盾；其余为数字/目录/命名/注释滞后。

| # | 文档位置 | 文档说法 | 代码事实 | 影响/建议 |
|---|---|---|---|---|
| **A1** | `README.md:5`；`README.md:16-25` | "M0、M1 完成 —— 安全底座、波形子系统，以及**四个真实后端**：郊狼 V3、谜姬 XHTKJ、MonsterParty、Buttplug/Intiface"；表格只有 4 行 | 实际 **5** 个真实后端：`backends/ankni/backend.ts:58`（ANKNI stream，`6747c03` 加入）、`bootstrap.ts:145-149,312-313` 注册；README 表格缺 ANKNI | 文档滞后；"四个真实后端"已是旧口径，失效语义表少了"ANKNI 流式=dead-man"这一行（这对安全决策很重要） |
| **A2** | `README.md:20-25`（三失效语义表） | 只列郊狼（自动归零）/ XHTKJ / MonsterParty / Buttplug | ANKNI 属"流式 dead-man"（`ankni/backend.ts:10-12`），应归入"自动归零"类；缺行会让人误以为只有郊狼一例 | 安全语义表不完整（不危险，但会误导多设备部署） |
| **A3** | `README.md:82` | "6 个起始波形：呼吸/潮汐 取自协议文档公开数据表，另 4 个用 DSL 写在本仓库" | `waveform/builtin.ts:66-131` 是 5 个 DSL 波形，`:139-169` 组装 2+5=**7** 个 | 文档滞后（新增了波形）。数字错误会让人低估创作工作量 |
| **A4** | `README.md:100` | "`bridge.ts` 里用假桥接做了 **19** 条单测" | `apps/desktop/tests/ble-bridge.spec.ts` 实际 **21** 条 | 文档滞后；测试数应以 grep 为准 |
| **A5** | `README.md:157-160` | "packages/core 249 passed / apps/desktop 68 passed" | 实际 **263 / 84**（grep 统计；与 commit `6747c03` 的 "core 263 / desktop 84 green" 一致） | 文档滞后；最近提交已刷新数字但 README 没同步 |
| **A6** | `README.md:191-193` | 章节标题"## M1 剩余"，正文"Buttplug 后端（移植 dsh-toy 的 v3/v4 协议与 Intiface 校验下载）" | Buttplug 已实现（`backends/buttplug/backend.ts:64`，26+19 条测试）；README:5,31 自己说 Buttplug 后端已完成 | **README 内部自相矛盾**：M1 清单与正文/测试数量冲突。应删掉或改成"Intiface 自动下载不做" |
| **A7** | `README.md:132` | "首次 BLE 运行自动写入一台郊狼 + 一台谜姬" | `bootstrap.ts:145-149` 内置 **3** 台 well-known（coyote/xhtkj/ankni ZKRXB），`bootstrap.ts:237-271` 的迁移逻辑会注入一次 | 文档滞后（ANKNI 加入后没更新）；影响操作者对新设备卡片的预期 |
| **A8** | `README.md:90`；`设计文档.md:247` | "滚轮/App 的外部改动会被**采纳**为新目标并上报，而不是被 100ms 后覆盖回去"；"后端会采纳滚轮的改动并上报（所以恒定电平不会被覆盖回去）" | `backends/coyote/backend.ts:344-350` 只更新 `known`，注释明确"next frame re-asserts the commanded strength rather than following the hand"；测试 `coyote-backend.spec.ts:302,320` 断言"ignores an uncommanded strength change" | **实质矛盾**：实际操作者拧滚轮不会生效（会被拉回）。这也解释了为什么 `coyote-hub` README:186 写的是相反行为。需要 Lead 决策：改代码（采纳）还是改文档（承认不采纳） |
| **A9** | `设计文档.md:234`（安全分层表） | 配置层写的是 `ChannelPolicy`，UI 可改、**落盘** | `PolicyStore` 只在内存构造（`bootstrap.ts:203`），宿主落盘的 4 类文件里没有 policy（`bootstrap.ts:236,458,530,535`）；重启后 cap 回默认 20/80/60（`policy.ts:50-54`） | **承诺未兑现**：长会话重启后人类设置的上限丢失，且郊狼 `BF` 会按新默认重写，可能把会话中放宽的上限收紧。建议在 `bootstrap.ts` 增加 `state/policy.json` 读写（复用 `FileDocumentStore` + `PolicyStore` 序列化） |
| **A10** | `设计文档.md:26` | "M1 设备：**Buttplug + 郊狼**；GALAKU 砍掉；音频延后" | 实际 5 个后端（含 XHTKJ/MonsterParty/ANKNI）；`设计文档.md:347-348` 把 MonsterParty/ankni-ble 排在 **M3** | **代码领先里程碑表**：M3 部分内容已提前完成。里程碑表应重排（M3 剩三项压测/导出码/多设备） |
| **A11** | `设计文档.md:53-95,342-360` | 目录树含 `agent/`、`scenario/`、`sensors/`、`state/store.ts`、`apps/phone-web/`、`apps/android/`、`host/`、`scenarios/`、`packages/core/src/backends/{ankni-ble,tcode}/` | 上述路径**全部 ABSENT**（逐个 `[ -e ]` 检验）；实际是 `backends/ankni/`（无 `-ble`）；`devices/backend.ts` 实际为 `devices/types.ts`；`waveform/{compile,parse,validate}.ts` 实际为 `{dsl,hex,clamp}.ts` | 目录树是"计划"不是"现状"；新人按图索骥会找不到文件。建议把设计文档 §2 标注为"M2+ 目标结构" |
| **A12** | `设计文档.md:109-114` | `Channel` 接口有 `hardCapPercent: number // 人类配置` | `devices/types.ts:23-49` 的 `Channel` 无 `hardCapPercent`；cap 在 `PolicyStore`（`policy.ts:25-37` 的 `ChannelPolicy`） | 字段命名漂移（同一概念的两种归属）。若将来暴露 `devices_list` 工具需注意以哪个为准 |
| **A13** | `packages/core/src/index.ts:4-5` | 模块注释："M0 scope: the safety runtime only. **Waveforms, real backends**, sensors, the agent loop, and the scenario system **arrive in later milestones**" | 波形与 6 个 backend 早已实现（本文件第 1.3/1.4 节） | 代码注释过期（不影响运行，但会误导阅读者；建议拆成"M0 范围 + 已实现"两段） |
| **A14** | `coyote-hub/README.md:6` | "每台设备、每个通道独立限制……命令不会越界，也不需要夹紧" | `coyote-hub/src/core/types.ts:98-102` 仍定义 `ClampFlags`（注释"Which fields were outside the channel's bounds and got clamped"），但 `AppliedControl`（`:104-116`）无该字段、全仓库零引用；映射函数里仍有 `Math.min/max`（`channel.ts:78-87`） | hub 内部文档/类型契约与实现不一致（死类型）。若以 hub 作为对外 API 蓝本，需先清理"夹紧"语义以免误读 |

**另外两条"非矛盾但需 Lead 知道"的文档事实**：

- `剧本系统设计.md` 全文是设计而非实现（0 行代码）——它没有声称"已完成"，所以不算矛盾，但**不能作为 M2 已做的证据**；第 2 节已按"未实现"处理。
- `项目分析报告.md` 的"dsh-toy 5 个 spec / 19 个用例"是外部项目数字（`:194`），不是我们的；不要与本报告第 1.6 节的 263/84 混淆。

---

## 附录 B：本次盘点的局限（供 Lead 评估结论强度）

1. **未跑测试**：全部测试数字来自静态 grep + 文件内容，未验证能否在无沙箱限制下运行通过。与 commit message `6747c03` 的"core 263 / desktop 84 green"互为佐证，可信度较高。
2. **未接真机**：BLE 相关结论全部来自代码/测试替身，`README.md:100` 也承认 Electron 胶水无法在无硬件环境执行。
3. **coyote-hub 无 git**：无法判断其演进历史（只有当前快照）；其 README 的"137 测试""11 项 UI 检查"与代码一致，可信。
4. **`ai-for-coyote/` 未在本次范围内**：第 5 节的外部件线索来自本工作区已有的 `项目分析-AI-for-Coyote.md`，该报告的对象版本为 `9cce657`，本报告未复核其代码（属于另一盘点口径）。
5. **工作区有未提交改动**：`start-dev.bat` 被修改，`coyote-hub/`、`ai-for-coyote/`、若干日志为未跟踪文件；本报告基于工作区当前状态而非干净 HEAD。
