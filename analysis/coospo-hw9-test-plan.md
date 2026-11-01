# CooSpo HW9 臂带 BLE 协议测试需求与记录文档

> 用途：拿到一台 CooSpo HW9（官网标注支持 HRV），用一次可复现的测试回答"它能不能作为我们项目的可靠心率源"。
> 读者：执行测试的另一个会话（可以完全照着做，不需要先读我们的设计文档）。
> 状态：测试需求 + 操作手册 + 数据规格，不含产品代码改动。
> 产出位置建议：`analysis/hw9-capture/<YYYYMMDD-HHmmss>/`（新建目录，不覆盖已有文件）。

---

## 0. 要回答的问题（按重要性）

| # | 问题 | 为什么重要 |
|---|---|---|
| Q1 | 是否提供标准 Heart Rate Service `0x180D` / `0x2A37`，能否不配对直连？ | 决定我们能不能复用现有 Web Bluetooth 桥 |
| Q2 | `0x2A37` 的 flags **bit4（RR-Interval）** 是否为 1？多久出现一次？ | 决定有没有 RR 原始数据（官网只说"支持 HRV"，不等于标准 RR） |
| Q3 | 每个通知包里有几个 RR？RR 值是否合理（400–1500ms）？伪影比例？ | 决定能不能做"动作后 Δbpm"和离线短时 HRV |
| Q4 | 通知频率、接触状态 bit1/bit2 是否可用？摘下/戴上会不会变？ | 决定数据质量与新鲜度判定 |
| Q5 | 如果标准 HRS 不带 RR：有没有厂商私有服务/特征在发通知？UUID、属性、频率、报文长度？ | 决定要不要为它做私有协议（成本高） |
| Q6 | 官方 App 说的 HRV 是设备端算的还是 App 端算的？ | 判断私有通道是否只是原始 PPI 流 |
| Q7 | 固件/型号/硬件版本、电量、广播名与广播里是否带 `0x180D` | 可复现性与同型号差异 |
| Q8 | 与郊狼 B0 流并发时，BLE 是否会被卡（隐藏 worker 单 pending `requestDevice`）？ | 决定多设备同连的可行性 |
| Q9 | 断线重连行为（3 次退避、是否清缓冲、是否需要重新选设备） | 长会话稳定性 |
| Q10 | Windows 配对/缓存是否导致第二次连接看不到设备？ | 影响用户体验与排障 |

---

## 1. 前置条件（做之前先确认）

- [ ] HW9 充满电；臂带电极/光学面干净；按官方佩戴位置戴好（上臂，避开肘窝）。
- [ ] **关闭 CooSpo 官方 App / 手机上所有可能连它的 App**（BLE 外设同一时刻通常只接受一个中心设备连接；官方 App 连着时 PC 连不上）。
- [ ] 测试期间**不要**同时启动我们的刺激设备（第一次测试保持无刺激，避免干扰判断）。
- [ ] Windows：蓝牙打开；设置里**移除**与 HW9 的既有配对（减少"已配对导致 Web Bluetooth 看不到/连不上"的坑）；测试结束前不要更新固件。
- [ ] 记录测试机信息：Windows 版本、Chrome/Edge 版本、蓝牙适配器型号（设备管理器）。

---

## 2. 工具路线（三条，按顺序用）

### 路线 A：nRF Connect for Mobile（安卓/iOS，**首选**，负责"全量枚举 + 原始抓包"）
- 安装 Nordic 的 **nRF Connect**；扫描 → 连接 HW9 → 展开全部服务。
- 对每个 characteristic 记录：UUID、属性（read/write/notify/indicate）、是否有描述符（0x2902 CCCD、0x2901 用户描述）。
- 对 `0x2A37` 打开 notify，观察 1–2 分钟；**开启 Log**，结束时导出/截图。
- 对其它可 notify 的特征也各订阅 2 分钟，记录原始 hex（这是找厂商 HRV 通道的关键）。
- 优点：能看到**全部**服务（Web Bluetooth 做不到未知服务枚举）；能导出日志。

### 路线 B：Windows `edge://bluetooth-internals`（PC 侧可行性）
- Edge/Chrome 打开 `edge://bluetooth-internals`（Chrome 为 `chrome://bluetooth-internals`）→ Start Scan → 选中 HW9 → Inspect。
- 确认 PC 侧 WinRT 能不能看到同样的服务/特征；对 `0x2A37` 尝试 Start Notifications。
- 记录：设备 ID、广播信息、服务列表、通知是否成功。

