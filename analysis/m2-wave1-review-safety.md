# M2 波次一安全/集成审查（HEAD eff3966）

- 审查对象：`eff3966 feat(m2): wave 1 ...`（39 files，`git show --stat HEAD`）。
- 只读审查：未改源码/测试/文档，未跑 git 写命令；基线 `core 406/406`、`desktop 87/87` 全绿（HEAD，23:32）。
- 说明：工作树另有并发未提交的波次二文件（sensors/execution 等），不在本审查范围；以下行号均以 `git show HEAD:<path>` 核对。
- 验证方式：HEAD 核心树复制到 `/tmp` 做变异测试；用一次性探针验证未连接 stop 与 async listener。

## 阻塞

### B-1 D4 边界：`effective()` 只接了郊狼 `BF`，发射路径仍是 `get()`

- **证据**：`packages/core/src/devices/policy.ts:196-206` 的注释声称“The emit path and the Coyote `BF` sync read this instead of `get()`”；实际 `packages/core/src/devices/registry.ts:653`（`snapshot()`）、`:761`（`write()` 最后夹紧）、`:785`（`prepare()` 准入）全部用 `policy.get()`；生产代码只有 `apps/desktop/src/main/bootstrap.ts:320-321` 用 `effective()`（测试里另有少量直接调用）。`setSessionCeilingByHuman` 没有 registry 钩子（HEAD 仅测试调用），降低 X 不会重写已连接郊狼的 BF，也不会夹紧运行中的 effect。
- **影响**：一旦 X 经公共 API/后续 UI 设为小于通道 cap：Buttplug/谜姬/Anki/MonsterParty 按通道 cap 输出，会话上限完全不生效；郊狼的 BF 只在连接和通道 cap 变化时重写，单独降低 X 不会重写 BF（`write()` 也不按 effective 夹紧），`state.percent`、审计和事件仍记录超过 X 的百分比；`RegistrySnapshot.maxPercent` 暴露通道 cap，违反 M2-实施计划 §4.7.3 规则 2。当前 HEAD 没有生产 X 写入口，所以不是现网可利用的放宽；但注释已把该保证写成既成事实，B2-T9 一接线即成为绕过点。
- **建议**：把 `prepare()`/`write()`/`runPattern` 的夹紧及 `snapshot()` 切到 `effective()`，并给 registry 增加“人类设置 X”入口（重写 BF、`invalidate()`、把当前 percent 夹到新上限）；若本波次只承诺 A1-T10 落盘，则在 §8.7 明确记录 B2-T9 偏差并删除“emit path”声明。补集成测试：cap=40、X=25 时 `setLevel(30)` 应被拒或夹紧；连接郊狼时 BF 字节应为 `percentToStrength(25)`。

### B-2 D4 边界：`restore()` 是第三个 public 写入口，D4 测试只枚举 `set*`

- **证据**：`packages/core/src/devices/policy.ts:225-239` 的 `restore()` 是 public，接受任意 `PolicySnapshot`（只校验绝对上限），可直接把 cap 从 20 提到 100、ceiling 提到 100，且不写审计；`apps/desktop/src/main/bootstrap.ts:240` 只负责从文件恢复。`packages/core/tests/policy.spec.ts:42-52` 用 `/^set/` 过滤原型方法，`restore` 不在断言内；测试名“exposes no way for a non-human caller to raise a cap”因此是空心保证。
- **影响**：任何 import `PolicyStore` 的引擎/内容包代码（同一进程）都能调用 `restore` 绕过两个 human setter；计划 §4.7.3 确实把 `restore` 列为 public，但 brief 的“唯一两个写入口”不成立，且未来误用不会被现有测试拦住。
- **建议**：把 `PolicySnapshot` 做成 branded 类型（仅 `parsePolicySnapshot` 能产生）或把 restore 移到 bootstrap-only 函数，并限制为启动期一次；至少把 D4 测试改成枚举所有 public mutator（含 `restore`），断言只有两个 human setter 与唯一的启动恢复入口，并补“restore 不能在启动后 raise”的用例。

