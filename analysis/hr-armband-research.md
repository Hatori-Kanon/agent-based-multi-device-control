# 心率臂带接入研究（只读，M2 感知源）

> 范围：只读研究，未安装依赖、未连接设备、未改代码。日期 2026-11-01。
> 证据等级标注：**[厂商]** 厂商文档/官网明示；**[标准]** 蓝牙 SIG 规范原文；**[社区]** 论坛/issue/第三方矩阵；**[推断]** 由上述推得；**[未验证]** 未取到可靠来源，采购前需实测。
> 约束：本文不做医疗用途表述；心率只是**叙事输入**，不是同意信号、不是安全信号。

---

## 0. 结论速览

1. **协议侧零障碍**：`0x180D`/`0x2A37` 是标准通知特征，安全权限为 None（不要求配对/加密），Web Bluetooth 可直接用，且**不在** Web Bluetooth GATT 黑名单里（本地快照核对）。
2. **RR 不是"普遍支持"**：**ECG 胸带普遍有**（H10/H9、Garmin HRM-Dual、Wahoo TICKR 按第三方矩阵），**光学臂带基本没有**——Polar 官方区分 RRI（ECG）与 PPI（光学，仅 SDK 私有通道），Verity Sense / OH1 走标准 HRS 时只发 bpm。这是本次最重要的选型约束。
3. **形态与 RR 冲突**：想要"臂带舒适形态 + RR"目前没有已证实的现货（Scosche Rhythm+ 2.0 营销写 RRi，社区报取不到）。**首选只能回到 ECG 胸带**。
4. **集成不难**：一个 `SensorSource` 新 kind `hr` + 现有 `BleTransport`（`requestDevice` + `subscribe`）即可；难点在**时间对齐**（HRS 无时间戳、~1Hz、无 beat 时间，只能靠到达时刻反推）和**窗口内样本太少**（5–15s 只有 5–15 拍，够算 Δbpm，不够算 RMSSD）。
5. **强烈建议先买 1 台 H10 做一次 2 小时验证**，再决定是否买第二台；不要一次采购多款。

---

## 1. BLE 标准协议：HRS / 0x2A37

### 1.1 服务与特征 [标准]

| 项 | 值 | 要求 |
|---|---|---|
| Heart Rate Service | `0x180D` | Primary Service，无服务依赖 |
| Heart Rate Measurement | `0x2A37` | **Notify 强制**，CCCD 读写强制 |
| Body Sensor Location | `0x2A38` | 可选，只读（0=Other, 1=Chest, 2=Wrist, 3=Finger, …） |
| Heart Rate Control Point | `0x2A39` | 仅当支持 Energy Expended 时强制；只用于写 `0x01` 复位能量累计，我们用不到，可不实现 |

> 规范原文（唯一权威）：<https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html>　安全权限表注明 **Security Permissions = None**，即**不要求配对/绑定/加密**。

### 1.2 报文格式（小端）[标准]

```
byte0: Flags
byte1..: Heart Rate Measurement Value (uint8 或 uint16，由 bit0 决定)
[可选] Energy Expended (uint16, kJ)   — bit3=1 时存在
[可选] RR-Interval × N (uint16, 单位 1/1024 s) — bit4=1 时存在
```

| bit | 含义 | 0 | 1 |
|---|---|---|---|
| 0 | HR 值格式 | uint8 | uint16 |
| 1 | Sensor Contact **Status** | 接触不良/无接触 | 接触良好 |
| 2 | Sensor Contact **Support** | 设备不支持该特性 | 支持 |
| 3 | Energy Expended 存在 | 无 | 有 |
| 4 | RR-Interval 存在 | 无 | 有（≥1 个） |
| 5–7 | RFU | 必须为 0 | — |

**RR 换算**：`rrMs = raw * 1000 / 1024 = raw * 0.9765625`（如 `0x030F`=783 → 764.6 ms）。
**单包 RR 上限**（ATT_MTU=23）：uint8 且无 EE → 9 个；有 EE → 8 个；uint16 且无 EE → 8 个；有 EE → 7 个。装不下时**顺延到下一包**，缓冲区满可**丢最旧**——所以客户端不能假设"每包都完整"。