### 路线 C：浏览器 HRS 抓包 harness（验证解析链路，见附录 B）
- 保存附录 B 的 HTML 到本地，用 `python -m http.server 8080` 起在 `http://localhost:8080/`，Chrome 打开。
- 点"连接心率带"→ 选 HW9 → 自动订阅 `0x2A37` 并输出 JSONL；可下载。
- 如果路线 A 发现厂商私有服务，在 harness 里填入该服务/特征 UUID，切到"原始模式"抓 hex（需把 UUID 加进 `optionalServices`）。

> 三条路线不冲突：A 拿全貌，B 验 Windows 路径，C 验我们的解析与记录格式（也是后续集成的最小原型）。

---

## 3. 测试阶段（按顺序执行，每步记录）

### T0 设备与广播信息（5 分钟）
1. nRF Connect 扫描页截图：设备名、MAC（若有）、RSSI、广播里出现的服务 UUID（特别看有没有 `0x180D`）。
2. 连接后读 Device Information `0x180A`：`0x2A29` 厂商、`0x2A24` 型号、`0x2A26` 固件、`0x2A27` 硬件、`0x2A25` 序列号（读不到就记"不支持"）。
3. 读 Battery `0x180F`/`0x2A19` 电量（若有）。
4. 写入 `meta.json`（见 §5）。

### T1 GATT 全量枚举（10 分钟）
1. nRF Connect 展开所有 primary service 与 characteristic。
2. 记录成 `gatt.json`（结构见 §5），**必须包含**：UUID、名称/未知、属性、notify/indicate、是否有 CCCD、用户描述。
3. 标出：标准服务（180A/180D/180F/1810 等）与**非标准/厂商服务**（如 0xFFF0、128 位 UUID）。

### T2 标准 HRS 订阅与原始帧（≥10 分钟静息）
1. 订阅 `0x2A37`，静坐/静躺 10 分钟（不要动臂带）。
2. 全程记录**原始 hex**（不要只记录解析值），一行一条。
3. 统计：通知条数/分钟、flags 取值分布、HR 值范围、每包 RR 个数、包长分布。
4. 判断 Q2：bit4 是否出现；若从不出现 → 走 T4。

### T3 RR 质量评估（静息 5 分钟 + 计算）
1. 取静息 5 分钟 RR 序列（优先用 nRF Connect 导出），离线算：
   - RR 中位数、P5/P95、最小值/最大值；
   - 相邻 RR 变化 >20% 的比例（粗伪影率）；
   - 60s 窗口 RMSSD（只作 sanity，不宣称临床值）。
2. 判定 Gate B（见 §6）。
3. 注意：如果包内 RR 少于 2 个/包或大量丢拍，如实记录，不要用插值"补漂亮"。

### T4 厂商私有通道搜索（仅当 T2 无 RR；20 分钟）
1. 对 `gatt.json` 里所有 **notify/indicate** 的非标准特征逐个订阅 2 分钟。
2. 记录：原始 hex、包长、通知周期、与 `0x2A37` 时间关系、与 HR 变化是否相关。
3. **只记录，不猜测协议**；把"看起来像 RR/PPI 的候选"列出来（如每包 2 字节小端、~1s 一包、数值 300–1500）。
4. 若官方 App 有 HRV 页面：打开 App 观察 HRV 是否有数值；但**关闭 App 后再抓包**，避免占用连接。

### T5 接触/佩戴状态（10 分钟）
1. 正常佩戴 2 分钟 → 记录 contact bit（bit1）取值。
2. 摘下臂带 60s → 记录 bit1/bit2、HR 是否变 0、通知是否停止。
3. 重新戴上 → 记录恢复时间（预热）。
4. 干燥/少量汗 vs 出汗后各测一次（如果条件允许）。

### T6 运动伪影（10 分钟）
1. 原地抬臂 30 次 / 走动 2 分钟，记录 RR 跳变幅度、丢拍、bpm 跳变。
2. 结论写成"运动中 RR 是否可用/只能 bpm"。

### T7 精度对照（5 分钟）
1. 手动数脉搏 30s × 2 次，与设备 bpm 对比（只记差值，不做医疗宣称）。
2. 如有第二台心率设备，可同时戴做趋势对比（可选）。

### T8 并发与重连（20 分钟）
1. 与郊狼 B0 流并发（如果手边有）：先连郊狼、再连 HW9；观察郊狼流是否卡顿、HW9 通知是否丢。
2. 记录"同一隐藏 worker 是否只能串行选设备"（如果用了我们的 Electron 桥）。
3. 断连重连 3 次：关机/走远/关蓝牙，记录重连耗时、是否要重新选设备、缓冲是否清空。

