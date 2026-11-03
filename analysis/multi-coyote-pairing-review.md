# 多台同型号郊狼「设备名 + 稳定配对」未提交改动 — 对抗复核

- 复核基线：`HEAD=96acfb7` + 工作区未提交改动（v18 多郊狼配对 + 另一并行会话的在途改动）。
- 复核时间：2026-11-04 03:35–03:42。**复核过程中工作区被实现方并行更新过**（`apps/desktop/src/main/bootstrap.ts` 03:34:49 把 `connectDevice` 包进 `runDeviceOp`，`ble/bridge.ts` 03:34:11 改文案）；本报告以 03:41 的文件状态和行号为准。
- 范围：任务指定的 core/host/UI/测试/证据 + `analysis/multi-coyote-pairing.md`、`前端界面设计.md §8.2/§22`。**未复核**同工作区里属于另一并行会话的 `play.ts`、`agent/tools.ts`、`scenario/*`、`README.md`、`content-pack-kit/*`、`M2-实施计划.md` 等。
- 方法：逐文件读代码 + `git diff`/`git show HEAD:` 对照 + 用真实 `bootstrap.ts`（`node --experimental-transform-types`，临时数据目录，不写仓库）跑 3 个独立复现脚本 + 全量门禁独立复跑；未重跑长 CDP（只读 `.ui-shots/t23-multi-coyote/` 的 report 与 3 张截图）。
- 约束：本会话唯一写入是本文件；未改源码/测试/文档，未 commit。

## 0. 结论（TL;DR）

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| **P0** | **0** | pin/缺失/被占用都只会"拒绝连接"，未发现错连或同一台双驱动的活链路；同时 connect 已串行化，未发现可绕过的双驱动路径 |
| **P1** | **2** | ① 重复点「连接」会把卡片 lifecycle 打成 failed，而旧链路仍在、正在跑的 envelope 继续发散（控制台显示"未连接"但输出在跑）；② 其他卡已持久化的 `bleId` 不参与 chooser 保留集，重启/重配后未绑定卡可抢占已配对卡的盒子，之后被配对卡被 `pinned-already-connected` 永久拒绝（需二次重配） |
| **P2** | 12 | 见 §3：清除 label 后仍显示旧名、pin 失败文案误导 + `totalCandidates` 滞后、manifest 容错回归、`connectedDeviceIds` 在非 gatt 断开路径不释放、Electron 桥状态机零测试、ankni/失败路径测试缺口、旧 IPC 连接入口绕过 pin/串行化、`重新配对` 对 buttplug/monsterparty 无意义、rebind close 失败语义、`platformDeviceId` 不复位、文档一致性、重命名弹窗 a11y |

**可交付判断：可交付（无 P0）。** 建议在交付前处理 P1-1（默认操作可触发、控制台安全状态失真），P1-2 至少写进已知限制（或按 §2 的建议做保留集，改动很小）。P2 可排期。
**独立门禁全绿**（03:36–03:41 复跑）：core `52 files / 764 tests`、desktop `19 files / 274 tests`、两包 `tsc --noEmit` 0、`node --check` 8 个 UI/renderer JS 全过、`corepack pnpm --filter @embodied/desktop build` 与 `build:dev` 均 exit 0；与 `analysis/multi-coyote-pairing.md §3` 声称的数字一致，未发现夸大（真机未测它的确是写明的）。

---

## 1. P0：无

逐条核对"会不会连错/双驱动"：

- 有 pin：`chooseCandidate` 只返回 pin 本身（`chooser.ts:57-61`），且 pin 已连接/未出现都返回 `none`（取消请求），不会替换。
- 无 pin：只在"未被本进程其他卡连接"的候选里挑（`chooser.ts:64`）。
- 并发：`connectDevice` 现在整个包在 `runDeviceOp` 串行链里（`bootstrap.ts:1454-1472`），两张卡同时点连接不会同时进 chooser；Electron 桥"单 pending 选择"被覆盖的既有隐患也被这层串行化挡住。
- pin 只有正向约束，最坏情况是把两台卡都指向同一台（见 P1-2），但运行期 `pinned-already-connected` 会拒绝第二个，不会同时驱动同一台。
- 未发现可通过 filter/渲染层绕过（`renderer/ble.js` 的 `matchFor` 忽略 `deviceId`，pin 只在主进程 chooser 生效，`ble.js:53-61/123`）。

---

## 2. P1（建议交付前处理）

### P1-1 重复「连接」→ lifecycle 变 failed，但旧链路仍在、envelope 继续发（控制台显示"未连接"）