**解码示例**：`16 4A 0F 03 0F 03`
`0x16=0b0001_0110` → bit1=1 接触良好、bit2=1 支持接触检测、bit4=1 有 RR、bit0=0 uint8；HR=`0x4A`=74 bpm；两个 RR=`0x030F`=783 → 764.6 ms、764.6 ms。

### 1.3 频率、连接参数、配对

- **通知频率**：规范写"典型约 **1 次/秒**"，Energy Expended 约 1 次/10 秒，**且由服务端决定、客户端不可配置** [标准]。这决定了：心率的时间分辨率天然是 ~1s，5–15s 反应窗口最多 5–15 个 HR 样本。
- **连接参数**：HRS 规范不规定；实测多为 1s 通知、空闲连接间隔数十 ms 级 [推断]。
- **无时间戳**：规范 3.4 明确"该服务不提供时间戳"，连接建立失败或通知未送达时**该值必须丢弃** [标准] → 客户端断线期间的数据是空洞，不能补。
- **配对/加密**：服务本身 None；Windows 上 HRS 设备通常以 Just Works 直连，不需要用户去系统设置里配对 [推断，需实测]。

### 1.4 Windows 上 Chromium/Electron 的 Web Bluetooth

- Web Bluetooth 在 Windows 上由 Chromium 走 WinRT 实现，`requestDevice` 需要**安全上下文 + 用户手势**，且**必须**在 `filters.services` 或 `optionalServices` 里声明要访问的服务，否则拿到设备也用不了 [MDN]。
- **GATT 黑名单**：Web Bluetooth 的 blocklist 在 `WebBluetoothCG/registries`。**本仓库就带了一份快照**：`_reference/wbt-registries/gatt_blocklist.txt`（67 行）中**没有** `0x180D`，`gatt_assigned_services.txt` 里 `heart_rate` 在册 → 过滤名 `heart_rate` 与短 UUID 都能用。快照可能滞后上游，但 HRS 被拉黑的现实风险极低。
- 注意：黑名单是**逐 UUID** 的；HRS 属于"纯通信协议类"服务，政策上一般不会被整体拉黑（见 `_reference/wbt-registries/gatt_blocklist_policy.md`）。

### 1.5 隐藏 Electron 渲染窗口里 `requestDevice` 的注意点（对照本仓库代码）

现有实现 `apps/desktop/src/main/ble/electron-bridge.ts:281-310` 已经踩过坑，心率要复用同一套：

1. **必须**注册 `contents.on('select-bluetooth-device')`，否则第一个 `requestDevice` 永远不 settle（代码注释原话）。心率设备不能另写一套选设备逻辑。
2. 需要给该窗口 `bluetooth` 权限（`apps/desktop/src/main/index.ts:189` 附近），否则 `requestDevice` 直接被拒。
3. `backgroundThrottling: false` 必须保留，否则隐藏窗口的扫描/通知事件被节流（表现为"一个设备都搜不到"）。
4. **同一渲染器同一时刻只会有一个 pending 的 `requestDevice`**（代码里已有"worker 卡住就 reload"的兜底）。心率若与郊狼**并发**发起 `requestDevice`，会互相阻塞 → **必须串行选设备**，或在同一 worker 内用"先连郊狼、后连心率"的顺序编排；连上之后两条 `subscribe` 互不干扰。
5. 过滤器建议：`{ filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service', 'device_information'] }`。部分胸带**只有在电极沾湿/贴皮肤后才开始广播** `0x180D`，UI 上要给"先戴上再扫描"的提示；搜不到时可用 `acceptAllDevices: true` + `optionalServices` 兜底 [推断]。

---

## 2. 设备矩阵（重点）

> "RR"= 是否通过**标准 HRS `0x2A37`** 输出 RR-Interval。厂商私有 PPI 通道（Polar SDK）**不算**，因为我们不做厂商 SDK 集成。
> 价格仅列已核到的；国内渠道价**未核价**，只写"常见渠道"。