### T9 长时间稳定（可选，30 分钟）
1. 连续 30 分钟静息记录：丢包率、断连次数、电量变化。
2. 记录到 `summary.md`。

---

## 4. 记录纪律（必须遵守）

1. **永远保留原始 hex**；解析值只作为附加字段。没有原始数据的结论不可回溯。
2. 每条记录必须有**本机到达时间**（毫秒）与工具名；HRS 没有设备时间戳。
3. 不确定就写"未验证"，不要填猜测的数字。
4. 健康数据只存本地；提交/分享前去掉序列号与 MAC；**不要提交到 git**。
5. 一次测试一个变量：不要边运动边改佩戴位置又边重连。

---

## 5. 数据格式与目录

```
analysis/hw9-capture/<YYYYMMDD-HHmmss>/
├── meta.json          # 设备/环境/测试者
├── gatt.json          # 全量服务特征
├── notifications.jsonl# 原始通知（一行一条）
├── summary.md         # 回答 §0 的 Q1–Q10 + Gate 结论
├── exports/           # nRF Connect 导出的 CSV/截图
└── README.md          # 复现步骤与本轮异常说明
```

`meta.json`：
```jsonc
{
  "device": { "name": "CooSpo HW9", "mac": "（脱敏）", "model": "", "firmware": "", "hardware": "", "serial": "（脱敏）" },
  "env": { "os": "Windows 11 24H2", "chrome": "…", "adapter": "…", "tools": ["nRF Connect 4.x", "edge://bluetooth-internals", "harness.html"] },
  "tester": "（可选）",
  "startedAt": "2026-11-01T17:30:00+08:00",
  "notes": ""
}
```

`gatt.json`（每一项都要）：
```jsonc
{
  "services": [
    {
      "uuid": "0000180d-0000-1000-8000-00805f9b34fb",
      "name": "Heart Rate",
      "standard": true,
      "characteristics": [
        {
          "uuid": "00002a37-0000-1000-8000-00805f9b34fb",
          "name": "Heart Rate Measurement",
          "properties": ["notify"],
          "cccd": true,
          "userDescription": null
        }
      ]
    }
  ],
  "advertisement": { "name": "…", "services": ["…"], "manufacturerData": "hex" }
}
```

`notifications.jsonl`：
```jsonc
{"t":"2026-11-01T17:31:02.412+08:00","monoMs":123456,"tool":"nrf|edge|harness","service":"180d","char":"2a37","hex":"164a0f030f03","decoded":{"flags":22,"hr":74,"contactStatus":true,"contactSupported":true,"rrMs":[764.6,764.6]},"note":""}
```

---

## 6. 判定门槛与决策

| Gate | 条件 | 结论 |
|---|---|---|
| **A 可连接** | 能完成 `0x180D` 连接并收到 `0x2A37` 通知（≥10s） | 协议侧可用 |
| **B RR 可用** | 静息 5min：≥80% 通知 bit4=1；**RR 覆盖心拍 ≥95%**（或 RR 总数 ≥ 心跳总数×95%）；≥95% 的 RR ∈ [400,1500]ms；粗伪影率 <5% | **可作为 RR 源**：支持动作后 Δbpm + 离线 60s RMSSD |
| **B- 仅 bpm** | 有 HRS 但 bit4 恒 0 或 RR 质量不达标 | 降级：只做 bpm 趋势（`quality=no-rr`），不做 HRV |
| **C 私有通道** | 标准 HRS 无 RR，但存在非标准 notify 特征，且周期/数值可疑 | 进入逆向评估；**不承诺**可用，先记录 |
| **D 不可用** | 无法连接 / 无任何通知 / Windows 方案不稳定 | 放弃该型号，换 Polar H10 验证 |

**决策树**：Gate A 不过 → D；A 过 + B 过 → 首选（RR 源）；A 过 + B 不过 + C 有发现 → 评估私有协议成本（默认不投入）；A 过 + B/C 都不行 → 仅 bpm 趋势。

> 2026-11-01 修订：原判据「每包 ≥2 个 RR ≥80%」隐含假设设备一次打包多拍（Polar 形态）；CooSpo HW9 每拍 1 个 RR、约 1 包/秒，会被误判。已改为按**心拍覆盖率**判定（实测 HW9 静息 5m17s：401 RR / ≈414 拍 = 96.9%，100% ∈[400,1500]ms，粗伪影 0%）。

