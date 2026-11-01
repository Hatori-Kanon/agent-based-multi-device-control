# HW9 抓包工具链（PC 侧）

> 位置：`analysis/hw9-capture/_tools/`。目标：**拿到 CooSpo HW9 就能跑**，产出严格符合
> `analysis/coospo-hw9-test-plan.md` §5 的数据目录，不碰产品代码、不装产品依赖。
>
> 先读 [`FINDINGS.md`](FINDINGS.md)：那里有本机实测结论（哪些路能走、哪些别浪费时间）。
> 所有产物写到 `analysis/hw9-capture/<YYYYMMDD-HHmmss>/`（用 `scaffold.ps1` 创建）。
> 健康数据只存本地；交付/分享前序列号与 MAC 必须脱敏（计划 §4）。

## 0. 这个目录里有什么

| 文件 | 作用 | 状态 |
|---|---|---|
| `harness.html` | 计划附录 B 的实现版：浏览器 Web Bluetooth 抓 `0x2A37`，自动下载 JSONL + meta | ✅ 可用（页面结构与脚本已自检；**未接真机验证**） |
| `serve.ps1` | 在仓库根起 `python -m http.server`，打印 harness URL | ✅ 实跑验证（HTTP 200 / 端口占用提示） |
| `scaffold.ps1` | 创建符合 §5 的测试目录骨架（meta/gatt/notifications/summary/README/exports） | ✅ 实跑验证（TEST 目录已清理） |
| `capture/hw9cap.py` | bleak 3.x 命令行：`scan` / `info` / `gatt` / `notify` / `reconnect` / `concurrency` / `decode` | ✅ 已按 **bleak 3.0.2** 适配；`scan` / `decode` / 错误路径已实跑；**GATT/notify/reconnect/concurrency 未接真机** |
| `capture/selftest_3x.py` | 离线 API 形状自检（不需要设备、不发起扫描/连接） | ✅ 实跑 46/46 通过 |
| `capture/requirements.txt` | 唯一第三方依赖 `bleak>=3.0,<4` | ✅ 已装 **bleak 3.0.2 + winrt-\* 3.2.1** |
| `capture/bootstrap.ps1` | 创建/复用 `_tools/.venv` 并安装 bleak 3.x（幂等，不重装/不降级） | ✅ Lead 已执行（2026-11-01）；可幂等复跑 |
| `FINDINGS.md` | 本机环境实测（Lead 写） | 只读，别改 |
| `ble-probe.ps1` / `ble-scan.ps1` / `ble-diag.ps1` | Lead 的探针（事件路线，已知 PowerShell 订阅 WinRT 事件不触发） | 只读，别改 |

本机事实（详见 `FINDINGS.md`）：PowerShell 5.1 订阅 WinRT 事件**不可用**；WMI/CIM 被沙箱拒；
WinRT 请求/响应式 GATT 可用；Python 3.10.11 + `python` 命令可用（**没有 `python3`**）；
**bleak 3.0.2 已装在 `_tools/.venv`**（Windows 后端 pywinrt，连带 winrt-\* 3.2.1）；
Chrome/Edge 已装；PyPI 网络可用。

## 1. 三条路线怎么选（计划 §2 + 本工具链的补充）

| 要回答的问题 | 推荐路线 | 用什么 |
|---|---|---|
| 全量服务/特征、私有通道（T1/T4/Q5） | **A：nRF Connect**（安卓/iOS，权威） | 手机 App，导出/截图放 `exports/`；PC 侧用 `hw9cap.py gatt` 自动补全 `gatt.json` |
| 标准 HRS 通知流、RR/接触位（T2/T3/T5/T6/T9/Q2–Q4） | **A'：hw9cap.py notify**（本工具链新增，**PC 首选**） | 自动落 `notifications.jsonl`，本机到达时间可达 ms；断连有事件记录 |
| 浏览器/Web Bluetooth 链路验证（路线 C，后续集成原型） | **C：harness.html** | `serve.ps1` 起本地服务，Chrome/Edge 点一次设备选择器 |
| Windows WinRT 能不能看到同样的服务（路线 B/Q1/Q10） | **B：`edge://bluetooth-internals`** | 浏览器内置页；只能看/操作，不能任意扫描 |
| 广播内容（T0/Q7） | `hw9cap.py scan` 或 nRF Connect 扫描页 | 广播 name/serviceUuids/manufacturerData → JSONL |
| 并发与重连（T8/Q8/Q9） | `hw9cap.py concurrency` / `reconnect` | 时间线 + 重连耗时 + 是否需重新选设备 |