- 位置：`packages/core/src/devices/registry.ts:379-403`（`connect` 无 ready/connecting 幂等守卫，catch 无条件 `lifecycle='failed'`）；`packages/core/src/backends/coyote/backend.ts:194-227`（`connect` 先重置通道状态再 `transport.request`，request 抛错时不会碰旧 `peripheral`/`ticker`）；触发点在 UI：`apps/desktop/src/ui/app.js:790-800`（"连接"按钮在响应返回前仍可点，`call()` 无 busy/禁用）。
- 机理：第二次 `connect` 走到 Electron chooser 时，因为第一次已成功并持久化 `bleId`，filter 带 pin，而该 pin 正在被本卡占用 → `pinned-already-connected` 取消 → `backend.connect` 抛错 → `registry.connect` catch 把 lifecycle 记为 `failed`；但第一次的 GATT 链路、ticker、registry runner 都没被关闭/取消。
- 证据（独立复现，用真实 `createHostRuntime` + 一个在 `filter.deviceId` 上抛错的 `MockBleTransport` 模拟主进程 pin 拒绝）：

```
AFTER 1st: [["coyote","ready"]]
2nd connect error: SafetyError NOT_CONNECTED: pinned-already-connected
AFTER 2nd: [["coyote","failed"]]
（同时运行 runPattern 40%）
lifecycle: failed | effect still running: {"preset":"steady",...,"remainingMs":60000} | percent: 20
frames on old link: 2 -> 5
```

- 影响：这是"连接不顺利时用户会反复点连接"的多郊狼场景：卡片显示"未连接"、直控与模型命令都被 `NOT_CONNECTED` 拒绝，但实际链路仍在、已启动的 envelope 会继续跑到时长结束；此后每次点连接都因 pin 命中自己而失败，只能靠「重新配对」恢复。安全上不增加输出路径（panic 仍可达），但控制台对"是否在输出"的展示是错的。
- 建议：`DeviceRegistry.connect` 在 `lifecycle==='ready'` 时直接返回或抛 `ALREADY_CONNECTED`（不改 lifecycle），`connecting` 时拒绝并发；UI 在请求在途时禁用"连接"；`connectDevice` 失败时若 backend 仍持有活动链路，不要把 lifecycle 归为 failed（或把 backend 侧 `streaming` 作为兜底）。
- 备注：根因（connect 不幂等）在 HEAD 已存在；本次 pin 拒绝使失败路径从"偶发"变成"重复点必现"，因此应随本特性一起修。

### P1-2 其他卡已持久化的 `bleId` 不是 chooser 的保留集 → 重启/重配后未绑定卡可抢走已配对卡的盒子

- 位置：`apps/desktop/src/main/ble/chooser.ts:64`（未绑定分支只过滤 `connectedIds`，即"当前活链路"）；`apps/desktop/src/main/ble/electron-bridge.ts:89-91`（占位集合只在 connect 成功后写入，重启后为空）；`apps/desktop/src/main/bootstrap.ts:1454-1472`（`connectDevice` 只把自己的 `platformDeviceId` 写入 manifest，从不检查该 id 是否已属于另一张卡）。
- 场景（真实且无需异常）：重启应用（`connectedDeviceIds` 为空）→ 已配对卡 A（`bleId=unit1`）尚未连接 → 用户先连一张"未绑定"卡（新加卡，或刚点过「重新配对」的卡 B）→ B 的 chooser 只跳过"活链路"（此刻没有），按广告顺序选了 unit1 → B 也持久化 `bleId=unit1` → 之后 A 连接时 pin 命中 unit1 但被 B 占用 → `pinned-already-connected` 拒绝。用户视角是"两台郊狼又串了，A 连不上"。这不双驱动（安全），但正是本特性要解决的问题的变体，且「重新配对」这条恢复路径本身可能触发它。
- 证据（独立复现，真实 host：先连 coyote 再断开，再连 xhtkj；Mock 传输对两次连接给出同一 platformId）：

```
BLE IDS: [["coyote","unit-shared"],["xhtkj","unit-shared"]]
BOUND:   [["coyote",true],["xhtkj",true]]
```

- 建议（小改动）：把"其他 manifest 卡已占用的 `bleId`"作为保留集传给 chooser。最顺的接法是 `BleFilter` 增加 `excludeDeviceIds?: readonly string[]`（或 transport/bridge 增加一个 `reservedDeviceIds` 设置），host 在 `connectDevice` 前按 `manifest` 里除本卡外的 `bleId` 填入；`chooseCandidate` 未绑定分支过滤"connected ∪ excluded"（纯函数可直接加测试）。另外在 `connectDevice` 持久化前做一次"该 id 是否已属于其他卡"的兜底检查，冲突时拒绝持久化并给出明确错误（避免静默写重复 pin）。
- 至少：写进 `analysis/multi-coyote-pairing.md §4 残余`，并说明"重配/新增卡后先连它可能抢走已配对卡，需要按顺序连接或再次重配"。

