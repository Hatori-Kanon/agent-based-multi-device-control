# 多台同型号郊狼：设备名与稳定配对（2026-11-04）

> 用户报告：链接多台郊狼时出问题——蓝牙广告名相同，需要按设备名区分；后续补充：**连着一台时另一台
> 搜不到/连不上，Chrome 的 xtoys 能按设备地址区分两台**。
> 处理：设备卡可重命名；首次连接把 **chooser 的平台设备 id**（Electron `select-bluetooth-device`
> 的 `deviceId`，Windows 上即 BLE 地址）持久化到 manifest，之后重连钉在同一台；未绑定的卡在选设备时
> **跳过已被其他卡连接/保留的设备**；提供「重新配对」；设备卡显示配对地址。

## 1. 根因

- 郊狼 V3 的 BLE 广播名是固定家族名（`COYOTE_BLE_NAME`），两台同型号设备无法靠名字区分；
- 旧 chooser 逻辑（`apps/desktop/src/main/ble/electron-bridge.ts`）在 grace window 后按名字打分挑**第一个**
  匹配候选，完全没有"这台已被别的卡占用"的概念：
  - 第二张卡可能再次选中第一台已经被驱动的盒子 → 两条 `B0` 帧流写进同一台设备；审计里表现为
    `connect ok` 之后很快 `link_lost`（用户 2026-11-04 03:21–03:22 的真实日志：19:21:36 link_lost /
    19:21:51 connect coyote-2 / 19:22:02 connect coyote / 19:22:20 link_lost）；
  - 即使连到了不同设备，设备卡标题也完全相同（都叫 `DG-LAB Coyote 3.0`），操作者无法知道谁是谁；
  - 重启/重连后哪张卡连哪台盒子没有记忆，可能互换。
- manifest 里早有 `label`/`bleName` 字段：启动时 `label` 会作为 backend 名字、`bleName` 会作为扫描过滤，
  但**没有重命名 UI、没有展示层覆盖、也没有"哪张卡对应哪台盒子"的持久化**；而且重复点「连接」会再次扫描、
  失败后把仍在线的一台标记为 `failed`（旧 `registry.connect` 不幂等）。
- **关键 id 空间错误（v18 首版实测发现）**：首版把 Web Bluetooth 的 `BluetoothDevice.id`（worker 里的
  origin-scoped hash）当作持久化/pin 的 id；但 Electron `select-bluetooth-device` 候选列表里的
  `deviceId` 是**另一个 id 空间（Windows 上是 BLE 地址）**。结果：
  - 审计 `connect error ... (wanted: 47L121000; bound unit: SzsD/vOS4gB6Q2xHxeZp3A==); found 2 device(s)
    but none matched`：扫描明明找到两台，pin 却永远匹配不上（hash ≠ 地址）；
  - `connectedDeviceIds` 也记的是 hash，无法与候选地址比对 → 排除逻辑失效，两张卡可能连到同一台，
    随后一条链路 `link_lost`；用户体感就是"连着一台时另一台连不上/搜不到"。
  - 修复：**统一使用 chooser 的 `deviceId`（地址）** 作为持久化/pin/占用的唯一 id；worker 返回的
    `BluetoothDevice.id` 只作诊断，不参与身份。候选 miss 时把候选 id 写进 selection trace。

## 2. 设计

### 2.1 稳定配对（pin）

- `BleFilter` 新增可选 `deviceId`：把 chooser 钉到某一台平台设备；`BlePeripheral` 新增
  `platformId`（连接成功后由 **chooser 实际选中的 `deviceId`** 带回，不是 worker 的
  `BluetoothDevice.id`）。
- 核心后端（coyote / xhtkj / ankni）：
  - options 新增 `bleDeviceId?: () => string | undefined`（每次 connect 读取，重配立即生效）；
  - connect 时若已有绑定，把它放进 filter；连接成功后把 `peripheral.platformId` 记到
    `DeviceBackend.platformDeviceId`。
- 宿主：`DeviceManifestEntry` 新增 `bleId`；首次连接成功后把 backend 的 `platformDeviceId` 写回
  manifest（`state/devices.json`），并记一条 `settings_change(scope=device-paired)` 审计。
  写入前做一次兜底：该 id 若已属于另一张卡，拒绝持久化、断开新链路并报错（避免重复 pin）。
- `registry.connect` 幂等守卫：`ready` 时直接返回（重复点「连接」不再重扫/不把在线设备打成 `failed`），
  `connecting` 时拒绝并发；宿主把整个 connect 包进 `runDeviceOp` 串行链（chooser 只有一个 pending 槽）。

### 2.2 不再重复驱动同一台