## 应修

### S-1 异步 listener 的 rejection 不会被隔离（实测逃逸）

- **证据**：`registry.ts:155` 的 listener 类型是 `(event) => void`，TS 允许 async 函数赋给它；`:739-753` 只用 try/catch 包住同步调用，未处理返回的 Promise。`apps/desktop` 与 core 都没有 `unhandledRejection` 处理器。HEAD 源码探针：async listener 抛错后 `onError` 调用数为 0，`unhandledRejection` 为 1。
- **影响**：A2-T3 的 probe 很可能写成 async（要 `audit.record`）；一次失败会成为 unhandled rejection，Node 默认 `--unhandled-rejections=throw` 时主进程可能退出，BLE 流/看门狗停止，状态型硬件保持最后强度——与“listener 不能中断派发链”的承诺相反。
- **建议**：把类型改为 `(event) => void | Promise<void>`，对返回值 `Promise.resolve(...).catch(...)`，复用 `onError` 的嵌套 try/catch；或明确禁止 async listener 并在文档/类型上阻止。补 async reject、`onError` 自身抛错两个用例。

### S-2 fail-closed 口径过宽：合法范围内的手改/截断文件可放宽且无审计

- **证据**：`bootstrap.ts:234-235` 声称“corrupt or hand-edited file must never widen”；`policy.ts:273-308` 的解析器只拒绝 schema/绝对越界，`maxPercent: 100` 是合法值；`restore()`（`:225`）用文件内容整体替换内存 overrides；`apps/desktop/tests/policy-file.spec.ts:66-82` 只测了 999 越界，没有测“合法 JSON 把 20 改成 100”或“合法但缺失某通道 → 回退默认 20（可能比持久化的 5 更宽）”。
- **影响**：本地改文件可静默放宽 cap，且审计里没有记录（计划规定 restore 不写审计）；这与“坏文件不能放宽上限”的验收口径冲突。绝对上限仍守住，但 consent 范围可被文件改写。
- **建议**：二选一——(a) 对策略文件加 HMAC/校验并拒绝校验失败；或 (b) 明确威胁模型为“仅保证畸形/越界→保守默认”，修正注释，并在 restore 导致任何 cap 比当前值更宽时写一条 `policy_change`（actor `system` 或 human，detail 复用 `previous`/`next`）留痕。补 in-range 放宽与缺失通道回退两个用例。

### S-3 `snapshot()` 的 `device:channel` 键在 deviceId 含冒号时非单射

- **证据**：`policy.ts:209-214` 用 `internal.replace('\u0000', ':')` 生成键；`:248-254` 只按第一个冒号切分。`bootstrap.ts:167-171` 的 `isManifestEntry` 只要求 `key` 是非空字符串，`registry.ts:163-166` 的 `register()` 也不禁止 `:`。若 device `a:b` + channel `c` 与 device `a` + channel `b:c`（Buttplug channel 本身含冒号）同时存在，两者都序列化为 `a:b:c`，后写覆盖先写；restore 只还原为 `('a','b:c')`。
- **影响**：窄化 cap 丢失并回退默认 20（即放宽），或把 cap 误挂到另一通道；这是持久化格式本身的 fail-closed 缺陷，不只是手改问题。
- **建议**：在 manifest 加载与 `register()` 处拒绝 deviceId 含 `:`/`\u0000`，或把键改成 JSON 数组/转义编码；补 deviceId 含冒号的 round-trip 用例。

### S-4 会话上限 X 在生产代码中无法设置，也没有审计包装