---

## 3. P2（建议修复或至少记录）

### P2-1 清除 label 后仍显示旧名（重启前持久化过 label 的卡）；`§22` 验收"空名恢复后端默认名"不成立
- 位置：`apps/desktop/src/main/bootstrap.ts:1205`（启动时把 `entry.label` 烧进 backend 的 `name`）、`:1329`（`listDevices().label = entry.label ?? live?.name`）、`:1479-1490`（`decoratedSnapshot` 只在 manifest 有 label 时覆盖，没有 label 就回退到 backend 名字）。
- 证据（真实 host 复现；先以 `label:"左"` 启动，再清空 label）：

```
BOOT     manager: [["coyote","左"],...]
CLEARED  manager: [["coyote","左"],...]   ← 期望 "DG-LAB Coyote 3.0"
CLEARED  snapshot: [["coyote","左"],...]
```

- 影响：显示层，重启后自愈；但违反 `前端界面设计.md §22`（第 799 行）"空名恢复后端默认名"的验收项，且清空后旧名会让"左/右"语义残留。
- 建议：host 建 backend 时记录 `defaultName`（`Map<key,string>`），`decoratedSnapshot`/`listDevices` 回退到 `defaultName`；或清空 label 时重建 backend（代价是要处理在连链路，不推荐）。
- 测试：现有 `dashboard.spec.ts:192-240` 用"启动后才设置的 label 再清空"验证，正好绕开该路径（backend 名字是默认名），属假绿。

### P2-2 pin 失败文案与真实原因不符；`totalCandidates` 统计滞后一次选择
- 位置：`apps/desktop/src/main/ble/bridge.ts:214`（在 `request()` 之前读 `lastSelectionSize`，Electron 路径的候选数在 request 内部才产生 → 第一次失败时读到 0）、`:236-246`（`totalCandidates===0` 时输出 "no Bluetooth devices were found at all"；`pinnedHint` 一律提示"power that unit on, or press 重新配对"，即使用户的真实情况是"这台正被另一张卡连接"`pinned-already-connected`）。
- 影响：多郊狼排障时用户按提示去开机/换位置，但真实原因是占用/重启顺序（P1-2）或刚好 3s 内没扫到。trace 里虽有 `answered:none (pinned-already-connected, N candidates)`，但主文案是错的。
- 备注：顺序问题在 HEAD 就存在（已核对 `git show HEAD:` 同位置），不是本次引入；但 pin 让这条失败路径成为常见路径，建议顺手修。
- 建议：把 chooser 的 `reason` 作为 bridge 字段（如 `lastSelectionReason`）暴露，文案按 `pinned-not-found` / `pinned-already-connected` / `none-available` 分别给；候选数在 `request()` settle 之后再累加。

### P2-3 `isManifestEntry` 容错回归：可选字段为 `null` 会把整张设备卡丢掉，且注释与行为相反；接受空串 `bleId`
- 位置：`apps/desktop/src/main/bootstrap.ts:356-367`。注释写"corrupted value must not turn a whole device card into 'no such device'"，但实现 `return false` 会被 `:1119/:1122` 的 `.filter` 直接丢卡。
- 证据（真实 host，`devices.json` 手工含 `label:null` 与 `bleId:""`）：

```
LOADED: [["xhtkj",...,false],["ankni",...,true]]   ← coyote(label:null) 整张卡消失；ankni 的 bound=true 但 pin 是空串
```

- 影响：HEAD 的校验只查 key/protocol，`label:null` 的卡会保留；现在静默丢卡，且下一次 `saveManifest` 会把丢卡持久化。空串 `bleId` 会让 `bound=true` 的卡永远 `pinned-not-found`（直到重新配对）。手工/第三方工具改 manifest 才会触发，属"低成本硬化"。
- 建议：非法可选字段按"忽略该字段"处理（返回 true，字段不采用），不要丢卡；`label/bleName/bleId` 同时要求非空字符串。