决策建议：

1. **先跑 `hw9cap.py gatt` + `info`**：一次连接拿全 `gatt.json` 和 `meta.json` 素材（比手抄 nRF 快，且原始 hex 保留）。
2. **再跑 `hw9cap.py notify` 抓 `0x2A37` ≥10 分钟**（T2），这是判定 Gate A/B 的主证据。
3. **nRF Connect 只做交叉校验/截图**：全量枚举与私有通道的“权威截图”，不重复手抄。
4. `harness.html` 用于验证我们自己的 Web Bluetooth 解析链路（路线 C）；它拿不到未知服务，不要用它枚举 GATT。
5. `edge://bluetooth-internals` 只在排查“Windows 侧看不看得到”时开一次，避免和 nRF/bleak 抢连接。

> 三条路线**同一时刻只能有一条连着 HW9**（BLE 外设通常只接受一个中心设备）。换路线前先断开。

## 2. 准备：起 harness 服务器（路线 C）

在**仓库根**执行（`Ctrl+C` 停止；只绑定 `127.0.0.1`，不暴露到局域网）：

```powershell
cd E:\Harness\DSH\Agent-based-multi-device-control
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1
```

脚本会打印确切 URL，默认是：

```
http://localhost:8080/analysis/hw9-capture/_tools/harness.html
```

常用变体：

```powershell
# 端口被占用时换端口（地址里的端口也要一起改）
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1 -Port 8081

# 起完自动打开浏览器
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1 -Open

# 想用计划附录 B 原文的 http://localhost:8080/harness.html 形式（从 _tools 目录提供服务）
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\serve.ps1 -FromToolsDir
```

> **为什么不用 `python -m http.server` 手起？** 手起也可以，但必须 `cd` 到仓库根（或 `_tools`），
> 否则 URL 不对；`serve.ps1` 会自动找仓库根、检查 harness 存在、预检端口并打印正确地址。
> Web Bluetooth 要求安全上下文，`http://localhost` 满足；`file://` 打不开。

### harness.html 怎么用

1. 打开上面的 URL（Chrome 或 Edge）。
2. 标准 HRS：保持 `heart_rate` / `heart_rate_measurement`，点“连接心率带”，在弹窗里选 HW9。
3. 私有通道：勾“原始模式”，填 nRF Connect 看到的服务/特征 UUID，并把**服务 UUID 加进
   optionalServices**（逗号分隔）——Web Bluetooth 不允许访问未声明的服务。
4. 记录中每行是计划 §5 格式的 JSONL；停止或设备断连时**自动下载** `hw9-notifications-*.jsonl`
   与 `hw9-meta-*.json`（若浏览器拦截自动下载，点按钮手动下载）。
5. 断连处理：页面自动停止订阅、红色提示、保留已收数据并尝试自动下载。
6. 设备信息（尽力而为）：连上后读 `0x180A` 各字符串 + `0x180F/0x2A19` 电量；序列号记为“（脱敏）”。
   `device.id` 是浏览器按 origin 生成的标识，**不是 MAC**。

## 3. 准备：bleak 环境（已完成；bootstrap 幂等可复跑，**不重装/不降级**）

当前状态（2026-11-01，Lead 已执行）：`analysis/hw9-capture/_tools/.venv` =
**Python 3.10.11 + bleak 3.0.2 + winrt-runtime / winrt-windows-\* 3.2.1**（Windows 后端 pywinrt）。
`capture/requirements.txt` 锁定 `bleak>=3.0,<4`。

```powershell
# 幂等复跑（已装好时 pip 输出 "Requirement already satisfied"，不会重装 bleak 3.0.2，更不会降级）
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\capture\bootstrap.ps1

# 只有确实要重建 venv 时才加 -Force（删除并重建 .venv，然后仍从 requirements.txt 装 3.x）
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\capture\bootstrap.ps1 -Force
```

- 脚本只写 `_tools/.venv`，不碰产品依赖；**不执行 `pip install --upgrade pip`**，也不加 `--upgrade`，
  所以已装的 bleak/winrt-* 不会被改动。
- 之后所有 CLI 命令都用这个 venv 的 python：

