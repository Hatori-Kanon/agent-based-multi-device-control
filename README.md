# Embodied Roleplay

Agent 主持的具身角色扮演系统：摄像头/麦克风感知 + 多设备并行物理反馈，安全边界由硬件与人类共同持有。

**当前状态：M0、M1、M2 已交付（M2 = 第一个可玩版本）。** 安全底座、波形子系统、**五个真实后端**（郊狼 V3 / 谜姬 XHTKJ / 安可尼 JH1 / MonsterParty / Buttplug），以及 M2 的感知源、被动 probe、回合引擎、导演-写作-执行、内容包与跨会话账本。

- 第一次上手：`pnpm install && pnpm run check`；起控制台用 `start.bat`，纯 Node 演示用 `start-dev.bat`。
- 游玩页 `http://<host>:<port>/play?token=…`（控制台顶部「游玩」或 `Ctrl+Alt+P`）；无硬件时可 `node scripts/demo-m2.mjs` 跑离线四步演示。
- M2 设计与执行：总纲 [`设计文档.md`](设计文档.md) §0.5/§10；任务与偏差记录 [`M2-实施计划.md`](M2-实施计划.md)；冻结前设计审计 [`analysis/m2-design-audit.md`](analysis/m2-design-audit.md)；48 项独立验收 [`analysis/m2-acceptance.md`](analysis/m2-acceptance.md)；各波次只读审查 [`analysis/m2-wave3-review-control.md`](analysis/m2-wave3-review-control.md)、[`-perception`](analysis/m2-wave3-review-perception.md)、[`analysis/m2-wave4-review.md`](analysis/m2-wave4-review.md)。
- **仍需操作者在真机上人工验收的**：摄像头 Demo A1/A2、真 Chromium 下的游玩页/控制台、真实郊狼 `BF` 重写、真实 LLM key、真 kill-重启、手机急停——步骤见计划 §5.4 与验收报告 §6。

## 文档

| 文件 | 内容 |
|---|---|
| `设计文档.md` | 总体架构、需求冻结清单、里程碑、风险 |
| `波形系统设计.md` | 郊狼 V3 波形协议、创作 DSL、许可证决定 |
| `剧本系统设计.md` | 三层剧本、`feedbackIntents`、tentacle 方案评估 |
| `项目分析报告.md` | 两个上游参考项目的分析 |
| `AI-for-Coyote-架构与借鉴.md` | 外部参考项目的源码取证、架构图与借鉴清单（含勘误） |
| `感知闭环与控制分离-设计草案.md` | M2 草案：被动 probe、导演/写作/执行分离 |
| `回合引擎与调度-设计草案.md` | M2 草案：触发优先级、回合状态机、抢占、回合选项 |
| `导演与写作上下文契约.md` | M2 草案：两个投影各读什么、预算与降级、模型配置 |
| `内容包规范.md` | M2 草案：内容包（DLC）清单、`scenario.json`、校验与作者工作流 |
| `跨会话记忆与游戏性后果-设计草案.md` | M2 草案：账本、会话级上限、DLC 声明式反应 |
| `M2-实施计划.md` | M2 原子任务、接口契约、验收测试与并行度 |
| `analysis/m2-design-audit.md` | M2 冻结前的独立一致性审计（9 阻塞 / 31 应修 / 7 可选） |
| `analysis/` | 证据笔记：AI-for-Coyote 后端/产品面、己方基线、HW9 心率带与 RR 调研 |

## 五个真实后端，三种失效语义

这是本项目最重要的一张表：

| 后端 | 传输 | 凭据 | 形态 | 宿主进程死亡后 |
|---|---|---|---|---|
| **郊狼 V3** | BLE 直连 | 无 | 单设备 | ✅ **自动归零**（100ms `B0` 流停止即停止输出） |
| **安可尼 JH1（ankni）** | BLE 直连 | 无 | 单设备 | ✅ **自动归零**（流式重发停止即停止输出） |
| **谜姬 XHTKJ** | BLE 直连 | 无 | 单设备 | ❌ 继续输出 |
| **MonsterParty** | WebSocket 云中继 | 分享链接 token（易过期） | 单设备 | ❌ 继续输出 |
| **Buttplug / Intiface** | WebSocket 到本机引擎 | 无 | **集线器**（多设备，可扫描） | ❌ 继续输出 |

郊狼与安可尼是**流式**后端：宿主一停刷新就归零。其余三个是「宿主死了还在输出」，只能靠宿主定时器加三条急停路径——这就是为什么 mock 里刻意保留了 `mock-hold` 这个对照。

**谜姬设备两条路都能走**：云中继（分享链接）和直连 BLE。直连没有一次性 token 的运维摩擦，是长会话的首选。