---

## 7. 交付物（执行会话结束时）

1. 上述目录与 5 个文件齐全；`summary.md` 必须**逐条回答 Q1–Q10**，每条附证据（计数/百分比/hex 片段/截图路径）。
2. 一段"给 Lead 的 20 行摘要"：Gate 结论、RR 比例与质量、私有通道有无、并发/重连问题、建议（自用/退货/换 H10）。
3. 失败也要交付：哪一步卡住、错误信息、截图——同样有价值。

---

## 8. 安全与伦理

- 心率是敏感健康数据：本地保存、默认不分享原始 RR；报告里只用聚合统计。
- 不作为医疗用途，不宣称精度；不做"心率=同意/兴奋"的推断。
- 电极/光学面保持清洁；皮肤不适立即停止；测试期间不叠加电刺激（首次测试尤其）。
- 不要刷固件、不要反复配对解绑；一次只改一个变量。

---

## 附录 A：`0x2A37` 解码参考

```
byte0 Flags（小端之外的位定义）：
  bit0 HR 值格式：0=uint8，1=uint16
  bit1 接触状态：0=未检测到接触，1=检测到
  bit2 接触能力：0=不支持，1=支持
  bit3 Energy Expended 存在：0/1
  bit4 RR-Interval 存在：0/1（≥1 个）
  bit5-7 RFU

之后按顺序：
  HR 值（1 或 2 字节，小端）
  [bit3=1] Energy Expended uint16 小端（kJ）
  [bit4=1] RR × N，每个 uint16 小端，rrMs = raw × 1000 / 1024
```

示例：`16 4A 0F 03 0F 03`
- flags `0x16`=`0b00010110`：bit1=1（接触）、bit2=1（支持）、bit4=1（有 RR）、bit0=0（uint8）
- HR = `0x4A` = 74 bpm
- RR = `0x030F`=783 → 764.6ms，`0x030F` → 764.6ms

注意：单包 RR 数量受 ATT_MTU 限制（uint8 无 EE 最多 9 个；有 EE 最多 8 个；装不下会顺延到下一包，缓冲区满可能丢最旧）——**不要假设每包都完整**。

## 附录 B：浏览器 HRS 抓包 harness（复制保存为 `harness.html`）