```powershell
$HW9PY    = ".\analysis\hw9-capture\_tools\.venv\Scripts\python.exe"
$CAP      = ".\analysis\hw9-capture\_tools\capture\hw9cap.py"
$SELFTEST = ".\analysis\hw9-capture\_tools\capture\selftest_3x.py"
```

- 系统 Python（`python` 3.10.11）只用于 `py_compile` 语法检查；无 bleak 时运行 CLI 会给出清晰安装指引
  并退出码 2，不会崩栈。
- 装完（或改过 CLI 后）先跑离线自检，确认 bleak 3.x 的 API 形状假设仍成立：

```powershell
& $HW9PY $SELFTEST     # 期望：46 项通过，0 项失败；不连设备、不扫描
```

### 3.5 bleak 3.x API 适配（已按已装 3.0.2 的源码逐项核对）

| 用途 | bleak 3.0.2 的事实 | `hw9cap.py` 的用法 |
|---|---|---|
| 广播扫描 | `BleakScanner.discover(timeout, *, return_adv=True)` 返回 `dict[address] -> (BLEDevice, AdvertisementData)` | `_scan()` 取 `found.values()`，只接受 tuple 项 |
| 广播字段 | `AdvertisementData` 是 NamedTuple：`local_name` / `manufacturer_data` / `service_data` / `service_uuids` / `tx_power` / `rssi` / `platform_data` | 用这些字段生成 `scan` JSONL；RSSI 只从 adv 取（`BLEDevice` 没有 `rssi`） |
| 连接 | `BleakClient(address_or_ble_device, disconnected_callback=None, *, timeout=30, pair=False, winrt={}, ...)`；`connect(**kwargs)` 不再返回 bool | `_client_factory()` 直接传 `timeout=`；优先传扫描得到的 **BLEDevice**，无广播时才按地址字符串直连 |
| 服务发现 | `client.services` 属性；**`get_services()` 在 3.x 已移除**；WinRT 后端在 `connect()` 内完成发现（`GattDeviceService.get_gatt_services_async`） | 只用 `client.services`（`connect()` 之后）；拿不到时给可操作报错 |
| 特征 | `.uuid`(str) / `.handle`(int) / `.properties`(list[str]，SIG 名如 `read`/`write-without-response`/`notify`/`indicate`) / `.descriptors` / 内建 `.description` | `gatt` 输出 `properties` 排序列表；`notify` 按 UUID 自己匹配特征后传对象给 `start_notify` |
| 描述符/CCCD | WinRT 后端在服务发现时逐特征 `get_descriptors_async()`，`ch.descriptors` 可用；描述符有 `.uuid`/`.handle` | `cccd = "2902" in descriptors`；用户描述用 `read_gatt_descriptor(desc.handle)` 读 `0x2901` |
| 通知 | `start_notify(char_or_uuid, callback)`，回调签名 `(BleakGATTCharacteristic, bytearray)`；`stop_notify(char_or_uuid)`；断连回调 `(BleakClient)` | 同步回调直接写 JSONL；断连回调置 flag，主循环 0.2s 内感知并停 |
| MTU | `client.mtu_size`（Windows = `GattSession.max_pdu_size`） | `gatt.json` 顶层附加 `mtu`；`notify` 连接事件的 detail 里记录 |
| Windows 参数 | `pair=` 构造参数（WinRT 在 connect 前调 `pair()`）；`winrt={"use_cached_services": bool, "address_type": "public"/"random"}`；默认 `use_cached_services=None` 由系统决定 | **本工具不用 `pair`**（HW9 不需要配对，且配对会干扰 Web Bluetooth）；缓存/地址类型保持系统默认，排查时见 README 说明 |
| 异常 | `BleakDeviceNotFoundError`（地址不可达/不在广播）、`BleakCharacteristicNotFoundError`（特征不存在）、`BleakBluetoothNotAvailableError`（蓝牙不可用） | 映射为退出码 `3` / `3` / `5`，均给中文提示、默认不打印 traceback |

Windows 后端参数补充（3.0.2 语义；本项目默认都不用）：

- `pair=True`：WinRT 在 `connect()` 前调用 `pair()`（可能弹系统配对对话框）。本项目**不用**：
  HW9 不需要配对，且 Windows 已配对反而可能让 Web Bluetooth 看不到设备（计划附录 C-2）。