| 设备 | 形态/原理 | 标准 HRS | **RR** | 证据 | 续航/防水 | 价格 | 国内渠道 |
|---|---|---|---|---|---|---|---|
| **Polar H10** | 胸带 / ECG | 是 [厂商] | **是**（ECG RRI） | 社区+官方口径：RRI 仅 ECG 设备（H9/H10）[社区]；HRV 矩阵 ✓ [社区] | 未核（官网未取到具体小时数） | €99.90（官网） | 京东/天猫 Polar 旗舰（未核价） |
| **Polar H9** | 胸带 / ECG | 是 [厂商] | **是** [社区] | HRV 矩阵 ✓ | 未核 | 未核 | 同上 |
| **Polar Verity Sense** | 臂带 / 光学 PPG | 是 [厂商：HRS+BAS+DIS] | **否** | 官方手册只列 HRS；社区确认"光学不发 RR，只有 PPI"[社区]；HRV 矩阵注明"optical don't broadcast RR"[社区] | 30h 连续 / 50m [厂商] | 未核 | 京东/天猫（未核价） |
| **Polar OH1 / OH1+** | 臂带 / 光学 | 是 [厂商] | **否** | 同上；矩阵写"需 Polar SDK 才有 PPI" | 未核 | 未核 | 二手/代购为主 |
| **Scosche Rhythm+ 2.0** | 臂带 / 光学 | 是 [厂商] | **存疑** | 电商文案写"HRV & RRi"[厂商营销]；但社区 issue 报"取不到 RR"[社区] | 未核（文案称 24h） | 未核 | 海淘为主 |
| **CooSpo HW706** | 臂带 / 光学 | 是（BT+ANT+）[厂商] | **未验证** | 厂商规格表有 HRV 一列，但本次未取到取值 | IP67 [厂商] | 约 ¥200–300（未核） | 京东/淘宝有售 |
| **Magene H64** | 胸带 / ECG | 是（BT4.2+ANT+）[厂商] | **未验证** | 仅见商品页，无 RR 明示 | IP67（商品页称） | 约 ¥150–250（未核） | 京东/淘宝 |
| **Wahoo TICKR** | 胸带 / ECG | 是 [厂商] | **是**（按第三方矩阵） | HRV 矩阵 ✓ [社区]；厂商页未提 RR | 未核 | 未核 | 海淘/部分国内店 |
| **Wahoo TICKR FIT** | 臂带 / 光学 | 是 | **否** | 矩阵注明"optical armband doesn't broadcast RR"[社区] | 未核 | 未核 | 海淘 |
| **Garmin HRM-Dual** | 胸带 / ECG | 是 [厂商] | **是**（按第三方矩阵） | HRV 矩阵 ✓ [社区]；Garmin 页按地区跳转，未取到 RR 原文 | 未核 | 未核 | 京东/天猫 Garmin（未核价） |

**读法**：凡是"光学 + 标准 HRS"，目前**没有一台被证实会发 RR**。厂商普遍把 PPI 放进自家 SDK，因为光学在运动时"任何移动或肌肉活动都会让数据变成垃圾"（Sleep as Android 开发者原话，转述 Polar 团队解释）[社区]。→ **要 RR 就必须买 ECG 胸带，这是硬约束。**

**精度/延迟**：本次**没有**取到任何可引用的量化对比（ms 级延迟、bpm 误差），一律标 **[未验证]**，不要在文档或提示词里写数字。可确定的只有定性事实：ECG 直接测电信号，光学测血流（PPG），后者对接触压力、肤色、体动更敏感 [推断，基于上述社区证据]。

## 3. RR 数据的可用性

### 3.1 指标与窗口 [文献]