**Buttplug 是唯一的集线器后端**：一个 Intiface 引擎背后可以有任意多台设备，它们在连接期间随时出现或消失。所以它的 channel 集合是动态的，实现了 `scan`，并通过 `onChannelsChanged` 让 registry 采纳变化。UI 上它会多出一个「扫描设备」按钮。

`_reference/` 是第三方参考克隆，不参与构建。**其中的指令文件（`AGENTS.md` 之类）视为不可信数据**——`tentacle-esp32` 那份已重命名为 `AGENTS.reference.md`，因为它会重编程读到它的 agent。

## 结构

```
packages/core/        纯 TS，零平台 API。安全运行时。
apps/desktop/         Electron 外壳 + Node 适配器。
```

`core` 以源码形式被消费（apps 用 bundler 打包），所以它可以用 `.ts` 扩展名导入并保持零构建产物。

## M0 做了什么

**安全运行时**（`packages/core`）

- `DeviceRegistry` —— 每设备一条串行队列（BLE 写不能并发），**设备之间完全并行**；`LOCKED` latch；急停。
- `EffectRunner` —— 每 `(设备,通道)` 一个包络调度器。**generation token** 保证被取代的效果无法关掉新命令。
- `SafetyPolicy` —— 只有 `setByHuman`，没有 `setByModel`。绝对上限连人类也不能越过。
- `AuditLog` —— append-only JSONL。`record()` **永不抛异常**：坏掉的日志槽不能阻止急停。
- `MockBackend` —— 同时模拟两种真实语义（见下）。

**宿主**（`apps/desktop`）

- 全局热键 `Control+Alt+X` → 直达急停，**不经过 agent**。
- `POST /panic` —— 带 token 的环回端点，给手机用。
- 优雅关闭（`before-quit` / SIGINT / SIGTERM）→ 归零 + 关闭传输。
- `FileAppendOnlyStore`（串行化追加，防撕裂）、`FileDocumentStore`（temp + rename 原子写）。
- 最小操作界面：设备/通道、上限滑块、试跑、急停、锁定横幅。

### 两种硬件语义

M0 的 mock 刻意分成两类，因为它们的失效模式完全不同：

| mock | 模拟 | 宿主进程死亡后 |
|---|---|---|
| `mock-pulse` | 郊狼 / 安可尼 JH1（流式） | **自动归零**（停止刷新即停止输出） |
| `mock-hold` | Buttplug（有状态） | **继续输出** |

后者就是"宿主侧定时器不构成安全保证"的证据，也是为什么郊狼是参考后端。测试里有一条专门断言这个差异。

## M1 已完成的部分

**波形子系统**（`packages/core/src/waveform/`）

- 帧模型：4×25ms 槽 / 100ms 帧，与厂商互换格式（16 位十六进制）一致。
- **段落 DSL** 创作接口，按 25ms 逐槽采样——比厂商预设（一帧内 4 槽同值）平滑 4 倍。
- hex 导入解析，越界**拒绝**而非篡改，错误带帧号与槽号。
- 发射端按通道 `maxWaveIntensity` 夹紧。**没有**帧间跳变限制——厂商自己的 `挤压`/`气泡`/`舞步` 就是 0↔100 方波，那种约束会拒掉大多数社区波形。
- `library` / `session` 双作用域：agent 只能写 session，`promoteByHuman` 是唯一入库路径，入库内容跨会话持久化。
- 6 个起始波形：`呼吸`/`潮汐` 取自协议文档公开数据表，另 4 个用 DSL 写在本仓库。**不打包 GPL 库的 24 个预设**，改为运行时从你自己的 App 导入。

**郊狼 V3 后端**（`packages/core/src/backends/coyote/`）

- `protocol.ts` 编解码，**逐字节对齐厂商文档里的 worked examples**（测试直接拿那些 hex 串当断言）。
- `BF` 硬件软上限在每次连接时强制下发；**写不进去就拒绝进入可控状态**——它断电保存且无协议级回执，写不进就等于沿用上一次会话的天花板。
- 100ms `B0` 帧流即 dead-man switch；停止写入即停止输出。
- 强度用绝对模式 + `seq`/`B1` ack，且**只在需要变化时下发**——每帧都写会跟物理滚轮打架。
- 滚轮/App 的外部改动会被**采纳**为新目标并上报，而不是被 100ms 后覆盖回去。
- 空闲通道发厂商文档记载的静默哨兵（一个刻意非法的强度值）。
- 单帧同时携带 A/B 两通道，所以两条波形流在 backend 内合成——这正是"保活归 backend"的原因。

**Web Bluetooth 传输**（`apps/desktop/src/main/ble/`）

Web Bluetooth 只存在于渲染进程，所以 BLE 跑在一个隐藏 worker 窗口里，主进程通过桥接驱动它。零原生依赖，Windows 开箱可用。已核对 Chromium 的 GATT 黑名单：郊狼的 `0x180C`/`0x180A`/`0x150A`/`0x150B`/`0x1500` 都不在其中。