- `winrt={"use_cached_services": True/False}`：True = 用 Windows 缓存的 GATT 数据库（快，但可能过期）；
  False = 强制从设备读取；**不传时由系统决定**（本工具默认不传）。
- `winrt={"address_type": "public"/"random"}`：仅设备使用 random 地址时需要；本工具默认不传。
- `services=[...]` 构造参数可限制服务发现范围（更快）；本工具**不用**（T1 要全量枚举）。
- `connect(**kwargs)` 在 3.x 只透传后端参数，**不再返回 bool**；以返回成功 + `client.is_connected` 判断。

已删除的 0.2x 兼容分支（3.x 不需要）：`discover(return_adv=)` 的 `TypeError` 回退、
`BleakClient(timeout=)` 的 `TypeError` 回退、`BLEDevice.rssi` 回退。

## 4. 创建测试目录

```powershell
cd E:\Harness\DSH\Agent-based-multi-device-control
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\scaffold.ps1 -DeviceName "CooSpo HW9" -Tester "你的名字"
```

输出**新建目录的绝对路径**，例如 `analysis\hw9-capture\20261101-180000\`，内含：

```
<YYYYMMDD-HHmmss>/
├── meta.json            # 设备/环境/测试者（mac/serial 预填“脱敏”）
├── gatt.json            # 空壳 {"services":[],"advertisement":{...}}，待填
├── notifications.jsonl  # 空文件，由 notify/harness 写入
├── summary.md           # Q1–Q10 + Gate 表骨架
├── README.md            # 复现步骤与本轮异常模板
└── exports/             # nRF Connect 导出的 CSV/截图
```

- 不覆盖已有目录：重名自动追加 `-2`、`-3`…
- 加 `-Suffix smoke` 生成 `...-smoke` 目录（测试/演练用）。
- `-Notes "..."` 会写进 `meta.json.notes`。

## 5. 路线 A'：`hw9cap.py` 命令（PC 首选自动化）

所有命令都在**仓库根**执行；日志走 stderr，数据走 stdout 或 `--out` 文件。
`<MAC>` 用 `scan` 或 nRF Connect 找到，例如 `AA:BB:CC:DD:EE:FF`。`<TS>` = 测试目录时间戳。

```powershell
$HW9PY    = ".\analysis\hw9-capture\_tools\.venv\Scripts\python.exe"
$CAP      = ".\analysis\hw9-capture\_tools\capture\hw9cap.py"
$SELFTEST = ".\analysis\hw9-capture\_tools\capture\selftest_3x.py"
$TS    = "20261101-180000"   # 换成 scaffold.ps1 实际生成的目录名
```

```powershell
# 0) 看帮助（不需要 bleak）
& $HW9PY $CAP --help

# 1) 广播扫描（T0）：name/services/manufacturerData → JSONL
& $HW9PY $CAP scan --seconds 15 --out "analysis\hw9-capture\_tools\.local\scan.jsonl"

# 2) 设备信息（T0）：0x180A 各字符串 + 0x180F 电量 → meta.json 片段
& $HW9PY $CAP info --address <MAC> --out "analysis\hw9-capture\$TS\meta-fragment.json"

# 3) 全量 GATT（T1）：→ 计划 §5 的 gatt.json
& $HW9PY $CAP gatt --address <MAC> --out "analysis\hw9-capture\$TS\gatt.json"

# 4) 标准 HRS 通知流（T2/T5/T6/T9）：→ notifications.jsonl + 同名 .events.jsonl
& $HW9PY $CAP notify --address <MAC> --service heart_rate --char heart_rate_measurement `
    --seconds 600 --out "analysis\hw9-capture\$TS\notifications.jsonl"

# 4b) 一直抓到 Ctrl+C / 断连（--seconds 0 或负数）
& $HW9PY $CAP notify --address <MAC> --seconds 0 --out "analysis\hw9-capture\$TS\notifications.jsonl"

# 4c) 私有通道原始 hex（T4）：其它特征只记 hex，不解析
& $HW9PY $CAP notify --address <MAC> --service <VENDOR-SVC-UUID> --char <VENDOR-CHAR-UUID> `
    --seconds 120 --note t4-vendor --out "analysis\hw9-capture\$TS\vendor-notify.jsonl"

# 5) 断连重连（T8/Q9）：记录每次耗时、扫描是否仍能看到、通知是否恢复
& $HW9PY $CAP reconnect --address <MAC> --times 3 --delay 2