- Electron chooser 政策抽成纯函数 `apps/desktop/src/main/ble/chooser.ts`：
  - filter 带 pin：只接受该 id；没出现 → 取消（不会顺手抓另一台）；已被别的卡连接/保留 → 取消；
  - 没有 pin：在"未被其他卡连接 **且未被其他卡持久化**"的候选里按名字打分挑第一台；只剩一台时沿用旧的
    "单候选即使名字为空也接受" 行为；
  - 每张卡成功连接后把平台 id 记入占位集合，worker 报 disconnect 时释放；
  - host 通过 `BleFilter.excludeDeviceIds` 把其他卡 manifest 里已持久化的 `bleId` 传给 chooser，
    所以重启后（还没有活链路）未绑定卡也不会抢走已配对卡的盒子。
- 行为变化：如果两台都在广播且都没有绑定，第二张卡的 chooser 不会再抢第一张卡已占用的盒子。

### 2.3 设备名（label）与重新配对

- 设备卡新增「重命名」：`POST /api/devices/label {key,label}`；空串/`null` 清除。
  名字只存在 manifest，登记在 registry snapshot 的展示层（`decoratedSnapshot`），
  重命名不会重建 backend（不断线），也不会影响提示词/审计里已有的设备名。
  校验：trim + 折叠空白，≤40 字符。清空后回退到**协议默认名**（`DEFAULT_DEVICE_NAMES`），
  不会残留启动时烧进 backend 的旧 label。
- manifest 加载改为 `normalizeManifestEntry`：`label/bleName/bleId` 为 `null` 或空串时只忽略该字段，
  不会丢整张设备卡（丢卡还会在下一次保存时被持久化成"移除"）。
- 设备卡新增「重新配对」（仅 BLE 协议显示，`canRebind`）：`POST /api/devices/rebind {key}` →
  `registry.disconnect`（新增 API：停输出、关链路、lifecycle 回 disconnected，但**保留注册**与
  策略/部位状态）→ 清除 `bleId`；之后点「连接」重新扫描、重新绑定。若 close 失败，
  lifecycle 记 `failed` 且**不清 `bleId`**（链路可能还在，不能换绑）。
- 卡片头部显示 `已配对` 标记；`GET /api/devices` 的每条记录新增 `bound` / `canRebind` / `pairedId`；
  设备卡在有配对时显示一行 `配对地址 · D4:04:F3:8E:CC:A6`（即 chooser 的 `deviceId`），
  方便和 Windows/Chrome 的设备列表对照。

### 2.4 已连接的稳定身份

- 设备页标题来自 registry snapshot（后端构造时用 label）；现在 `snapshot` 由宿主按 manifest
  label 覆盖名字，因此重命名即时生效；`listDevices()` 也返回同一 label。
- 卡片「已配对」只表示有 `bleId`，不是 BLE 链路状态（链路状态仍由 lifecycle 显示）。

## 3. 验证

- 单元测试：
  - `packages/core`：coyote/xhtkj/ankni 后端把 `bleDeviceId` 放进 filter、把其他卡的 `bleId` 作为
    `excludeDeviceIds`、连接后暴露 `platformDeviceId`；`registry.disconnect` 停输出/关链路/保持注册/可重连；
    `registry.connect` 幂等（ready 二次连不重扫、connecting 并发被拒且不改 lifecycle）。
  - `apps/desktop`：`ble-chooser.spec.ts` 14 条（pin 命中/缺失/已连接/被保留、跳过已连接与被保留、
    单候选兜底、pin 优先于名字、全被占用、名字打分）；`ble-bridge.spec.ts` 验证 `platformId` 透传、
    pin 透传、chooser miss 文案（already-connected）与候选数在 scan 之后读取；`bootstrap.spec.ts` 验证
    首次连接记录 `bleId` 到 `state/devices.json`、重连 filter 带 pin、其他卡 `bleId` 进入
    `excludeDeviceIds`、重复绑同一台被拒、清空 label 回默认名、`label:null`/`bleId:""` 不丢卡；
    `dashboard.spec.ts` 验证 label/rebind 路由、40 字符上限、快照名字覆盖。
- 全量门禁（工作区含另一并行会话的在途改动）：core **52 files / 767 tests**、
  desktop **19 files / 282 tests**、两包 `tsc 0`、Electron/dev-server 构建通过。
- UI CDP（`.ui-shots/t23-multi-coyote/`）：真实 `index.html + app.js` + **stub 宿主**（不是真实 host/真机），
  两台同型号郊狼卡；重命名第二张卡 → 标题变 `郊狼 B · 右`（POST label 命中）；第一张卡点「重新配对」→
  应用内确认 → `已配对` 标记消失（POST rebind 命中）；0 page/console error。截图
  `01-device-view-initial.png` / `02-device-view-renamed.png` / `03-device-view-rebound.png`。
  它只证明 UI 线路与请求命中，**不证明** rebind 真的断链/停输出——那部分由 core 单测 +
  `registry.disconnect` 覆盖。
- **真机验收（2026-11-04 04:07，用户确认通过）**：两台郊狼同时连接成功，各自绑定不同地址：
  `coyote → CC:E3:81:07:09:3D`、`coyote-2 → D4:04:F3:8E:CC:A6`（与 Chrome/xtoys 列表中的两个地址一致）。
  审计 `settings_change(scope=device-paired)` 两条不同 `platformId`；`state/devices.json` 里两个 `bleId`
  不同。用户反馈："真机验收完成，两台机器同时连接也可以了。"