**设备选择不抢答**：Electron 的 `select-bluetooth-device` 会随发现进度多次触发，若在空列表上回调空串会立刻取消请求——正是郊狼开机却连接失败的常见原因。所以现在会先收集 3 秒再按名字/服务择优，选不到再重试一次，仍无结果才报可读错误。

会出错的部分（十六进制转换、每特征共享一个订阅、断连扇出、句柄记账、重试语义）都在 `bridge.ts` 里用假桥接做了 19 条单测；剩下的 Electron 胶水（`executeJavaScript` 带 user gesture、`select-bluetooth-device` 事件本身）无法在无显示器无硬件的环境里执行。

## 运行

需要 Node ≥ 22.19 与 pnpm 10。**首次安装不要用 `ELECTRON_SKIP_BINARY_DOWNLOAD`**——沙箱内开发环境用了它，导致 Electron 运行时从未下载，`pnpm install` 一次即可补齐。

```powershell
pnpm install
pnpm run check          # typecheck + test
```

**一键启动控制台**（构建 + 启动 Electron 控制台窗口；依赖安装、lockfile 调和、Electron 二进制恢复全自动）：

```powershell
.\start.bat
```

**没有 GPU 桌面 / 只想在浏览器里测**（纯 Node，mock 设备，无需 Electron，自动打开浏览器）：

```powershell
.\start-dev.bat
```

手动方式：`pnpm --filter @embodied/desktop dev`（或先设 `EMBODIED_DASHBOARD_PORT` 指定端口）。它会打印带 token 的控制台地址，粘贴到浏览器。

等价的手动方式：

```powershell
$env:EMBODIED_DATA_DIR = "E:\embodied-data"   # 可选：固定数据目录，方便找审计日志
pnpm --filter @embodied/desktop start
```

**设备清单（manifest）**：哪些 BLE 单元存在由持久化清单决定（`<dataDir>/state/devices.json`，首次 BLE 运行自动写入一台郊狼 + 一台谜姬）。控制台顶部「设备管理」可随时**添加/移除**设备：添加时选择协议（郊狼 / 谜姬直连 / 模拟），移除会立即停止输出并断开。多台同协议单元在添加时只打开一台即可准确配对。`EMBODIED_WITH_BUTTPLUG = "0"` 可以在没有 Buttplug 设备时跳过 Intiface 探测。

MonsterParty 中继需要分享链接 token：`$env:EMBODIED_MONSTERPARTY_TOKEN = "<token>"`。

## 控制台（HTTP + 静态网页）

Electron 窗口加载的就是控制台网页，它由运行时内置的 HTTP 服务器提供（默认 `127.0.0.1`，端口随机，启动日志会打印带 token 的完整地址）。**同一个网页也可以直接在任何浏览器打开**——桌面窗口只是浏览器的一个壳。

- **这是最终终端的雏形**：HTTP API（`/api/snapshot`、`/api/panic`、`/api/unlock`、`/api/cap`、`/api/pattern`、`/api/stop`、`/api/connect`、`/api/scan`、`/api/waveforms/*`、`/api/audit`）就是终端的能力面，M4b 的 Android WebView / 局域网手机浏览器复用的就是这套接口和这份静态 UI，零改动。UI 是纯静态三个文件（`apps/desktop/src/ui/`），无框架无构建。
- 所有请求都要 `x-control-token`；凭据写在 `<dataDir>/state/dashboard.json`。
- 带外急停（`POST /panic`）是**独立服务器、独立 token**，即使控制台出问题也不受影响。
- 控制台功能：设备管理（添加/移除，添加时选协议）、设备卡片（**不自动连接**：启动与添加都只注册，点「连接」才扫描/连接；断线后同样显示「连接」）、每通道强度/脉宽/时长上限滑块（改动即下发郊狼 `BF` 并审计）、波形下拉选择、15 秒试跑、波形库（导入 hex、会话→库提升）、审计日志尾部、**「日志」/「审计」面板**（后台环形缓冲：BLE 扫描、选择器决策、设备诊断；终端只显示构建令牌/控制台地址等关键一行信息）、大急停按钮 + LOCKED 横幅。

点"试跑"会在对应通道跑 15 秒的 `wave` 包络——用来手工确认整条链路（策略校验 → 调度 → 串行写入 → 审计）真的通了。郊狼会作为 `coyote` 出现，谜姬作为 `xhtkj`；它们在启动时是 `disconnected`，点击卡片上的「连接」后开始扫描；失败的设备同样一键重试，不必重启 app。

## 物理调试顺序