# 6) 并发观察骨架（T8/Q8）：主设备 HW9 + 另一台 BLE
& $HW9PY $CAP concurrency --address <MAC> --other AA:BB:CC:DD:EE:00 --seconds 60 `
    --other-char <OTHER-CHAR-UUID> --out "analysis\hw9-capture\$TS\concurrency.jsonl"

# 7) 离线自检 0x2A37 解码（不需要设备/bleak；应与计划 §5 示例一致）
& $HW9PY $CAP decode 164a0f030f03
# → flags 22, hr 74, rrMs [764.6, 764.6]

# 8) 离线验证 bleak 3.x API 形状（不连设备、不扫描；期望 46/46 通过）
& $HW9PY $SELFTEST

# 9) 错误路径自检（不可达地址；预期退出码 3、中文提示、无 traceback）
& $HW9PY $CAP gatt --address AA:BB:CC:00:00:00 --scan-seconds 3 --timeout 5
echo "exit=$LASTEXITCODE   # 3 = 设备未找到"
```

要点：

- `--address` / `--name` 必给其一（先 `scan`）；也给 `--name` 时按 RSSI 选最强的一台并提示。
  只给 `--address` 时，即使扫描窗口内没广播也会尝试按地址直连（Windows 缓存/已配对设备）。
- `notify` 的 `--service` / `--char` 接受**短 UUID**（`2a37`）、**0x 前缀**（`0x2A37`）、
  **完整 UUID** 或**蓝牙短名**（`heart_rate_measurement`）。脚本自己按 UUID 匹配特征，不依赖 bleak 的字符串解析。
- 退出码：`0` 成功；`1` 用法错误；`2` 缺 bleak；`3` 没找到设备/特征（含 bleak 的
  `BleakDeviceNotFoundError`：地址不在广播/设备关机/被占用；`gatt`/`info`/`notify` 实测返回 3）；
  `4` 抓包中途断连或重连有失败；`5` BLE/系统错误（含 `BleakBluetoothNotAvailableError`）。
  自动化据此判断。
- `notify` 的 `--scan-seconds`（默认 8）控制找设备时的扫描时长；`--seconds 0`（或负数）表示一直抓到
  Ctrl+C 或断连。
- `notify` 输出 `n` 条后 stderr 每 10s 报一次进度；数据文件每条立即 flush，崩溃/断连不丢已收数据。
- 断连时 `notify` 会提前停止并返回退出码 4，同时把 `disconnect` 事件写进 `<out>.events.jsonl`。

## 6. 路线 B：`edge://bluetooth-internals`（只看 WinRT 暴露面）

1. Edge/Chrome 打开 `edge://bluetooth-internals`（Chrome 为 `chrome://bluetooth-internals`）。
2. Start Scan → 找到 HW9 → Inspect。
3. 记录：设备 ID、广播信息、服务/特征列表、对 `0x2A37` Start Notifications 是否成功。
4. 截图放 `exports/`，结论写进 `summary.md` 的 Q1/Q10。
   注意：这个页面不能发起任意广播扫描，全量枚举仍以 nRF Connect / `hw9cap.py gatt` 为准。

## 7. 数据格式速查（计划 §5）

### `notifications.jsonl`（一行一条，本页/CLI 都遵守）

```jsonc
{"t":"2026-11-01T17:31:02.412+08:00","monoMs":123456,"tool":"bleak","service":"180d","char":"2a37","hex":"164a0f030f03","decoded":{"flags":22,"hr":74,"contactStatus":true,"contactSupported":true,"rrMs":[764.6,764.6]},"note":""}
```

约定：

- `hex` **小写**字节串，原始值永远保留；`decoded` 只是附加（计划 §4）。
- `service` / `char` 用**短 UUID**（`180d` / `2a37`）；非标准 128-bit UUID 用完整小写字符串。
- `t` = 本机本地时区 ISO8601（毫秒 + 偏移）；`monoMs` = 单调毫秒：
  - `hw9cap.py`：自**本次命令开始**（扫描/连接前起算）；
  - `harness.html`：自**页面加载**起算（`performance.now() - t0`，与计划附录 B 一致）。