- **证据**：HEAD 全仓 `setSessionCeilingByHuman` 只被测试调用；`apps/desktop/src/main/dashboard.ts` 无 `/api/policy/session-ceiling` 路由，`preload.ts`/`src/ui/app.js` 无入口。`bootstrap.ts:604-605` 的注释却说“covers a session whose ceiling was set”，但 HEAD 生产路径不存在该设置。计划把 UI/审计归 B2-T9/B2-T11（`M2-实施计划.md:224,1073`）。
- **影响**：A1-T10 落盘的 `sessionCeiling` 生产恒为 100；D4 的“人类设置 X”未接线；若后续直接调用 setter 而不写 `policy_change{scope:'session'}`，X 改动无审计。
- **建议**：B2-T9 实现时加 `registry.setSessionCeilingByHuman` 审计包装（`detail:{scope:'session', previous, next}`）和 dashboard/IPC 路由；本提交先把 bootstrap 注释改成“为后续 X 预留”，不要把测试里的手动设置当成生产可用。

### S-5 未连接设备的 `stop` 仍产生 1 条 dispatch（与文档/验收“未连接→0”矛盾）

- **证据**：`registry.ts:516-545` 的 `stop` 不检查 lifecycle；`write` 失败被 `onError` 吞掉后仍执行 `:539` 的 `emit` 和 `:545` 的审计 ok。HEAD 源码探针：注册但未连接 MockBackend，`stop('model','toy')` → 1 条 `{kind:'stop',deviceId:'toy',channelId:'all'}`，审计为 `stop ok`；`setLevel(0)` 经 `:385-389` 走同一路径。`subscribe` 文档 `:145-146` 却说“writes to an unconnected device produce nothing”。
- **影响**：reaction probe 会把一个没有到达设备的 stop 当作已发生动作，造成误触发 probe、事件与审计不一致；不是直接的安全放宽，但事件契约不成立。
- **建议**：在 `stop` 中按 lifecycle 决定是否 emit（`emergencyStop` 例外），或改文档/测试承认“stop 是命令级接受，不代表链路成功”，并补未连接 stop 的显式用例。

### S-6 保存的并发/失败路径可能让“窄化”在重启后回退

- **证据**：`bootstrap.ts:246-248` 的 `savePolicy` 在异步 `documents.write` 之前取 `snapshot()`；`apps/desktop/src/main/node-storage.ts:87-100` 每次独立 temp+rename，不按 key 串行。两个 `setCap` 或 setCap 与 shutdown（`bootstrap.ts:606`）并发时，旧快照可能最后落盘；写失败时 `setCap` 已改内存且审计已记 ok，文件仍是旧值，shutdown 只重试一次。
- **影响**：窄化 cap 在重启后回退到更宽的值（例如 5→20），违反 fail-closed；审计显示成功但磁盘状态不同。
- **建议**：在 bootstrap 内用 promise 链串行化 `savePolicy`，快照在队列内取；`setCap` 失败时回滚内存或至少写一条 `policy_change` error；shutdown 等待所有待写完成。

## 建议

### N-1 无订阅者不是零开销

`registry.ts:410,450,478,539,574` 每个接受命令都调用 `clock.now()` 并构造事件对象；`:739-741` 每次 `[...this.listeners]` 复制空集合。每命令一次、非每 tick，影响可忽略；若要求严格零开销，给 registry 加 `hasListeners` 短路或延迟构造事件。

### N-2 listener 重入会打乱事件顺序

`emit` 同步调用 listener；listener 内再调 `stop` 会嵌套 emit，后续 listener 会先看到 stop 再看到外层的 level。A2-T3 probe 若重入会观察到倒序；建议文档明确“listener 不得同步重入”或把事件投递到微任务/队列。

### N-3 `'all'` 哨兵可被真实 deviceId 占用

`devices/events.ts:29-35` 用 `'all'` 表示 broad stop；`registry.ts:163-166` 的 `register()` 不保留该 id。若注册 id=`all`，broad stop 与真实设备 stop 不可区分；建议保留 `'all'` 或在 `DispatchEvent` 用可选字段（undefined）表达 broad。

### N-4 派发事件缺 actor/source

`DispatchEvent` 没有 actor/source；`emergencyStop`/`shutdown` 的 stop 与 model 的 stop 完全同形，probe 无法区分恐慌/关机与普通动作。建议加 `actor` 或 `reason`（至少 `emergency:true`），或在文档明确 stop 不参与 probe。