- **RMSSD** = `sqrt(mean(ΔRR²))`，逐拍差分的均方根；**SDNN** = RR 的标准差；**pNN50** = 相邻 RR 差 >50ms 的占比。
- **窗口**：临床"短时"标准是 **5 min**；文献提出超短时可用 60s，甚至 30s/10s，但**超短时 HRV 本身有争议**，不能与 5min/24h 数值互换。
- 对我们的用法：**不做临床 HRV**。只用 (a) 相对基线的 bpm 趋势、(b) 静息 60s 的 RMSSD 相对变化。60s ≈ 60–80 拍，勉强够 RMSSD；**5–15s 窗口只够算 Δbpm，不够算 RMSSD**（这是硬性的数学约束，不是实现问题）。

### 3.2 伪影与接触

- 漏拍/异位拍会同时污染 SDNN 与 RMSSD；文献指出"5min 段里只要 2 个伪影就能显著扭曲部分指标" → 必须做伪影剔除（常用：相邻 RR 变化 >20% 判为异常，Kubios/Malik 惯例 **[未验证原文]**，实现时按经验值可配）。
- **接触**：`0x2A37` flags 的 bit1/bit2 直接给接触状态，**必须透传**，不要自己猜。胸带电极干、汗少时会先出接触不良再出噪声。
- **预热**：ECG 胸带沾湿后数秒稳定；光学器件通常需要数十秒 [推断/未验证]。建议：连上后先跑 60s "预热期"，期间 `quality='warming'`，不进提示词。

### 3.3 什么信号可以"驱动体感"

| 信号 | 可靠性 | 用途 |
|---|---|---|
| 相对基线的 bpm 变化（30–60s 基线，5–15s 窗口） | 高 | 唯一建议的驱动信号 |
| bpm 趋势方向（升/平/降，30s 尺度） | 中高 | 节奏调整 |
| 静息 60s RMSSD 的相对变化 | 中（需静坐、伪影率低） | 低频"状态"叙事，不作实时反馈 |
| 绝对值 bpm 解释情绪（"心跳快=兴奋/害怕"） | **低** | **禁止**。同一 bpm 可以是运动、热、咖啡因、紧张 |
| 单次 RR / 5s 内 RMSSD | **低** | 不用 |
| 运动中（肢体活动）的 RMSSD | **很低** | 不用 |

### 3.4 明确提醒

**心率不是同意信号，也不是安全信号。** 它不表达意愿、不能撤销、不能替代口头确认；不得用它推断"可以继续/可以加码"，不得把它接入 `SafetyPolicy` 或任何自动加码路径。它只是**和摄像头运动量同级的一条叙事事实**。

## 4. 与我们的集成设计

### 4.1 数据契约（`SensorSource` 新 kind `hr`）

现有接口（`设计文档.md` §9）：`{ id, kind: 'image'|'audio', latest(), freshnessMs() }`。扩展为 `kind: 'hr'`，快照：

```jsonc
{
  "sourceId": "hr-chest-1",
  "kind": "hr",
  "ts": 1790000000000,          // 到达时刻（本机单调钟换算）
  "bpm": 78,                    // 最近一次通知值；无则 null
  "rrMs": [812, 806, 799],      // 最近一个包的 RR（原始，已换算 ms）；无 RR 时 []
  "rrWindowMs": 60000,          // 环形缓冲覆盖时长
  "artifactRatio": 0.04,        // 最近 60 拍中被剔除比例
  "contact": "yes",             // yes | no | unknown（透传 flags bit1/bit2）
  "quality": "ok",              // ok | warming | poor-contact | no-rr | stale | reconnecting
  "baselineBpm": 72,            // 30–60s 基线均值（无基线时 null）
  "deltaBpm15s": 6              // 相对基线的窗口增量（probe 用）
}
```

### 4.2 采样与聚合

- **原始层**：每条 notification 解析 → 产出 1..9 个 RR → 反推**每拍时间戳** `t_i = t_arrival - Σ(rr 之后的拍)`（HRS 无时间戳，这是唯一可行的时间重建 [推断]）。
- **环形缓冲**：保留最近 90s 的 (beatTime, rr)；`artifactRatio` 按最近 60 拍滚动计算。
- **聚合层**：1Hz 产出快照。`bpm` 用 5s EMA 平滑（避免 1Hz 抖动直接进提示词）；`baselineBpm` 用 30s 均值，动作发生时"冻结"基线。
- **不聚合 RR 成"心率变异性分数"**：没有可靠的绝对阈值，任何 0–100 的"HRV 分数"都是编的。