### P2-4 `connectedDeviceIds` 只在 gatt 断开事件释放；写失败触发的 link-lost / worker 异常路径会留下过期占位
- 位置：`apps/desktop/src/main/ble/electron-bridge.ts:133-144`（只加）、`:246-251`（只在 `ble:disconnected` 删）、`:195-202`（只有"chooser 事件没来时 reload"这一条路径整体清空）；`registry.handleLinkLost`（`registry.ts:300-313`）不会通知 bridge；`electron-bridge` 也没有 renderer crash 处理。
- 影响：coyote 的写失败达到阈值时 registry 把 lifecycle 记为 failed，但 Chromium 可能还没发 gatt 断开 → 该平台 id 仍被认为"被占用"；用户点连接会得到 `pinned-already-connected`（且文案误导，见 P2-2），只能重新配对。方向是安全侧（误拒而非误连），但会让"卡住"难自愈。
- 建议：backend `handleLinkLost`/`close` 时通过 transport/bridge 显式释放 handle（需要一个 `releaseHandle(handle)` 或让 `disconnect(handle)` 幂等地删集合），或定期与 `transport.peripherals` 对齐；worker `render-process-gone`/`did-start-navigation` 时清空两个集合。

### P2-5 Electron 桥状态机零测试（本次最关键的"不可测"部分）
- 位置：`apps/desktop/src/main/ble/electron-bridge.ts:89-91/133-144/175-203/246-251`。`connectedDeviceIds` 的写入时机、释放时机、reload 清空、`handleDeviceIds` 映射，全部没有被测；`ble-chooser.spec.ts` 只测纯函数（9 条，见 `apps/desktop/tests/ble-chooser.spec.ts:16-64`），`ble-bridge.spec.ts:158-170` 只测了 FakeBridge 的 pin/platformId 透传。真正决定"是否双驱动"的是桥里的集合状态，这一块没有任何断言。
- 证据：`ble-bridge.spec.ts` 的 `FakeBridge` 根本没有 `connectedDeviceIds` 概念；断连释放/复用预期无集成测试。
- 建议：把"选择 + 占位集合 + 释放"抽成不依赖 Electron 的纯类（如 `ChooserBookkeeping`），对它做 connect/disconnect/reload 序列测试；或至少导出 `ElectronBleBridge` 的最小可测接口。

### P2-6 其它测试缺口（现有测试没有假绿，但覆盖偏窄）
- `packages/core/src/backends/ankni/backend.ts:89-101` 也加了 pin/platformDeviceId，但 `packages/core/tests/ankni-backend.spec.ts` 没有对应断言（coyote/xhtkj 有：`coyote-backend.spec.ts:167-192`、`xhtkj-backend.spec.ts:105-118`）。
- 没有测试"connect 失败不写 `bleId`"（`bootstrap.ts:1454-1472` 的失败分支）；也没有"`platformDeviceId===undefined` 时 `bound` 保持 false"（buttplug/mock/monsterparty 路径）。
- 没有测试 `registry.disconnect` 幂等（`lifecycle==='disconnected'` 再次调用）、close 抛错时的 lifecycle/审计、未知 device 的 `UNKNOWN_DEVICE`（`registry.spec.ts:499-520` 只测 happy path）。
- `dashboard.spec.ts:192-240`：`expect(...label).not.toBe('左')` 是弱断言；未测 `label:null`、未知 key 400、40 字符边界（恰好 40 应通过）、空白折叠；`bound` 只测了 rebind 后的 false，没测配对后的 true。
- `ble-chooser.spec.ts` 缺：pin 候选名字不匹配时仍应选 pin（pin 优先于名字）、所有候选都被占用时 `none-available`、pin 已连接但不在候选列表时 reason 的优先级（`pinned-not-found` vs `pinned-already-connected`）。
- 建议：以上都是几行测试；P2-1/P1-2 的回归测试也能顺便补上。

### P2-7 `host:connect` IPC 绕过 `connectDevice`（旧入口）
- 位置：`apps/desktop/src/main/index.ts:125-128` 的 `ipcMain.handle('host:connect')` 直接 `runtime.registry.connect`；`preload.ts` 仍把它暴露为 `window.host.connect`（当前主窗口加载 dashboard URL，UI 走 HTTP，所以是"旧/备用"路径）。
- 风险：任何以后复用该 IPC 的界面会得到"连接成功但不持久化 `bleId`、也不走 `runDeviceOp` 串行化"的行为，和新特性静默不一致。
- 建议：改成 `runtime.connectDevice(deviceId)`，或删掉这条 IPC 面。

### P2-8 「重新配对」对 buttplug/monsterparty 也显示
- 位置：`apps/desktop/src/ui/app.js:821-825` 只排除了 `protocol !== 'mock'`。UI 注释（`:68-71`）说用 `protocol` 判断"是否适用重新配对"，但对 buttplug/monsterparty 这个动作没有意义（它们没有平台 id，`bleId` 永远为空），点了只会断开 socket 链路。
- 建议：`listDevices()`/`DeviceManagerEntry` 增加 `canRebind: bound || protocol==='coyote'|'xhtkj'|'ankni'`（或后端能力位），UI 用它控制按钮。