## 4. 残余 / 注意

1. **真机验收已通过（2026-11-04，两台同时连接）**：配对/重连/地址区分均在真机确认。仍需注意
   `bleId` 是 OS 的 BLE 地址（Windows 上通常稳定）；换 USB 蓝牙适配器、设备改用随机可解析地址或
   删除系统配对后，旧 pin 可能报"找不到已绑定设备"，用「重新配对」恢复即可。
2. **首次配对无选择弹窗**：两台都未绑定时，先连接的卡拿"未被占用且未被其他卡保留"里的第一台
   （按广告顺序），操作者用重命名把卡片标成实际那台；连错顺序可用「重新配对」换。要做"从列表挑选"
   需要新的 chooser 交互（后续可加）。**已绑定卡的盒子不会再被未绑定卡抢走**（host 把其他卡
   `bleId` 作为 `excludeDeviceIds` 传给 chooser）。
3. 若一台盒子关掉后重连，pin 找不到时**不会**去连另一台（防止身份漂移），错误信息里带
   `bound unit: <id>`、chooser miss 原因与候选 trace。
4. 同型号但不同协议（例如郊狼 + 安可尼）本来就按服务/名字过滤，不受影响。
5. **Electron 桥状态机没有单测**：`connectedDeviceIds`/`handleDeviceIds` 在 `electron-bridge.ts` 里，
   依赖 Electron 环境；纯政策有 14 条测试，桥的集合生命周期只有代码审查 + 真机验证。
6. **写失败 link-lost 可能留下过期占位**：coyote 连续写失败会把 lifecycle 记 `failed`，但 Chromium 可能
   还没发 gatt 断开，桥的 `connectedDeviceIds` 会继续认为该设备被占用；方向是"误拒"（安全），
   用「重新配对」可自愈（它会 close 链路并释放占位）。
7. **worker reload**（chooser 事件始终没来）会断掉所有 BLE 链路且不逐卡发 disconnected，依赖各自写失败
   收敛；这是既有行为。
8. **没有跨进程互斥**：配对/占用集合只在单个 Electron 主进程内；同时跑 dev-server 或第二个实例时
   两台进程仍可能驱动同一台（既有）。
9. **CDP 证据是 stub 宿主**：`.ui-shots/t23-multi-coyote/` 只验证 UI 线路/DOM/请求命中，不是端到端；
   真实断链/停输出由 core 测试与真机回归覆盖。
10. **重命名弹窗**有焦点陷阱与 Enter 保存；空名=清除（placeholder 已提示"留空恢复默认名"）。

## 5. v18 第二版修复：统一用 chooser 的 id（地址）

首版上线后用户实测：连着一台时另一台连不上；Chrome/xtoys 的配对窗可以按地址区分两台
（`47L121000 (D4:04:F3:8E:CC:A6)` / `47L121000 (CC:E3:81:07:09:3D)`）。审计证据：

```
connect error NOT_CONNECTED: ... (wanted: 47L121000; bound unit: SzsD/vOS4gB6Q2xHxeZp3A==);
found 2 device(s) but none matched; ...
```

- 扫描确实找到 2 台；但持久化的 `bound unit` 是 base64 hash（Web Bluetooth `BluetoothDevice.id`），
  与 chooser 候选列表里的 `deviceId`（Windows 上是 MAC 地址）不在同一 id 空间 → pin 永远不匹配；
  同时 `connectedDeviceIds` 也记 hash，无法排除已连接设备 → 两张卡可能连到同一台，随后 `link_lost`。
- 修法：
  1. `electron-bridge` 在 `answer()` 时记录**实际回调给 chooser 的 deviceId**，连接成功后把它作为
     `platformId` 返回给 transport（worker 的 `device.id` 只留在 diagnostic）；
  2. 持久化 `bleId`、pin、`excludeDeviceIds`、`connectedDeviceIds` 全部改用该 chooser id；
  3. chooser miss 的 selection trace 里输出候选 id 列表，便于以后对不上时一眼定位；
  4. 设备卡显示 `配对地址 · <id>`，与 Windows/Chrome 的设备列表可直接对照。
- 升级注意：首版写下的 `bleId` 是 hash，升级后旧 pin 会匹配不上（会提示"找不到已绑定设备"）；
  每张卡点一次「重新配对」再「连接」即可得到地址格式的新绑定。

> Chromium 源码依据（`content/browser/bluetooth/bluetooth_device_chooser_controller.cc` 的
> `AddFilteredDevice`）：chooser 侧用 `device.GetAddress()` 作为 `device_id` 传给
> `BluetoothChooser::AddOrUpdateDevice`，而 Web Bluetooth 暴露给页面的 `BluetoothDevice.id` 是
> 对地址做 origin hash 后的结果——这正是"chooser 地址 ≠ JS hash"、pin 永远不匹配的原因；
> 用 chooser 地址做持久化/pin 才是跨会话稳定的。