- `tool`：`"bleak"`（CLI）/ `"harness"`（页面）/ 手抄时用 `"nrf"`、`"edge"`。
- `decoded` 仅对 `2a37` 自动生成（按计划附录 A：bit0 HR 宽度、bit1 接触、bit2 接触能力、
  bit3 Energy Expended、bit4 RR；`rrMs = raw × 1000 / 1024`，保留 1 位小数）。
  其它特征 `decoded` 为 `null`，只在 `hex` 里保留原始字节。
- `note`：异常/标记，例如 `trailing 2 byte(s)`、`truncated HR value` 或 `--note t2-rest` 固定标记。
- 连接/断连/启动订阅等**事件不进 notifications.jsonl**，写到同名 `<out>.events.jsonl`（自由格式，
  `event` 字段：`connect` / `notify-start` / `notify-stop` / `disconnect` / `error`）。

### `gatt.json`（`hw9cap.py gatt` 直接生成）

- `services[]`：`uuid`（完整小写）、`name`（标准服务名，未知为 `null`）、`standard`（是否标准）、
  `characteristics[]`：`uuid`、`name`、`properties`（`read`/`write`/`write-without-response`/`notify`/`indicate` 等）、
  `descriptors`（该特征枚举到的描述符短 UUID 列表；Windows 3.x 在服务发现时读取）、
  `cccd`（`descriptors` 里是否含 `2902`）、`userDescription`（有 0x2901 时读其值，否则 `null`）。
- 顶层 `mtu`（**附加字段**）：`client.mtu_size`（Windows = `GattSession.max_pdu_size`，读不到为 `null`）；
  0x2A37 单包 RR 个数受 ATT_MTU 限制（附录 A 注），做“每包 RR 个数”统计时用它佐证。
- `advertisement`：`name`、`services`（广播里的服务 UUID，完整小写）、`manufacturerData`（厂商数据 hex；
  多个公司 ID 时按 ID 升序**拼接**，公司 ID 本身用 `scan` 的 `manufacturerData` 映射看）。
- 未拿到广播时 `advertisement` 字段为空，不影响 GATT 枚举。
- 注意：`cccd` 依赖 Windows 返回描述符；若某设备/系统不返回 0x2902，`cccd` 可能为 false，
  需用 nRF Connect 交叉校验（计划 T1 本来要求 nRF 权威截图）。

### `meta.json`（`info` 输出片段；合并进测试目录）

```jsonc
{
  "device": {"name":"...","mac":"AA:BB:CC:**:**:**","model":"","firmware":"","hardware":"","serial":"（脱敏）"},
  "env": {"os":"...","chrome":"","adapter":"","tools":["hw9cap 0.1.0","bleak x.y.z"],"python":"3.10.11"},
  "tester":"","startedAt":"...","notes":"",
  "reads":[{"service":"180a","char":"2a29","name":"Manufacturer Name","hex":"...","value":"...","error":null}],
  "batteryPercent": 87
}
```

- `reads` / `batteryPercent` / `env.python` 是本工具链的**附加字段**，便于复核原始读取；不影响 §5 的
  `device` / `env` / `tester` / `startedAt` / `notes` 五个键。
- 序列号**无条件**记为“（脱敏）”（`--no-redact-mac` 也不放开，避免交付物泄漏）。

## 8. MAC/序列号脱敏与 `.local/`

- 默认 `--redact-mac`：保留前 3 字节（OUI，便于区分设备族），后 3 字节掩成 `**`；
  输出里的地址形如 `AA:BB:CC:**:**:**`。
- `--no-redact-mac`：保留真实地址，但输出**强制**落在 `analysis\hw9-capture\_tools\.local\` 下
  （未给 `--out` 时自动生成文件名；给了目录外的路径会被重定向并提示）。
- `.local/` 已被仓库根 `.gitignore` 的 `*.local` 规则覆盖（`git check-ignore` 验证过），
  且该目录不会提交；里面的原始文件仅供本机分析。
- 交付/分享只给脱敏后的 `notifications.jsonl` / `summary.md` / 截图；`meta.json` 里的序列号保持“（脱敏）”。

## 9. 常见坑（计划附录 C + 本机实测）

1. **官方 App 占连接**：手机后台挂着 CooSpo App，PC 就连不上——先强制停止/关蓝牙再试。
2. **Windows 已配对缓存**：系统里“已配对”会让 Web Bluetooth 看不到设备；先移除配对再试（附录 C-2）。
3. **PowerShell 抓通知不行**（`FINDINGS.md` §2）：PS 5.1 能注册 WinRT 事件但回调不触发；
   不要花时间修 `ble-probe.ps1`/`ble-scan.ps1`，抓流用 bleak 或 harness。
4. **WMI/CIM 被沙箱拒**：`Get-PnpDevice`、`Get-CimInstance` 都 `PermissionDenied`；
   所以 `scripts/gatt-dump.ps1` 那套不能原样跑，需按 WinRT/bleak 取地址。
5. **Web Bluetooth 要安全上下文**：`https://` 或 `http://localhost`；`file://` 不行；必须 Chrome/Edge。
6. **`requestDevice` 必须用户点一下**：不能自动化；每次重新连接大概率要再选一次设备（T8/Q9 记录这个）。
7. **同一时刻只能一个中心**：harness、nRF Connect、bleak、官方 App 不要同时连。
8. **控制台中文乱码**：Windows 默认代码页 936；需要时先 `chcp 65001` 再跑命令。
   文件本身全部 UTF-8（`.json` / `.jsonl` / `.md`；PowerShell 脚本带 BOM 以便 PS 5.1 正确解析中文）。
