# Embodied Roleplay

Agent 主持的具身角色扮演系统：摄像头/麦克风感知 + 多设备并行物理反馈，安全边界由硬件与人类共同持有。

**当前状态：M0、M1 完成** —— 安全底座、波形子系统，以及**四个真实后端**：郊狼 V3（BLE）、谜姬 XHTKJ（BLE 直连）、MonsterParty（云中继）、Buttplug/Intiface（集线器）。尚缺感知源、agent 循环与剧本系统（M2）。

## 文档

| 文件 | 内容 |
|---|---|
| `设计文档.md` | 总体架构、需求冻结清单、里程碑、风险 |
| `波形系统设计.md` | 郊狼 V3 波形协议、创作 DSL、许可证决定 |
| `剧本系统设计.md` | 三层剧本、`feedbackIntents`、tentacle 方案评估 |
| `项目分析报告.md` | 两个上游参考项目的分析 |

## 四个真实后端，三种失效语义

这是本项目最重要的一张表：

| 后端 | 传输 | 凭据 | 形态 | 宿主进程死亡后 |
|---|---|---|---|---|
| **郊狼 V3** | BLE 直连 | 无 | 单设备 | ✅ **自动归零**（100ms `B0` 流停止即停止输出） |
| **谜姬 XHTKJ** | BLE 直连 | 无 | 单设备 | ❌ 继续输出 |
| **MonsterParty** | WebSocket 云中继 | 分享链接 token（易过期） | 单设备 | ❌ 继续输出 |
| **Buttplug / Intiface** | WebSocket 到本机引擎 | 无 | **集线器**（多设备，可扫描） | ❌ 继续输出 |

只有郊狼有硬件 dead-man switch。其余三个只能靠宿主定时器加三条急停路径——这就是为什么 mock 里刻意保留了 `mock-hold` 这个「宿主死了还在输出」的对照。

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

会出错的部分（十六进制转换、每特征共享一个订阅、断连扇出、句柄记账）都在 `bridge.ts` 里，用假桥接做了 14 条单测；剩下的 Electron 胶水（`executeJavaScript` 带 user gesture、`select-bluetooth-device`）无法在无显示器无硬件的环境里执行。

## 运行

需要 Node ≥ 22.19 与 pnpm 10。

```powershell
pnpm install
pnpm run check          # typecheck + test
```

启动桌面外壳：

```powershell
pnpm --filter @embodied/desktop start
```

界面会显示全局热键与 `POST /panic` 地址。急停凭据写在 `<userData>/embodied/state/panic.json`（已 gitignore）；用 `EMBODIED_DATA_DIR` 可改数据目录。

点"试跑"会在对应通道跑 15 秒的 `wave` 包络——用来手工确认整条链路（策略校验 → 调度 → 串行写入 → 审计）真的通了。郊狼开机并允许蓝牙后会作为 `coyote` 出现；它没连上也不影响 app 启动，mock 设备照常可用。

## 测试

```
packages/core    249 passed
apps/desktop      64 passed
```

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
node packages/core/node_modules/typescript/bin/tsc --noEmit -p packages/core/tsconfig.json
node packages/core/node_modules/vitest/vitest.mjs run --pool=threads
```

**沙箱外不需要这么做**，正常 `pnpm run check` 即可。

## M1 剩余

Buttplug 后端（移植 dsh-toy 的 v3/v4 协议与 Intiface 校验下载）。你没有 Buttplug 设备，所以它只做 fixture 测试，等有硬件再联调。

## M1 待定的最后一项：Intiface 校验下载

参考实现（dsh-toy）会在没装 Intiface 时自动下载官方引擎、逐平台校验 SHA-256、再用手写的 ZIP 读取器只解出那一个可执行文件。那是很认真的供应链代码，但**本仓库目前没有采用**，原因有三：

1. **钉死的版本会过期。** 它钉在 `intiface-engine-4.0.2`，而当前已是 `4.1.0`。
2. **本环境无法验证那张哈希表。** 沙箱里 artifact 下载的 TLS 被拦（`schannel: SEC_E_NO_CREDENTIALS`，git 走自己的 TLS 所以可用）。我不愿意搬运一张自己没验证过的摘要表。
3. **它服务于本部署没有的硬件。** 装 Intiface Central 是一步的事，而且 M4b 的 Android 路径也需要它。

**目前采用的是更重要的那一半纪律**：`IntifaceProcess` 先探测端口，**只有在没人监听时才启动引擎**，并且**只停止自己启动的进程**——不会把操作者自己开着的 Intiface Central 杀掉。找不到引擎时报 `unavailable`，app 照常启动。

## 一个必须知道的量纲问题

**百分比在不同后端不可比。** 郊狼是线性的（`percent × 2` → 强度 0–200）；谜姬把 0–100% 映射到马达可用区间，**1% 的命令已经产生约 31% 的输出**。

所以 `Channel.outputFloorPercent` 会声明「最小非零命令已经产生百分之多少的输出」，`devices_list` 和 UI 都暴露它。默认 `maxPercent` 因此定在 **20**，与 谜姬 参考实现实测后选的默认值一致。