### 4.3 断线重连

- `onDisconnect` → `quality='reconnecting'`，指数退避 1s/2s/4s，上限 30s，**最多 3 次**后转 `stale` 并要求用户手动重连（不静默重试到死）。
- 重连成功后**清空环形缓冲**（断线期间数据按规范必须丢弃），重新进 `warming` 60s。
- 断线不影响郊狼链路：两者订阅独立，但**共用同一个隐藏 worker**，重连的 `requestDevice` 必须走串行队列（见 §1.5.4）。

### 4.4 与摄像头/音频 probe 的时间对齐

- **反应窗口**：动作 `actionAt` 后 **5–15s**（心率反应慢于运动/音频的 1.5–3s）。基线取 `[actionAt-30s, actionAt]`，窗口取 `[actionAt+5s, actionAt+15s]`。
- 判定：`Δbpm = windowMean - baselineMean`；要求窗口内 ≥5 个 HR 样本且 `artifactRatio < 0.2` 且 `contact != 'no'`；否则 `verdict='ambiguous'`（沿用草案"宁可不确定"的原则）。
- **不要用音频/摄像头的 1.5–3s 窗口套心率**——那会系统性判成"无反应"。
- 时钟：统一用到达时刻（单调钟），**不要**用设备时间；Windows 定时器抖动 ±10–50ms 对 5–15s 窗口无影响 [推断]。

### 4.5 提示词注入（只给事实）

```
【心率】基线 72 bpm；最近 15s 平均 78（+6）；接触良好；RR 可用（伪影 4%）
【最近探测】A 通道 短促试探(2s) → 动作后 5–15s 心率 +5 bpm（基线 72）
【约定】心率只作参考：升高可能来自运动/热/紧张，不单独作为加码或停下的依据
```
- 不写"兴奋/害怕/享受"等标签；不写"心率高说明 ta 喜欢"。
- 无 RR 设备：只给 `bpm` 与趋势，**不出现** RMSSD/HRV 字样。
- 质量差：只给事实（"接触不良，数据暂停"），让模型走叙事，不扣分。

### 4.6 审计与隐私

- 审计条目：`actor: sys, action: hr_probe, payload: {bpmDelta, baselineBpm, artifactRatio, quality, windowMs}`——**默认不落原始 RR**（心率属敏感健康数据；原始序列只留在内存环形缓冲）。
- 全部本地处理：不接 Polar Flow/厂商云，不调 SDK，不上传。
- 若未来要落盘做调试，单独开关 + 明确路径 + 可一键删除。

## 5. 兼容策略与回退

1. **只用标准 HRS**，不接 `polar-ble-sdk` / 任何厂商 SDK。理由：SDK 要账号/授权、绑定平台（Android/iOS），与我们 Electron+Web Bluetooth 的边界冲突，且 PPI 反而不可比。
2. **只有 bpm 没有 RR**：`rrMs=[]`、`quality='no-rr'`。可用能力降级为"基线趋势 + 窗口 Δbpm"，禁用一切 HRV 指标；提示词相应少一行。这是**一等公民**，不是错误态（大多数光学臂带都落在这里）。
3. **多源冲突**：同时只激活**一个** `hr` 源（用户选定）。优先级建议 ECG 胸带 > 光学臂带 > 手机摄像头 PPG（后者我们不做）。**不做多源平均**——不同设备延迟不同，平均只会制造假精度。切换源时清空缓冲并重新预热。
4. **ANT+ 不需要**。理由：Web Bluetooth 不支持 ANT+；PC 上要 USB dongle + 驱动 + 原生模块，等于给 Electron 加一条平台依赖；而我们要的 RR 在 BLE HRS 上已经能拿到（ECG 胸带）。**结论：只做 BLE。**
5. 与 `ports/ble.ts` 的关系：完全复用。`BleFilter{ services:['heart_rate'], optionalServices:['battery_service'] }`，`subscribe({service:'heart_rate', characteristic:'heart_rate_measurement'})`，无需改端口。**唯一要新增的是"同一 worker 内多设备串行选设备"的编排**。