```html
<!doctype html>
<meta charset="utf-8">
<title>HW9 HRS capture</title>
<style>
 body{font:14px/1.5 system-ui;margin:20px;max-width:1100px}
 textarea{width:100%;height:320px;font:12px/1.4 ui-monospace,monospace}
 input{width:100%;margin:4px 0;padding:6px;font:13px ui-monospace,monospace}
 button{padding:8px 14px;margin:4px 6px 4px 0}
</style>
<h3>心率带抓包（HRS / 原始模式）</h3>
<label>服务 UUID（默认 heart_rate；原始模式填厂商 UUID）<input id="svc" value="heart_rate"></label>
<label>特征 UUID（默认 heart_rate_measurement）<input id="chr" value="heart_rate_measurement"></label>
<label>额外 optionalServices（逗号分隔，原始模式必填）<input id="opt" value="battery_service,device_information"></label>
<label>原始模式（不解析，只记 hex）<input type="checkbox" id="raw" style="width:auto"></label>
<div>
 <button id="connect">连接</button>
 <button id="stop" disabled>停止</button>
 <button id="download" disabled>下载 JSONL</button>
</div>
<div id="status"></div>
<textarea id="log" readonly></textarea>
<script>
let device, ch, lines = [], t0 = performance.now();
const $ = id => document.getElementById(id);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
function iso() { return new Date().toISOString(); }
function rec(service, chr, view) {
  const raw = hex(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  const row = { t: iso(), monoMs: Math.round(performance.now() - t0), tool: 'harness',
                service, char: chr, hex: raw, decoded: null, note: '' };
  if (!rawMode() && chr === 'heart_rate_measurement') {
    const f = view.getUint8(0); let o = 1; const u16 = f & 1;
    const hr = u16 ? view.getUint16(o, true) : view.getUint8(o); o += u16 ? 2 : 1;
    if (f & 8) o += 2;
    const rr = [];
    if (f & 16) while (o + 1 < view.byteLength) { rr.push(+(view.getUint16(o, true) * 1000 / 1024).toFixed(1)); o += 2; }
    row.decoded = { flags: f, hr, contactStatus: !!(f & 2), contactSupported: !!(f & 4), rrMs: rr };
  }
  lines.push(JSON.stringify(row));
  $('log').value = lines.slice(-300).join('\n');
  $('log').scrollTop = $('log').scrollHeight;
}
const rawMode = () => $('raw').checked;
async function connect() {
  const svc = $('svc').value.trim(), chr = $('chr').value.trim();
  const optional = $('opt').value.split(',').map(s => s.trim()).filter(Boolean);
  try {
    $('status').textContent = '请求设备…';
    const opts = rawMode()
      ? { acceptAllDevices: true, optionalServices: [svc, ...optional].filter(Boolean) }
      : { filters: [{ services: [svc] }], optionalServices: optional };
    device = await navigator.bluetooth.requestDevice(opts);
    $('status').textContent = '连接 ' + (device.name || device.id) + ' …';
    const server = await device.gatt.connect();
    const s = await server.getPrimaryService(svc);
    ch = await s.getCharacteristic(chr);
    ch.addEventListener('characteristicvaluechanged', e => rec(svc, chr, e.target.value));
    await ch.startNotifications();
    $('status').textContent = '已订阅 ' + svc + ' / ' + chr;
    $('connect').disabled = true; $('stop').disabled = false; $('download').disabled = false;
    // 设备信息（尽力而为）
    try {
      const di = await server.getPrimaryService('device_information');
      const read = async (name, uuid) => {
        try { const c = await di.getCharacteristic(uuid); const v = await c.readValue();
          const s2 = new TextDecoder().decode(v); lines.push(JSON.stringify({ t: iso(), tool: 'harness', info: name, value: s2 }));
        } catch (_) {}
      };
      await read('manufacturer', 'manufacturer_name_string');
      await read('model', 'model_number_string');
      await read('firmware', 'firmware_revision_string');
      await read('hardware', 'hardware_revision_string');
    } catch (_) {}
    $('log').value = lines.join('\n');
  } catch (err) {
    $('status').textContent = '失败：' + err;
    console.error(err);
  }
}
async function stop() {
  try { if (ch) await ch.stopNotifications(); } catch (_) {}
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (_) {}
  $('status').textContent = '已停止';
  $('connect').disabled = false; $('stop').disabled = true;
}
function download() {
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/jsonl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hw9-notifications-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
  a.click();
}
$('connect').onclick = connect; $('stop').onclick = stop; $('download').onclick = download;
</script>
```

使用：本地起 `python -m http.server 8080`，打开 `http://localhost:8080/harness.html`（Web Bluetooth 需要安全上下文，localhost 可直接用）。原始模式要先把 nRF Connect 里看到的服务/特征 UUID 填进去。

## 附录 C：常见坑

1. **官方 App 占连接**：手机上后台挂着 CooSpo App，PC 就连不上——先强制停止。
2. **Windows 已配对缓存**：系统里"已配对"会让 Web Bluetooth 看不到设备；先在设置里移除配对再试。
3. **`edge://bluetooth-internals`**：只能看/操作 WinRT 暴露的 GATT，不能发起任意广播扫描；枚举以 nRF Connect 为准。
4. **湿电极**：ECG 胸带电极干时可能先报接触不良或噪声；本机是光学臂带，注意贴合与臂毛/肤色影响。
5. **同型号不同固件**：RR 支持可能随固件/批次变化，务必记录固件版本。
6. **不要只存解析值**：HRS 的 bit 位和包长随厂商实现有差异，原始 hex 才能复核。
7. **一次只连一个中心**：抓包时不要同时开官方 App 或第二台手机。

## 附录 D：给执行会话的开场提示（可复制）

> 你在工作区 `E:\Harness\DSH\Agent-based-multi-device-control`。请按 `analysis/coospo-hw9-test-plan.md` 执行 CooSpo HW9 的 BLE 测试：
> 1) 先读文档 §0–§3，确认工具（nRF Connect 优先；Windows 用 edge://bluetooth-internals；需要时用附录 B 的 harness.html）。
> 2) 所有产物写到 `analysis/hw9-capture/<时间戳>/`（新建目录），严格按 §5 的格式；原始 hex 必须保留。
> 3) 逐条回答 §0 的 Q1–Q10，按 §6 给 Gate 结论；按 §7 交付。
> 4) 不修改产品代码、不安装多余依赖；健康数据只存本地、脱敏序列号/MAC；不刷固件。
> 5) 结束时给 Lead 发 20 行以内摘要（Gate 结论 + RR 比例 + 私有通道有无 + 并发/重连问题 + 建议）。
