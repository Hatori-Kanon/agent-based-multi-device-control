# v3 改造记录：单窗口 + 通道范围 + 直控

> 用户要求（2026-11-02）：游玩与设置同窗口、主页是游玩、点「设备」切换；设备可设强度上下限、执行用百分比；
> 去掉「试跑」改成强度条直控滑块；「脉宽上限」改成频率范围；游玩界面去掉全局 X，改按设备/通道设软上限。
> 语义契约：[`设备范围与单窗口界面-设计说明.md`](../设备范围与单窗口界面-设计说明.md)；界面说明：[`前端界面设计.md`](../前端界面设计.md) §8。

## 1. 语义变化（core）

| 旧 | 新 |
| --- | --- |
| `ChannelPolicy = { maxPercent, maxWaveIntensity, maxDurationSec }` | `{ minPercent, maxPercent, minFreq, maxFreq, maxDurationSec }` |
| 模型 percent 是绝对值，超过 cap 被 clamp | 模型 percent 是 **0–100 相对量**，`mapPercentThroughRange` 映射进 `[minPercent, maxPercent]`；0 仍是停止 |
| 波形帧强度字节被 `maxWaveIntensity` 夹 | 频率字节按协议全带归一化映射进 `[minFreq, maxFreq]`（`clampFrameFrequency`）；强度字节只受协议 0–100 约束 |
| `PolicySnapshot` v1（含 `maxWaveIntensity`） | v2；启动时 v1 迁移为 `minPercent=0`、`minFreq=10`、`maxFreq=240` 并回写 |
| 快照 channel：`maxPercent/maxWaveIntensity/maxDurationSec` | 新增 `minPercent/minFreq/maxFreq`，删除 `maxWaveIntensity` |
| 人类只能改 cap / 试跑 | 人类可直控：`POST /api/level`（绝对百分比，区间与会话上限夹取；默认时长 = `maxDurationSec`） |

不变量：`PolicyStore.setByHuman` 仍是唯一写入边界入口；模型工具面没有任何 cap/频率字段；LOCKED 闩锁、
急停、审计（`policy_change` / `set_level` actor）、郊狼 `BF` 重下发路径不变。

## 2. 前端结构

```
ui/index.html    唯一应用页：topbar（品牌/游玩·设备 nav/连接/会话/急停）
  #view-play     默认：大厅（内容包·时长·软上限）→ 舞台（现在/对话/选项/输入/右轨状态·连接与部位·软上限·感知）
  #view-device   设备视图：三栏（设备管理/感知/状态 | 设备卡+波形库 | 审计/日志/调试）
ui/shell.js      nav 切换 + body[data-view] + sessionStorage 记住视图 + viewchange 事件
ui/play.js       游玩逻辑（去掉全局 X，新增软上限卡，隐藏视图时停轮询）
ui/app.js        设备逻辑（id 全量 dev 前缀，直控通道条，去掉试跑/`/api/demo` 调用）
ui/style.css     设计系统；v3 只追加 §15（432 行，0 行修改已有规则）
```

- `/`、`/play`、`/device` 同页；`play.html` 删除；静态白名单：`index.html app.js play.js shell.js style.css phone.html`。
- 通道条：强度条即滑杆（0=停止）→ `POST /api/level`；强度/频率各一对 min/max 滑杆 → `POST /api/cap`；
  时长 → `/api/cap`；停止 → `/api/stop`；波形 → `/api/waveforms/select`。
- 游玩软上限：大厅右列 + 舞台右轨，按 设备→通道 分组，改动即 `/api/cap`。

## 3. 验证

| 检查 | 结果 |
| --- | --- |
| `packages/core` tsc | 0 error |
| `apps/desktop` tsc | 0 error |
| core vitest | 50 files / **651** tests（基线 635，净 +16） |
| desktop vitest | 14 files / **165** tests（基线 162，净 +3） |
| 静态契约 | `id="view-play"`/`id="view-device"`/`/shell.js`/`id="ceiling"` 不存在/软上限 均有断言 |
| 真 API 实测 | `/api/cap` 新字段落库；`/api/level` 5%→floor 10、90%→ceiling 55、0=停止；快照字段齐全 |
| 真浏览器 | 大厅/设备视图/进行中舞台截图；直控滑杆 30→percent 30；强度上限滑杆 55→70；软上限 20→45 |
| 视图切换 | `data-view` 切换、刷新保持、切走轮询停止/切回刷新 |
| 迁移 | v1 `policy.json` 读入 → v2 语义（不放大边界），启动回写 |