### N-5 策略文件读错误被吞

`node-storage.ts:79-85` 的 `FileDocumentStore.read` catch 所有错误并返回 undefined；`bootstrap.ts:237` 因此把“不可读”当“不存在”，静默回默认且无 `recentErrors`。fail-closed 正确，但建议区分 ENOENT 与其他错误并 `recordError`。

### N-6 遗留 IPC `host:set-cap` 不落盘

HEAD 主窗口加载的是 `src/ui` + `/api/cap`（`index.ts:126-142`、`dashboard.ts:357`），该路径会 `savePolicy`；但 `preload.ts:12` 暴露的 `host:set-cap` 对应 `index.ts:64-68` 只调 registry，不落盘。该页当前未加载，属遗留路径；若保留请补 `savePolicy`，否则删除以免未来误接。

## 测试质量

### T-1 空心/永真断言

- `policy.spec.ts:42-52` 只枚举 `/^set/`，漏掉 `restore`；测试名承诺的“no way”不成立（见 B-2）。
- `policy-file.spec.ts:63` 用 cap=25 < ceiling=30 断言 `effective=25`；`get()` 也是 25，对 `effective→get` 变异无鉴别力。
- `bootstrap.spec.ts:171` 用 `policy.get` 比较 BF，默认 ceiling=100；变异后仍绿。
- `policy.spec.ts:142` 未覆盖通道 default 20 < ceiling 25，`min` 与 `get` 同为 20；无鉴别力。
- `policy.spec.ts:18-19,63` 的“conservative default”只断言 `< ABSOLUTE`，把默认值改成 99 仍绿，钉不住 20/80/60。
- `policy-file.spec.ts:66-82` 只有一个非法条目，无法区分原子 restore 与“先 clear 再逐条放”的非原子实现。

### T-2 变异矩阵（HEAD 核心副本实测）

| 变异 | 红 | 绿/空白 |
| --- | --- | --- |
| `effective()` 改回 `get()` | `policy.spec` “bounds every channel” 1 个测试（唯一断言） | 其余 405；`policy-file:63`（25<30）、`bootstrap:171` BF（ceiling 100）、snapshot/dispatch 全绿 |
| `emit` 移入 per-tick write | registry 7/8 个 dispatch 测试（exactly-one、per-tick、waveform、unsubscribe、throws、emergency、cap-change） | `setLevel(0)` 绿（stop 走 write，不走 runner）；desktop/policy 全绿 |
| `restore` 非原子 | `policy.spec` “restores atomically” 1 个测试 | desktop corrupt（单坏条目）、reload/roundtrip 全绿 |

### T-3 缺失的 fail-closed 用例

无效 JSON 文本（bootstrap `JSON.parse` catch）、缺 `channels`/`sessionCeiling`、类型错、`maxDurationSec:0`、`maxWaveIntensity:101`、空 device/channel、重复/含冒号 deviceId 均未测；“合法条目后接坏 ceiling”的原子性未测；X 改变后已连接郊狼 BF 重写/运行 effect 夹紧未测；async listener rejection、`onError` 自身抛错、未连接 stop 未测；`setCap` 的生产组合（恰一条 `policy_change` + 文件更新 + 失败回滚）未测（policy-file 直接调 `policy.setByHuman` + 手动 `savePolicy`）。

## 结论

无源码/测试改动；HEAD 基线 core 406/406、desktop 87/87 全绿；变异与探针均在 `/tmp` 副本执行。阻塞 2（B-1/B-2，均为 D4 边界）、应修 6、建议 6。

**是否可放行：否——B-1、B-2 未闭环前不建议放行；若 lead 正式把 B-1 的运行时夹紧划归 B2-T9，则应先删除错误注释并记录偏差，同时至少修掉 B-2（restore 品牌化/测试）与 S-1（async listener）后再放行。**