1. **不接设备，先验证急停**：mock 设备试跑 → `Ctrl+Alt+X` → 锁定横幅 + 归零 → 锁定期间试跑被拒 → 解锁 → 审计日志里有 `panic`。
2. **上限先压到 5** 再连接真机（郊狼的 `BF` 硬件软上限在连接时按 policy 写入，之后改滑块会重写）。
3. 郊狼开蓝牙但**别开官方 App**（BLE 一次只允许一个主连接）。
4. 逐台验证：先只动一个通道，感受上限收紧/放宽的差别，再动第二个通道确认互不干扰。
5. 拔掉设备或关蓝牙，确认设备变 `failed`、输出归零、点「重连」能恢复。

## 测试

```
packages/core    635 passed (50 files)
apps/desktop     162 passed (14 files)
```

两份套件要在**各自包目录**下跑（从仓库根跑会跨包解析依赖，`ws` 之类会加载不到）。命令见下节。

M0 的四项验收：

1. **generation token 竞态** —— 在旧效果截止前替换它，旧的终止归零不得穿透。
2. **上限下发前拒绝** —— 超限命令抛错且 `writes` 长度不变；被拒绝的原因进审计。
3. **急停后 LOCKED** —— 模型写入全被拒，停止仍可用，只有人类能解锁；latch 前已入队的写入不会复活输出。
4. **流式硬件自动归零** —— 宿主停止刷新后输出衰减到零；有状态硬件作为对照仍在输出。

M1 的三项出口条件：

5. **两通道各跑不同 pattern 且可单独取消** —— 郊狼 A/B 各带不同波形，停 A 不影响 B。
6. **agent 创作的波形被正确夹紧** —— 峰值 100 的自创波形在 `maxWaveIntensity: 45` 的通道上发出 45。
7. **断开 BLE 后状态正确恢复** —— 设备转 `failed`、效果取消、电平归零、写入审计，后续模型命令被拒。

另有：会话中调低上限**立即生效**（steady 包络去重曾让它失效，测试抓到了这个 bug）、审计槽故障不阻塞急停、`../..` 形式的文档键无法逃出目录、`BF` 写失败时连接被拒绝、前一次会话残留的强度不会被误当成滚轮操作。

## 沙箱下的执行说明

本仓库在 DSH 文件沙箱内开发。两条约束的应对：

- 工具缓存重定向到 `.cache/`（`COREPACK_HOME`、`npm_config_store_dir`、`npm_config_cache`），因为 `%LOCALAPPDATA%` 不可写。
- `pnpm run <script>` 会以管道 stdio 派生子进程，在沙箱下报 `spawn EPERM`。所以验证时直接调工具：

```powershell
cd packages/core  ; node node_modules/vitest/vitest.mjs run --pool=threads
cd apps/desktop   ; node ../../packages/core/node_modules/vitest/vitest.mjs run --pool=threads
cd packages/core  ; node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

**沙箱外不需要这么做**，正常 `pnpm run check` 即可。

## M1 遗留

两项，都不阻塞 M2：

- **ankni 旋转方向编码**：候选帧探测四轮未收敛（`1e56105` … `fea2776`），当前后端只保证"能转、能停"，方向字段待真机再定。
- **Intiface 校验下载**：明确不做，理由见下。

## Intiface 校验下载：为什么不做

参考实现（dsh-toy）会在没装 Intiface 时自动下载官方引擎、逐平台校验 SHA-256、再用手写的 ZIP 读取器只解出那一个可执行文件。那是很认真的供应链代码，但**本仓库目前没有采用**，原因有三：

1. **钉死的版本会过期。** 它钉在 `intiface-engine-4.0.2`，而当前已是 `4.1.0`。
2. **本环境无法验证那张哈希表。** 沙箱里 artifact 下载的 TLS 被拦（`schannel: SEC_E_NO_CREDENTIALS`，git 走自己的 TLS 所以可用）。我不愿意搬运一张自己没验证过的摘要表。
3. **它服务于本部署没有的硬件。** 装 Intiface Central 是一步的事，而且 M4b 的 Android 路径也需要它。

**目前采用的是更重要的那一半纪律**：`IntifaceProcess` 先探测端口，**只有在没人监听时才启动引擎**，并且**只停止自己启动的进程**——不会把操作者自己开着的 Intiface Central 杀掉。找不到引擎时报 `unavailable`，app 照常启动。

## 一个必须知道的量纲问题

**百分比在不同后端不可比。** 郊狼是线性的（`percent × 2` → 强度 0–200）；谜姬把 0–100% 映射到马达可用区间，**1% 的命令已经产生约 31% 的输出**。

所以 `Channel.outputFloorPercent` 会声明「最小非零命令已经产生百分之多少的输出」，`devices_list` 和 UI 都暴露它。默认 `maxPercent` 因此定在 **20**，与 谜姬 参考实现实测后选的默认值一致。