9. **`python` vs `python3`**：本机只有 `python`（3.10.11）。别在命令里写 `python3`。
10. **不要 `pip install` 到系统 Python**：用 `bootstrap.ps1` 的隔离 venv（已装好 bleak 3.0.2）。
11. **不要降级 bleak**：requirements 锁 `bleak>=3.0,<4`；3.x 移除了 `BleakClient.get_services()` 等
    0.2x API，降级会让 `hw9cap.py` 直接挂。`bootstrap.ps1` 不加 `--upgrade`，不会动已装版本。
12. **bleak 3.x 在 Windows 用 pywinrt**：pip 会装一长串 `winrt-*` 包（已装 3.2.1），属正常；
    `.venv/` 已被根 `.gitignore` 忽略，不要提交。
13. **不要刷固件、不要反复配对解绑**；一次只改一个变量（计划 §4/§8）。
14. **低电量/光学臂带**：注意贴合、臂毛/肤色影响；摘戴后要预热（T5）。

## 10. 已验证 / 未验证（截至 2026-11-01；无真实设备连接）

已验证（本机实跑；**不包含任何真实设备连接/采集**）：

- [x] 环境：`_tools/.venv` = Python 3.10.11 + **bleak 3.0.2** + winrt-\* 3.2.1；`requirements.txt` 为 `bleak>=3.0,<4`。
- [x] `python -m py_compile`（系统 python）与 venv python 均通过 `hw9cap.py` / `selftest_3x.py`。
- [x] **真实广播扫描**：`scan --seconds 8 --out ...` 成功（本次扫到 4 台），JSONL 字段完整
      （`t` / `monoMs` / `address`（脱敏）/ `name` / `rssi` / `serviceUuids` / `manufacturerData` / `serviceData` / `txPower`）。
- [x] `decode 164a0f030f03` 与计划 §5 示例完全一致（flags 22 / hr 74 / rr 764.6,764.6）。
- [x] `selftest_3x.py` **46/46 通过**：用已装 bleak 的真实 `AdvertisementData` + duck-typed GATT 对象，
      覆盖 scan 返回结构、adv 字段、`client.services` / `properties` / `descriptors` / `mtu_size`、
      `read_gatt_descriptor(handle)`、CCCD 判定、退出码映射（不需要设备）。
- [x] 错误路径：`gatt` / `info` / `notify` 对不可达地址均清晰报 `BleakDeviceNotFoundError`、
      退出码 **3**、无 traceback。
- [x] `hw9cap.py --help` 与所有子命令帮助已逐项核对，参数与代码一致（`scan` 不再显示未使用的
      `--address` / `--name`；`notify` 新增 `--scan-seconds`）。
- [x] `scaffold.ps1` 实跑生成测试目录：`meta.json`/`gatt.json` 为合法 JSON、`notifications.jsonl` 为 0 字节、
      `exports/` 存在、`summary.md`/`README.md` 按 §5 骨架生成（测试目录已删除）。
- [x] `serve.ps1` 实跑：仓库根模式与 `-FromToolsDir` 模式均 HTTP 200；端口占用提示 + 退出码 1。
- [x] `harness.html` 脚本 `node --check` 通过；HTML 标签配对；页面无外部资源。

未验证（**拿到设备后第一次跑就是验证**；Lead 计划在设备就绪后跑 T0/T1/T2）：