### P2-9 rebind 的 close 失败语义：仍清 `bleId`、lifecycle 强制 disconnected
- 位置：`packages/core/src/devices/registry.ts:414-432`（`finally { lifecycle='disconnected' }`，close 抛错时异常向上、`device_disconnected` 审计不会写）；`apps/desktop/src/main/bootstrap.ts:1421-1443`（catch 只 `recordError`，随后照样清 `bleId` 并保存）。
- 影响：极少数 close 失败（worker 已销毁等）时，pin 被清而链路可能还在，下一次连接走未绑定 chooser，可能选中别的卡已配对的盒子（与 P1-2 同类），且审计里没有"断开失败"记录。
- 建议：close 失败时把 lifecycle 记为 `failed` 并写 `result:'error'` 审计；`rebindDevice` 在断开失败时不要清 `bleId`（或清之前显式提示）。

### P2-10 `platformDeviceId` 从不清空（防御性问题）
- 位置：`packages/core/src/backends/{coyote,xhtkj,ankni}/backend.ts` 里 `platformDeviceId` 只在 connect 成功赋值，teardown/close/connect 起点都不复位。真实 Electron 路径一定带 platformId 所以会被覆盖；但若某次连接的成功路径没拿到 platformId（旧 renderer/异常），`connectDevice` 会把**上一次**的 id 当成本次结果持久化（`bootstrap.ts:1457-1466`）。
- 建议：connect 起点和 teardown 里置 `undefined`；`connectDevice` 只在本次 connect 后仍为 defined 时持久化（配合"本次是否有值"标志更稳）。

### P2-11 文档一致性
- `analysis/multi-coyote-pairing.md:18`："manifest 里早有 label/bleName 字段，但 UI 与连接流程都没有使用它们" —— 与事实不符：HEAD 的 host 已用 `entry.bleName` 作为扫描过滤、`entry.label` 作为 backend 名字（`git show HEAD:apps/desktop/src/main/bootstrap.ts` 1157-1158/1184-1185/1196-1197/1204/1278）。实际缺的是 UI 编辑、展示层覆盖、平台 id 持久化。建议改这句，避免根因描述失真。
- 证据说明：`analysis/multi-coyote-pairing.md §3` 的 UI CDP 是 **stub 宿主**（`.ui-shots/t23-multi-coyote.mjs` 顶部注释、stub `/api/devices/rebind` 只把 `bound=false`，不改 lifecycle/langitude），不是真实 host/真机；`report.json` 的 `afterRebind` 里"郊狼 A"仍是"已连接"，说明它只证明"UI 线路 + DOM/路由命中"，不证明"重新配对会停输出/回未连接"。文档应明说"stub 宿主"，否则容易被读成端到端验证。
- `前端界面设计.md §22`（773-800）：与实现基本一致；第 799 行验收"空名恢复后端默认名"当前不成立（P2-1），第 24 行"卡 1/卡 2 绑定不同 id"在正常顺序下成立、在重启/重配顺序下可被 P1-2 破坏——建议在 §22 或残余里补一句已知限制。
- 正面：`analysis/…md §3` 的 764/274/tsc/构建数字经独立复跑一致，未夸大；§4 已写明"真机未回归"。

### P2-12 重命名弹窗细节（低）
- `apps/desktop/src/ui/index.html:298-311` 的弹窗有 `role/aria-modal/aria-labelledby`，但没有像"添加设备"弹窗那样的 Tab 焦点陷阱（`app.js` 的 `dialogFocusables` 只用于 `devAddDialog`）；`submitRename`（`app.js:1035-1050`）清空输入 = 静默清除覆盖名，UI 没有提示（冒号里没写"留空恢复默认"）。建议补焦点陷阱与占位提示。
- 另：`apps/desktop/src/ui/style.css:1692-1697` 的 `.modal-box input[type="text"]` 是全局选择器，当前只有重命名弹窗命中（`.modal-box` 只有 `#devAddDialog`/`#devRenameDialog`），暂无回归，但以后新增弹窗文本输入会被意外改样式。

---

## 4. 逐项回答复核要点