## 6. 采购与验证建议

### 6.1 买什么

| 角色 | 型号 | 理由 |
|---|---|---|
| **首选** | **Polar H10** | 唯一"RR + ECG + 标准 HRS + 国内好买 + 社区生态最大"的交集；€99.90 官网价可查；HRV 矩阵全 ✓ |
| **备选（省钱/胸带）** | **Garmin HRM-Dual** | 更便宜、RR 按第三方矩阵可用；但厂商页未明示 RR，需到货实测 |
| **形态备选（仅 bpm）** | **Polar Verity Sense** | 臂带舒适、30h 续航、50m 防水；**明确无 RR**，只能做趋势——如果你最终认为"舒适 > RR"，它是对的选择 |
| **不建议盲买** | Scosche Rhythm+ 2.0 / CooSpo HW706 | 前者营销称 RRi 但社区取不到；后者 RR 完全未验证。**要买就先买 1 台做验证**，别当主力 |

国内渠道：京东/天猫 Polar、Garmin 旗舰店（价格未核，下单前自查）；CooSpo/Magene 京东淘宝均有。

### 6.2 到货验证（按顺序，2 小时内可完成）

1. **静息 RR 质量**：坐姿静止 5min。检查 `0x2A37` flags bit4 是否为 1、`rrMs` 是否落在 600–1100ms、有无 0/异常值、`artifactRatio` 是否 <5%。**bit4 恒为 0 = 这台的 RR 不可用，直接退货**。
2. **bpm 正确性**：手动数脉搏 30s ×2，与设备 bpm 比对，差 ≤3 bpm 视为可用（不作为医疗精度声明）。
3. **运动中伪影**：原地抬臂/走动 2min，记录 `artifactRatio` 与 bpm 跳变幅度；据此定死"运动中禁用 RMSSD"的阈值。
4. **时间对齐**：手动做 10 次"点击标记"，记录 `actionAt`，统计心率峰值相对 actionAt 的延迟分布（预期 5–15s）；若中位数落在窗口外，说明窗口参数要按设备调。
5. **断线重连**：关机 10s 再开，验证 `quality` 状态机与 3 次退避上限。
6. **并发**：与郊狼 B0 100ms 流同时跑 10min，确认隐藏 worker 的 `requestDevice` 串行化没有把郊狼流卡死、通知无丢帧。

---

## 7. 风险与未知

| # | 风险/未知 | 影响 | 缓解 |
|---|---|---|---|
| 1 | **光学臂带无 RR**（结构性） | 买了臂带只能做 bpm 趋势 | 首选 ECG 胸带；臂带只作"舒适优先"备选 |
| 2 | 部分厂商 RR 只在特定固件/批次 | 到货才发现不可用 | 验证步骤 1 作为硬门槛，留退货窗口 |
| 3 | Scosche/CooSpo 的 RR 说法未经证实 | 采购踩坑 | 只买 1 台先验，不批量 |
| 4 | HRS ~1Hz + 无时间戳 | 5–15s 窗口只有 5–15 样本；断线丢数据不可补 | 只做 Δbpm，不做实时 HRV；窗口参数按实测标定 |
| 5 | 与我们现有隐藏 worker 的**单设备 chooser** 冲突 | 心率与郊狼并发选设备互相阻塞 | 串行选设备；必要时心率单独一个 worker（但注意 Windows 单适配器并发） |
| 6 | Windows 蓝牙栈缓存/配对态导致 `requestDevice` 看不到设备 | 首次接入失败 | 用 `acceptAllDevices` 兜底 + 让用户先在系统里移除配对 |
| 7 | 精度/延迟无量化数据 | 无法承诺任何数值指标 | 全部标 [未验证]，验证后再写进设计文档 |
| 8 | 心率是敏感健康数据 | 隐私/伦理 | 本地处理、默认不落原始 RR、不做医疗表述 |
| 9 | 被误用为"同意/安全"信号 | 伦理红线 | 写进契约与提示词：仅叙事输入，不进 SafetyPolicy |
| 10 | 胸带维护（电极老化、汗渍腐蚀） | 长会话掉线 | 社区公认 H10 表带约 1 年一换（重度使用），当耗材看 |