- [ ] 真实连接与 GATT 全量枚举：`info` / `gatt` 未连过真机（只测了不可达地址的错误路径）。
- [ ] `notify` 真实通知流：订阅回调、断连事件、`--seconds 0`（直到 Ctrl+C）的实际行为未实测。
- [ ] `reconnect` / `concurrency` 未接真机。
- [ ] 厂商 128-bit 特征订阅、`userDescription`(0x2901) 真实读取未实测（fake 对象已覆盖代码路径）。
- [ ] harness 在浏览器里选设备/收通知/自动下载未实测；自动下载可能被 Chrome“多文件下载”策略拦截，
      页面已提供手动按钮兜底。
- [ ] Windows 参数 `pair=` / `winrt={"use_cached_services": ...}` 未使用也未实测（本项目不需要配对付费）。

## 11. 假设与对计划的小偏差（如与计划冲突，以本文为准并请 Lead 确认）

1. **serve URL**：任务要求从仓库根起服务，所以默认 URL 含完整路径
   `/analysis/hw9-capture/_tools/harness.html`；计划附录 B 的 `/harness.html` 形式用 `-FromToolsDir` 兼容。
2. **设备信息不混进通知流**：计划附录 B 把 `device_information` 读取行 `push` 进同一个 `lines` 数组；
   本实现把通知 JSONL 保持严格 §5，设备信息单独下载 `hw9-meta-*.json`（避免 `notifications.jsonl` 出现异形行）。
3. **时间戳**：附录 B 用 `new Date().toISOString()`（UTC `Z`），与 §5 示例的 `+08:00` 不一致；
   本实现统一输出**本地时区带偏移**的 ISO8601。
4. **hex 大小写**：附录 B 大写、§5 示例小写；本工具链统一**小写**。
5. **`service` / `char` 形式**：`notifications.jsonl` 用短 UUID（§5 示例 `180d`/`2a37`），
   `gatt.json` 的 `uuid` 用完整 UUID（§5 示例），两处都照计划。
6. **`monoMs` 基准**：计划未定义；CLI = 命令开始，harness = 页面加载（见 §7）。
7. **`needsReselect`**：`reconnect` 里定义为“该次重连前扫描窗口内没看到广播”，
   对应交互式工具（Web Bluetooth）可能需要用户重新选设备；不是浏览器实测值。
8. **`--no-redact-mac` 的落盘限制**：真实 MAC 只允许写 `_tools/.local/`，这是实现层的硬约束。
9. **`concurrency` 的边界**：只测 OS/适配器层并发与时间线；**无法**复现 Web Bluetooth
   “单 pending `requestDevice`”这类浏览器层限制——那要在 harness/Electron 里另测（T8 第 2 步）。
10. **脚本编码**：`.ps1` 存为 UTF-8 **带 BOM**（PowerShell 5.1 正确解析中文所需）；数据文件无 BOM。
11. **bleak 3.x 适配**：本文档与 `hw9cap.py` 以已装 **bleak 3.0.2** 为准（API 清单见 §3.5），不保证 0.2x。
12. **`gatt.json` 附加字段**：顶层 `mtu`、characteristic 的 `descriptors` 是附加信息，不改变 §5 必需的
    `services` / `advertisement` 结构。
13. **退出码映射**：`BleakDeviceNotFoundError` / `BleakCharacteristicNotFoundError` → `3`；
    `BleakBluetoothNotAvailableError` → `5`；其它未预期异常 → `5`（加 `-v` 看 traceback）。

## 12. 给执行会话的 5 步

```powershell
cd E:\Harness\DSH\Agent-based-multi-device-control
# 1) 读计划 §0–§3 + _tools/FINDINGS.md；确认设备已戴好、手机上官方 App 已关。
# 2) 建目录：
powershell -NoProfile -ExecutionPolicy Bypass -File analysis\hw9-capture\_tools\scaffold.ps1 -DeviceName "CooSpo HW9"
# 3) bleak 环境已就绪（.venv + bleak 3.0.2）；先跑离线自检：
#    & $HW9PY $SELFTEST   （应 46/46 通过）
# 4) 先 gatt + info，再 notify ≥10 分钟；nRF Connect 交叉校验并截图到 exports/。
# 5) 填 summary.md（Q1–Q10 + Gate），按 §7 交付并给 Lead 发 20 行摘要。
```