| 要点 | 结论 |
| --- | --- |
| **a) 安全：连错/双驱动、占位集合生命周期、竞态、disconnect 副作用** | 未发现 P0；pin/缺失/占用三态都安全拒绝。占位集合的添加/释放逻辑正确但只覆盖"connect 成功"和"gatt 断开"两条路径（P2-4）；并发 connect 已被 `runDeviceOp` 串行化（`bootstrap.ts:1454`），但旧 IPC 入口未串行（P2-7）。新增生命周期/状态失真问题见 P1-1；抢占/重复 pin 见 P1-2；`registry.disconnect` 的 close 失败语义见 P2-9。 |
| **b) 持久化（写入时机/回滚/迁移/decoratedSnapshot）** | 正常路径正确：只在 connect 成功后写、失败不写、旧 `devices.json`（无 `bleId`）可加载、`MANIFEST_VERSION` 不需要 bump（`bootstrap.ts:334/1119-1122`）。`decoratedSnapshot` 只供 HTTP/IPC 展示面，prompt/审计读的是 `registry.snapshot()`/backend id（`play.ts:1135/1506/1583`、`registry.ts` 审计 detail），确认"不该影响"成立。缺陷：P2-1（清名后旧名残留）、P2-3（容错回归/空串）、P2-10（旧 platformId 可能被复用）。 |
| **c) chooser 纯函数边界与文案** | 纯函数本身正确、可测、边界处理合理（空候选/单候选/多候选被占用/插入序）；`pinned-already-connected` 的 reason 只进 trace，不进主文案（P2-2）；`totalCandidates` 在 Electron 路径滞后一次选择，导致"完全没扫到蓝牙"的误导（P2-2）。 |
| **d) 测试质量** | 未发现"假绿"式测试：bootstrap 测试读真实磁盘 manifest，dashboard 测试走真实 HTTP，chooser 纯函数断言具体返回值。但覆盖偏窄：Electron 桥状态机零测试（P2-5）、ankni 无 pin 测试、失败路径/幂等/边界缺测（P2-6）；dashboard 的 `.not.toBe('左')` 与"只在启动后改 label"的用例分别弱化了 P2-1 的检出。 |
| **e) 文档一致性** | §22 与实现基本一致；`analysis` 根因第 18 行不准确、CDP 证据是 stub 未写明、验收项 P2-1 不成立（P2-11）。未发现"真机已验证"的夸大（§4 已声明未测）。 |
| **f) 独立门禁** | 全部通过，见 §5；与文档数字一致。 |

---

## 5. 独立门禁复跑记录（2026-11-04 03:36–03:41）

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| core 全量 | `cd packages/core && node node_modules/vitest/vitest.mjs run` | **52 files / 764 tests passed**，0 failed |
| desktop 全量 | `cd apps/desktop && node node_modules/vitest/vitest.mjs run` | **19 files / 274 tests passed**，0 failed（含新 `ble-chooser.spec.ts`） |
| core tsc | `node ../../node_modules/typescript/bin/tsc --noEmit`（cwd=packages/core） | exit 0，无输出 |
| desktop tsc | `node ../../node_modules/typescript/bin/tsc --noEmit`（cwd=apps/desktop） | exit 0，无输出 |
| UI/renderer 语法 | `node --check` 对 `src/ui/{app,chart-math,play,settings,shell}.js`、`src/renderer/{ble,camera,renderer}.js` | 8/8 OK |
| build | `COREPACK_HOME=<repo>/.cache/corepack corepack pnpm --filter @embodied/desktop build` | exit 0（esbuild 5 个产物） |
| build:dev | 同上 `build:dev` | exit 0（`dist/dev-server.mjs`） |
| 证据 | 只读 `.ui-shots/t23-multi-coyote/report.json` + 3 张截图 | `pageErrors=[] / consoleErrors=[]`；01 初始（A 已配对+已连接、B 未连接）、02 重命名后 B 标题 `郊狼 B · 右`、03 rebind 后 A 的"已配对"消失（A 仍显示"已连接"，stub 未改 lifecycle）；与 `analysis §3` 的描述一致，但只覆盖 UI 线路，不覆盖真实断链 |

补充：core/desktop 测试目录中 `ble-chooser.spec.ts` 与新增的 coyote/xhtkj/registry/bootstrap/dashboard 用例均实际执行（见 desktop 19 files 计数）；没有用 `--` 过滤或跳过。

---

## 6. 已核实无问题（避免误伤）

