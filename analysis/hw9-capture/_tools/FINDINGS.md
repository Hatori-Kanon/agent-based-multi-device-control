# 抓包工具链前置调研（2026-11-01，Lead 实测）

> 目的：给执行 HW9 测试的成员一份"哪些路能走、哪些别浪费时间"的事实清单。
> 依据：在本机（Windows 11，普通用户 `HatoriKanon`，DSH 沙箱 workspace-write）实跑。

## 1. 已验证可行

| 能力 | 状态 | 证据 |
|---|---|---|
| PowerShell 5.1 WinRT 投影（`Windows.Devices.Bluetooth.*`） | **可用** | `_tools/ble-probe.ps1` |
| `BluetoothLEDevice` / `DeviceInformation.FindAllAsync` | **可用** | 查到 1 台已配对（ZKRXB）+ 5 台缓存设备 |
| 蓝牙射频 | **On**，`Radio.RequestAccessAsync = Allowed` | `_tools/ble-diag.ps1` |
| 请求/响应式 GATT（枚举服务、读特征） | **可用**（经 `Await` 包装 `IAsyncOperation<T>`） | `scripts/gatt-dump.ps1` 历史用法；本次未连设备复验 |
| Python 3.10 / 3.12、`pip`、`venv`、PyPI 网络 | 可用 | `pip 23.0.1`；`https://pypi.org/simple/bleak/` → 200 |
| Node v24.18.0、Chrome、Edge | 已安装 | — |

## 2. 已验证不可行（别再试）

1. **PowerShell 订阅 WinRT 事件不可用**：`add_Received($scriptblockDelegate)` 能注册、返回 token，但回调从不触发（Ble watcher 12s 零事件，`Status` 停在 `Created`）。
   → 结论：**不要试图用 PowerShell 抓 `0x2A37` 通知流**，也不要用它做广播扫描。
   请求/响应（`GetGattServicesAsync` / `ReadValueAsync`）不受影响。
2. **WMI/CIM 被拒**：`Get-PnpDevice`、`Get-CimInstance`、`Get-NetAdapter` 均 `PermissionDenied (0x80041003)`。
   → 因此 `scripts/gatt-dump.ps1`、`scripts/gatt-write.ps1` **不能原样运行**（第一步就挂）。需要按 WinRT `DeviceInformation` 取地址，再 `FromBluetoothAddressAsync`。
3. `[Windows.Devices.Enumeration.DeviceInformation]::GetAqsFilterFromDeviceClass('Bluetooth')` 无效（`DeviceClass` 枚举没有 `Bluetooth`）。

## 3. 设备缓存快照（2026-11-01 17:30 前后，扫到 ≠ 现在在线）

```
PAIRED   ANKNI ZKRXB   (BluetoothLE#…-10:11:dd:05:b6:99)
UNPAIRED <no-name>     (…-66:c6:d2:a2:e0:14)
UNPAIRED LOCK_b413     (…-e6:38:e9:a8:b4:13)
UNPAIRED <no-name>     (…-71:a3:9b:60:60:5e)
UNPAIRED <no-name>     (…-f3:b0:2d:33:ee:c5)
UNPAIRED <no-name>     (…-50:5d:fb:bd:d8:ed)
```

**没有 CooSpo/HW9**。缓存只反映"Windows 最近见过"，不能证明设备现在不在旁边（可能被手机连着、或刚开机还没被扫到）。

## 4. bleak 路线已落地（2026-11-01 17:45 实测）

- 依赖已装：`analysis/hw9-capture/_tools/.venv`（python 3.10.11）+ **bleak 3.0.2**（Windows 后端 = pywinrt，自动带 `winrt-runtime`/`winrt-windows-*` 3.2.1）。
- **实时广播扫描可用**：`bleak-verify.py` 8s 扫到 5 台（含 RSSI/服务 UUID/厂商数据），证明沙箱允许 Chromium 之外的 BLE 扫描。
- `hw9cap.py scan` 实跑通过（`--redact-mac` 默认开，落 JSONL）；`decode 164a0f030f03` 与计划 §5 示例逐字段一致。
- `hw9cap.py gatt` 对不可达地址给出清晰报错（`BleakDeviceNotFoundError`，退出码 1，无 traceback）——错误路径 OK，正向路径待真机。
- 当前扫描窗口内**没有 CooSpo/HW9**（用户确认设备在手，等待开机/佩戴）。最近扫到：L3250 打印机、LOCK_b413、两个 0x038F/0x004C 厂商包设备。

> 结论：**PC 侧全自动抓包路线成立**。设备一开机，`scan` 就能发现它，随后 `info`/`gatt`/`notify` 一条龙。

## 5. 路线判断

- **抓原始通知流（T2/T3/T5/T6/T9）**：PowerShell 做不到。可用的两条：
  - **A. Python + bleak（推荐，若允许装依赖）**：扫描/全量 GATT/notify/重连/并发全自动，本机到站时间可达 ms，直接落 §5 的 `notifications.jsonl`。依赖隔离在 `_tools/.venv`，不动产品依赖。
  - **B. 浏览器 harness（计划附录 B）**：需要人手点一次设备选择器；之后页面自动记录并可下载 JSONL。用于验证我们自己的 Web Bluetooth 链路（计划路线 C）。
- **全量 GATT 枚举（T1）**：WinRT 请求/响应即可（不需要事件），或 bleak。手机 nRF Connect 仅作"权威截图"交叉校验，非必需。
- **广播信息（T0）**：WinRT 广播扫描不可用（事件）；用 bleak 的 `BleakScanner` 或手机 nRF Connect 补。Windows 侧只能给"缓存里有没有 0x180D"。

## 5. 采集纪律（来自计划 §4，硬约束）

- 原始 hex 必须落盘，解析值只作附加字段。
- 每条记录带本机到达时间（ms）+ 工具名；HRS 无设备时间戳。
- 健康数据只存本地；序列号/MAC 在交付物里脱敏；不提交到 git。
- 一次只改一个变量。