## 4. 审查与修复

两个独立只读子代理并行审查（core 语义/安全、UI/宿主契约），报告：
[`ui-v3-review-core.md`](ui-v3-review-core.md)（1 阻塞 + 7 应修）、
[`ui-v3-review-ui.md`](ui-v3-review-ui.md)（1 阻塞 + 6 应修）。修复如下：

| 来源 | 问题 | 修法 |
| --- | --- | --- |
| core B-1 | 脉宽上限被删后，模型/内容包可用 95/100 强度波形（v1 人类设的 45/80 被放大） | `maxWaveIntensity` 恢复为**内部安全上限**（默认 80，v1 迁移保留旧值），UI/API 不暴露；coyote 发射端先映射频率带、再夹强度字节；审计同时记录 `waveformIntensityCap` 与 `waveformFreqRange` |
| core S-1 | 遗留 session ceiling 仍压新软上限，且可造出 `min>max` 的非法区间 | 启动时把旧 ceiling **一次性折算**进各通道 `maxPercent`（只收窄）并释放为 100 + 写审计；`effective()` 保证 `minPercent < maxPercent` |
| core S-2 | 设计写「先映射再 ceiling 夹」，实现按生效区间映射 | 以实现为准修正契约：映射使用生效区间（ceiling 不会把区间夹反） |
| core S-3 | 正相对量（1%）可舍入成 0 = 静默停止 | 映射结果对 `percent>0` 至少为 `max(1, minPercent)` |
| core S-4 | `/api/level` 负值路径不一致（-5 被当成 level 0 记录） | registry `percent <= 0` 一律走 stop；`/api/level` 只接受 0–100 整数，负值/小数/超界 400 |
| core S-5 | `/api/cap` 混合非法字段会「部分生效」 | patch 全有或全无：任一已知字段非法、或仍带 `maxWaveIntensity`，整条 400 |
| core S-6 | keepalive 固定 5s，`maxDurationSec < 5s` 会断档 | 续期间隔改为 `min(5s, duration/2)`，下限 500ms |
| UI B-1 | 直控滑杆拖到 0 不能停止别处发起的输出（`sentPercent` 早退） | `change` 在 0 时无条件停 keepalive 并发一次 0；实测「外部 20% → 滑杆 0 → 服务端 0」 |
| UI S-1 | `/play`、`/device` 刷新丢上次视图 | `show()` 用 `history.replaceState` 同步路径（保留 token）；初始视图「存储优先、路径兜底」，实测切到设备后 URL 变 `/device`，刷新仍在设备 |
| UI S-6 | Electron `Ctrl+Alt+P` 仍开第二个游玩窗口 | 删除 `openPlayWindow`/`playWindow`；快捷键改为聚焦主窗口并点击 nav 切到游玩视图 |
| UI S-2/S-3 | 范围滑杆 aria-label 无通道上下文；频率读数无单位 | aria-label 带上设备名/通道名；频率读数显示「编码」 |
| UI S-4/S-5 | 设计文档 §5 仍是 v2 硬约束；静态测试有盲区 | 文档 §3 标为 v2 历史、§5.1/§5.3 换成 v3；测试补默认 `data-view="play"`、`/device` 200、`/play.html` 404、shell.js 三个特征、`/api/level` 与 cap 的拒绝路径 |

## 5. 已知遗留

- 对话流/舞台沿用 v2 的视觉与交互；本轮只改控制语义与窗口结构。
- 直控是 best-effort HTTP：标签页被立即杀掉时，输出会在 ≤15s 的 `durationSec` 内自然到期。
- 旧内容包若按「绝对百分比」调参，在默认 `[0,20]` 区间下实际输出会变小（这是相对语义的预期结果）。
- 会话上限 `sessionCeiling` 仍留在引擎里（API 兼容、第二道闸门），界面不暴露；旧文件的上限只在启动时折算一次。
- 非 Coyote 后端没有 `applyBounds`：运行中的 steady 效果在边界改变后要等本条 `durationSec` 到期才采用新边界
  （Coyote 会立即重下发 `BF`）。
- `analysis/m2-*`、`M2-实施计划.md` 等历史文档描述的是 v2 之前的语义，保留为历史记录；当前语义以
  [`设备范围与单窗口界面-设计说明.md`](../设备范围与单窗口界面-设计说明.md) 为准。