- pin 链路完整：backend `bleDeviceId` getter → `BleFilter.deviceId`（coyote `backend.ts:197-208`、xhtkj `:184-196`、ankni `:89-101`）→ `BridgedBleTransport.request` 透传 → Electron 桥 `pending.filter` → `chooseCandidate`；`BlePeripheral.platformId` 从 `renderer/ble.js:123` 的 `device.id` 回到 backend `platformDeviceId`。
- `registry.disconnect`：停 runner、清 percent/waveform、priority close、保留注册、写 `device_disconnected` 审计；`registry.spec.ts:499-520` 覆盖 closeCount/审计/重连。
- `rebindDevice` 在 `runDeviceOp` 内先断链后清 `bleId`，正常路径不会留下旧 pin。
- `connectDevice` 只在 connect 成功后才写 manifest/审计；失败不会误写（失败分支无写操作）。
- `decoratedSnapshot` 不进入 prompt/审计（见 §4b）；label 在 UI 走 `textContent`（`app.js:771`），未见 XSS 面。
- 迁移/加载：旧 `devices.json` 无 `bleId` 可正常加载；`isManifestEntry` 对缺失可选字段放行。
- 重命名不重建 backend、不断线：`setDeviceLabel` 只改 manifest + 展示覆盖；截图 02 与 dashboard 测试均验证。
- UI 的 rename/rebind 路由鉴权：dashboard 统一 `x-control-token` 校验在路由分发前（`dashboard.ts:958`），新增路由没有绕过（均走 `/api/` 前缀）。

---

## 7. 残余风险（交付时建议向用户/后续会话说明）

1. **真机未回归**：本环境无 BLE 硬件。`BluetoothDevice.id`（Chromium 对地址的 origin 派生 id）在 Windows 上的跨重启稳定性、以及换适配器/设备改用随机可解析地址（RPA）后是否变化，未经验证；失效时表现为"找不到已绑定设备"，需「重新配对」。
2. **3s grace + Electron 路径只尝试 1 次**（`bridge.ts:203`）：已配对卡的目标盒子若在 3s 内没被扫到就会失败一次，用户需再点一次；文案见 P2-2 会更准，但重试窗口本身未改进。
3. **worker reload**：`contents.reload()`（`electron-bridge.ts:195-202`）会连带断掉其他卡的链路（渲染器重建），而未逐卡发 `ble:disconnected`；依赖各自写失败→link-lost 收敛，期间有短暂状态不一致（既有行为，本特性未恶化）。
4. **无跨进程互斥**：配对/占用集合只在单个 Electron 主进程内生效；同时跑 dev-server/第二个实例时两台进程仍可能驱动同一台（既有）。
5. **manifest 手工损坏**：`label:null` 会丢卡、`bleId:""` 会得到不可连接的绑定（P2-3），建议至少做一次说明/硬化。
6. **审计里出现 `platformId`**：`connectDevice` 把平台设备 id 写进 `settings_change` 审计 detail（`bootstrap.ts:1464`），是本地哈希标识，敏感度低，但属于新增的硬件标识落盘，按团队隐私口径确认。
7. **P1-1/P1-2 未修时**：重复点连接、重启后先连未绑定卡这两种常见操作会造成"卡连不上/状态显示未连接但仍在输出"的可恢复问题；建议至少把 P1-2 作为已知限制写进 `analysis/multi-coyote-pairing.md`。

## 8. 给 Lead 的交付建议

- 无 P0，**可交付**；门禁独立复跑全绿、与文档数字一致。
- 交付前建议：修 P1-1（registry.connect 幂等守卫 + UI busy 状态，成本低、安全展示价值高）；P1-2 如果不改代码，至少写进已知限制并在 §22 验收里注明；P2-5/P2-6 的测试补强可与 P1-2 的 `excludeDeviceIds` 一起做（chooser 纯函数加 2 条用例即可覆盖）。
- 文档侧最小改动：`analysis/multi-coyote-pairing.md:18` 的根因措辞、CDP 证据标注"stub 宿主"、§4 补 P1-2 与 P2-1 两点。

---

## 9. 复核后处置（Lead，2026-11-04 03:50）