---

## 8. 来源清单

**标准/协议**：HRS v1.0 规范 <https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html>（flags/格式/1Hz/无时间戳/Security=None）· MDN `requestDevice` <https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice> · Web Bluetooth 注册表 <https://github.com/WebBluetoothCG/registries>（本地快照 `_reference/wbt-registries/`）· ANT+ <https://www.thisisant.com/>

**厂商**：Polar H10 <https://www.polar.com/en/sensors/h10-heart-rate-sensor>（€99.90）· Verity Sense 技术规格 <https://support.polar.com/e_manuals/verity-sense/polar-verity-sense-user-manual-english/technical-specifications.htm>（HRS/BAS/DIS、30h、50m）· CooSpo HW706 <https://www.coospo.com/products/hw706-armband-heart-rate-monitor> · Garmin HRM-Dual <https://www.garmin.com/en-US/p/649059>（按地区跳转）· Scosche Rhythm+ 2.0 文案 <https://www.amazon.sg/Rhythm-2-0-Waterproof-Monitor-Armband/dp/B08BNB2N5C>（"HRV & RRi"）

**社区/第三方**：Sleep as Android 论坛"Verity Sense 与 RR"（RRI=ECG、PPI=光学，转述 Polar 解释）<https://forum.urbandroid.org/t/question-about-polar-verity-sense-and-rr-intervals/12597> · polar-ble-sdk #386 <https://github.com/polarofficial/polar-ble-sdk/issues/386> · Adafruit BLE_Heart_Rate #17（Rhythm+2.0/Rhythm24 取不到 RR）<https://github.com/adafruit/Adafruit_CircuitPython_BLE_Heart_Rate/issues/17> · HRV Zone 兼容矩阵 <https://hrvzone.com/compatibility> · TrainerRoad "Which HRM to buy in 2024" <https://www.trainerroad.com/forum/t/which-hrm-to-buy-in-2024/95719>

**文献**：Shaffer & Ginsberg 2017, *An Overview of HRV Metrics and Norms*（RMSSD/SDNN 定义、5min vs 超短时争议、伪影敏感性）<https://pmc.ncbi.nlm.nih.gov/articles/PMC5624990/>

**本仓库（只读）**：`设计文档.md` §9（`SensorSource`）、`感知闭环与控制分离-设计草案.md`（probe 契约与 verdict）、`packages/core/src/ports/ble.ts`、`apps/desktop/src/main/ble/electron-bridge.ts:281-310`。

---

## 9. 实测补充（2026-11-01，HW9 真机）

- **标准 HRS 带 RR 的光学臂带确实存在**：CooSpo HW9 实测静息 5m17s，`0x2A37` flags bit4=1 占 95.6%，401 个 RR 全部 ∈[400,1500]ms、静息伪影 0%，心拍覆盖 96.9%。这修正了 §2 "光学臂带基本没有 RR" 的普遍结论（普遍 ≠ 全部；HW9 是例外，且不必碰私有 `0xFD00`）。
- **RR 门控是"臂动"而非"全身动"**：用户实测，佩戴臂不动时 RR 持续，即使身体其他部位在动；手臂摆动/走动时设备关闭 RR（S2 走路段 0 RR、抬臂段 6.4%）。
- **接触位不可用**：bit1/bit2 恒 0；离体检测只能靠 HR=0（≤1.1s 生效，通知不停）。
- 集成含义：`hr` 源应把 `rr-rest`（臂静）与 `bpm-only`（臂动）做成两种正常状态；佩戴建议非惯用臂；动作/姿势设计尽量减少佩戴臂摆动。详见 `analysis/hw9-capture/INDEX.md`。