| 复核项 | 处置 | 证据 |
|---|---|---|
| P1-1 重复连接 → lifecycle failed 但旧链路仍在 | `registry.connect` 幂等：`ready` 直接返回、`connecting` 拒绝且不改 lifecycle；UI 连接按钮在途置灰 + busy 集合；宿主 connect 串行化 | `registry.ts` connect；`registry.spec.ts` 新增“二次 connect no-op / 并发被拒” |
| P1-2 其他卡已持久化 `bleId` 未参与 chooser 保留集 | `BleFilter.excludeDeviceIds`：host 把其他卡 `bleId` 传给 3 个 BLE 后端 → chooser 未绑定分支过滤；pin 命中保留集 → `pinned-reserved`；`connectDevice` 持久化前查重，冲突时断开新链路并报错 | chooser.ts；coyote/xhtkj/ankni options；bootstrap `reservedDeviceIds`；测试：chooser 14 条、bootstrap “reserves units paired with other cards” |
| P2-1 清空 label 后旧名残留 | `DEFAULT_DEVICE_NAMES` + `decoratedSnapshot`/`listDevices` 回退协议默认名（不再用 boot 时 backend 名） | bootstrap “falls back to default names”；dashboard 测试 |
| P2-2 pin 失败文案 / 候选数滞后 | chooser 原因经 `lastSelectionReason` 进 transport 文案（already-connected / reserved / not-found 分别提示）；候选数在 request settle 后读取 | `ble-bridge.spec.ts` 新增文案+计数测试 |
| P2-3 `label:null` 丢卡、空串 bleId | `normalizeManifestEntry`：坏可选字段只忽略字段、不丢卡；空串视为缺失 | bootstrap “loads a hand-edited manifest” |
| P2-6 测试缺口 | 补 ankni pin/exclude、chooser 排除/pin 优先/全占用、registry 幂等、bridge 文案/计数、bootstrap 清名/容错/冲突 | 见上 |
| P2-7 `host:connect` IPC 绕过 | 改为 `runtime.connectDevice`（持久化+串行） | `main/index.ts` |
| P2-8 非 BLE 设备显示重新配对 | `DeviceManagerEntry.canRebind`（仅 coyote/xhtkj/ankni），UI 用它 | bootstrap listDevices；app.js |
| P2-9 rebind close 失败语义 | `registry.disconnect` close 失败 → lifecycle failed + `device_disconnected` error 审计；rebind 失败不清 `bleId` | registry.ts、bootstrap |
| P2-10 `platformDeviceId` 不复位 | 三个 BLE 后端 connect 起点置 `undefined` | backends |
| P2-11/P2-3 文档 | 根因措辞、CDP 标注 stub、残余与 §22 验收已更新 | analysis §1/§3/§4、前端界面设计 §22 |
| P2-12 重命名弹窗 a11y | 加 Tab 焦点陷阱、Enter 保存、placeholder 提示留空恢复默认名 | app.js、index.html |
| 未修（记录为残余） | Electron 桥状态机无单测（P2-5）；写失败 link-lost 可能留过期占位（P2-4，方向安全、可重配自愈）；worker reload 断所有链路；无跨进程互斥 | analysis §4 |

> 复核之后 Lead 又改了 core/host/UI/测试与文档；本文件 §1–§6 是复核时刻的结论，最终门禁与数字以
> Lead 提交前复跑为准。


---

## 10. 真机实测追加修复（Lead，2026-11-04 04:05）

复核时无法发现的一类问题在用户真机实测中暴露：首版用 **Web Bluetooth `BluetoothDevice.id`（origin
hash）** 作为 `bleId`/pin，但 Electron `select-bluetooth-device` 候选列表的 `deviceId` 是
**BLE 地址**（Chromium `bluetooth_device_chooser_controller.cc` 用 `device.GetAddress()`）。两者 id
空间不同，导致：

- 重连永远报 `found 2 device(s) but none matched; bound unit: <hash>`（审计 19:53/19:55/19:56 多次）；
- `connectedDeviceIds` 记的是 hash，排除逻辑对候选地址无效 → 可能两张卡连到同一台，随后 `link_lost`
  （审计 19:55:09、19:57:11）。

修复（仍属本特性范围）：`electron-bridge.answer()` 记录实际回调给 chooser 的 `deviceId`，连接成功后
以它作为 `platformId`；`bleId`/pin/`excludeDeviceIds`/`connectedDeviceIds` 全部统一到 chooser id
（地址）空间；miss 时 trace 输出候选 id；设备卡显示 `配对地址 · <address>` 便于和 Windows/Chrome
列表对照。升级后旧 hash pin 会失效一次，每张卡点「重新配对」再连接即可。

这一条说明复核的边界：静态复核只能证明"同一 id 空间内的逻辑正确"，**跨 id 空间的假设需要真机/真环境
验证**；后续同类"平台标识"改动应优先找机会在真机上确认一次。

---

## 11. 真机验收通过（2026-11-04 04:18，用户确认）

- 两台郊狼同时连接成功；审计 `device-paired` 两条不同平台地址：
  `coyote → CC:E3:81:07:09:3D`、`coyote-2 → D4:04:F3:8E:CC:A6`；
  `state/devices.json` 两个 `bleId` 均为此地址格式（非 hash）。
- 用户原话："真机验收完成，两台机器同时连接也可以了。"
- 因此 §10 的 id 空间修复与 §9 的 P1 修复均在真实硬件上确认；剩余项只有 §4 的已知限制
  （首次配对顺序、无选择弹窗、换适配器可能需重配）与 P2-4/P2-5 的边界情况。
