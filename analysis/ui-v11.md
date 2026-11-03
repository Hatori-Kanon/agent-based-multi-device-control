# ui-v11：强度语义、同回合合并、思考期续接、波形回退与柱状图（2026-11-03）

> 用户第二轮反馈（本轮）：
> 1. **强度为什么一直很低。**
> 2. **部位会在一回合内重复发送。**
> 3. **有时候波形还是会发送失败。**
> 4. **在模型思考的时候设备会停下来，这不应该。**
> 5. **柱状图高度不要根据强度，跟随波形本身设计的强度；柱子要很细，频率低时疏、高时密。**

## 0. 真实运行证据（v10 构建，08:44–08:47 的真实一局）

审计 `32f95259`/`c96ce5c0` 之后、v10 构建（`dist/main.mjs` 08:44）的一局：

| 现象 | 证据 |
|---|---|
| 强度低 | `state/policy.json`：`coyote:a maxPercent=11`、`coyote:b maxPercent=15`（原生 0–22 / 0–30，满量程 200）。模型 high 档 = `STRENGTH_RATIO.high = 1.0 × 通道 band`，所以最高只能 11%/15%；审计实际下发 1–11%。**代码没有越权改人类软上限**（D4）；UI 旧读数只写 `0–22`，没有满量程参照，容易误以为“强度坏了” |
| 同回合重复 | turn 9：`a` 收到 `10%`（b1）又 `1%`（b2）；turn 13：`a` 先 `set_level 2%, 40s`，随后 `run_pattern 4s` 把 Hold 截成 4s → 同一部位一回合动两次、且短动作覆盖长保持 |
| 思考时停下 | turn 12 的 9s 效果在 `47:32.6` 到期，turn 13 模型生成 `47:32.3–37.8`，设备空窗 ~5s；turn 13 的重复短命令进一步放大空窗（a 从 41.9 停到 52.5） |
| 波形失败 | v10 前 21 次波形下发 19 次 rejected；v10 后该局 0 次。残余失败模式是：模型/包引用未知 waveform id（回退 plain pattern），或 registry 侧波形选择/传输失败（整条 action rejected） |
| 图表 | 旧实现：柱高 = `texture × view.level/100`（随当前强度缩水）、柱宽 = `spacing-2`（最粗 20px）、柱距按平均频率 |

## 1. 修复

### 1.1 强度：不越权，但让“为什么低”可见（issue 1）

- **不改人类软上限**（D4）：强度仍由每通道 `[minPercent, maxPercent]` 夹紧；`strength` 档位映射保持
  `low/med/high = 40%/70%/100% × band`。
- UI 读数带满量程参照：郊狼强度显示 `0–22 / 200`，`title` 附 `0%–11%`；百分比后端仍 `0%–40%`。
- `TURN_PROTOCOL` 增加：`strength 随节奏推进（low→med→high），不要整局只用 low；真正上限由玩家通道软上限决定`，
  以及 `非 stop 动作 durationSec 建议 30–60s`。

> 结论：强度低的直接原因是用户把两个通道的**强度上限**设成了原生 22/30（满量程 200）。把「强度」上限滑杆
> 拉到期望的原生值（如 120–180）即可，模型 high 档会随之变大。

### 1.2 同回合同通道命令合并（issue 2）

`resolvePlan` 在生成命令后、排序前按 `(device, channel)` 合并：

- 最终 body（percent/envelope/waveform）取**最后一条**命令；
- `durationSec` 取该通道所有非 stop 命令的**最大值**（长保持不会被后续短纹理截断）；
- 最后一条是 stop（percent 0）时保持 stop，不合并 duration；
- 被丢弃命令写一条 `beat b1: command on coyote/a superseded by beat b2 in the same turn` warning（审计可追溯）。

效果：每回合每通道至多一条真实下发；`plan_resolved.actions` 不再出现同通道重复行；效果小框同步只有一行/通道。

### 1.3 波形发送失败兜底（issue 3）

- **未知引用 → 默认波形**（`内容包规范.md` §4.5）：`ResolveContext.defaultWaveformId`（宿主传包内第一个波形），
  解析不到时回退该波形而不是 plain pattern（仍记 `unknown-waveform` warning）。
- **registry 侧波形失败 → 去波形重试**：带 `waveformId` 的 pattern 第一次 `runPattern` 抛错时，只有
  **waveform 阶段错误**（`UNKNOWN_WAVEFORM`/`WRONG_CHANNEL_KIND`/无 code 的 backend 写入失败）才用同一 envelope
  **去掉波形重试一次**；`NOT_CONNECTED`/`LOCKED`/`INVALID_POLICY` 等直接 rejected，不误报 waveform 失败，
  取消（abort）的回合也不重试。成功记 `degraded`（reason 说明原波形失败），只有第二次也失败才 `rejected`。
- 因此“波形这一层失败”不再吃掉整个动作：设备仍按同一包络输出，只是没有纹理。

> 复核后补丁（`analysis/ui-v11-review.md` §P1-1/P2-1）：hold 增加 TTL(90s)/剩余时长(>6s 跳过)/仅记录 model
> 计划命令三门槛；去波形重试收紧为只对 waveform 阶段错误 + abort 感知。

### 1.4 模型思考期间设备续接（issue 4）

`PlaySession` 订阅 registry 的 dispatch 事件，按 `device:channel` 记住**最近一次被安全层接受**的 model 计划输出
（`percent` + 当前 waveform + `at` + `durationSec`；`stop` 无条件清除）。每次 `runOneTurn` 开始、构建 prompt 之前
调用 `holdContinuity()`：

- 只记录 **model 计划命令**：在 `executor.dispatch` 包装期间置 `modelDispatchActive`，窗口外的 level/pattern/waveform
  事件（例如人类设备页直控）不进入记忆；`stop` 事件不受窗口限制，永远清除（暂停/急停/人类 stop 都有效）。
- `registry.isLocked` 时跳过；TTL：距上次 model 命令超过 **90s** 不再复活；旧效果仍在跑
  （`remaining = at + duration − now > 6s`）时跳过（没有空窗，重启只会重复/拉长）；否则对 ready 且 percent>0 的通道，
  用 **`actor: 'system'`** 重新下发一条 **bounded hold**：
  - 有波形且通道支持 → `runPattern`（steady envelope，min=max=last percent，`durationSec = min(30, channel.maxDurationSec)`）；
  - 否则 `setLevel`；
- 每个通道 try/catch，任何失败都不阻断回合；新 plan 到达后自然覆盖。

审计上表现为回合开始前若干条 `actor=system` 的 `set_level`/`run_pattern`；它们**不是 plan 命令**
（不注册 probe、不计入 beat），外部审计工具需按 actor 过滤（`m2-e2e` 已同步）。

### 1.5 柱状图（issue 5）

新增 `apps/desktop/src/ui/chart-math.js`（classic script，`window.EmbodiedChartMath.computeBars`，纯函数无 DOM/时钟）：

- **柱宽固定 2px**（不随柱距变粗）；
- **柱高只由波形自身 intensity 决定**：`round(intensity/100 × (height−3))`，最小 1px；当前通道强度不再缩放它；
- **柱距由每个采样点自己的协议频率决定**：`spacing = clamp(4, 28, 28 − (freq−10)/230×24)`；10 → 28px（低频疏），
  240 → 4px（高频密），同一帧里疏密跟随波形；
- 自右往左、phase 对整帧总柱距取模，无缝循环滚动；canvas 高度 34 与 `.live-wave` CSS 一致，`image-rendering: pixelated`
  保证 2px 细柱不被缩放糊掉。

## 2. 验证

**静态/单测**（本机）

- `packages/core`：**52 files / 717 tests passed**；`tsc --noEmit` 通过。
- `apps/desktop`：**18 files / 243 tests passed**；`tsc --noEmit` 通过。
- `corepack pnpm --filter @embodied/desktop build` 与 `build:dev` 均成功（chart-math.js 进入 static map 与 bundle）。

**真实模型冒烟**（`node --experimental-transform-types`，真实 DeepSeek 配置；waveform-capable 四通道 mock，
玩家部位 小穴/后穴/阴蒂/乳房，pack `tentacle-shadow@0.3.0`，自动运行 10s）

| 检查项 | 结果 |
|---|---|
| 每回合同通道重复 | 4/4 回合 `plan_resolved.actions` 的 device:channel **全部唯一**（merge 生效） |
| 波形失败 | `run_pattern`/`set_waveform` 失败 **0 次**（默认波形 + 去波形重试兜底） |
| 思考期续接 | 当旧效果剩余时长 ≤6s（会出现空窗）时，回合开始先出现 `actor=system` 的 bounded hold（如 04:24:21.085 d 1%，随后 04:24:25.946 模型命令）；长效果（40s 等）仍在跑时按设计不重启。TTL=90s，且只记录 model 计划命令（人类直控不重放） |
| 效果小框 | 每回合都有：阴蒂/后穴/小穴/乳房 + 实际 percent + 波形名（如「纤毛轻扫微麻」「微须密集群聚吮吸」） |
| 报错 | 0 |

**真实浏览器 CDP**（stub 宿主 + 真实 index.html/shell/play/chart-math/style，headless Chrome，1600×1000）：

- 像素反推：所有完整柱 `width=2` 列；相邻柱距集合 `{4, 28}`（低频疏/高频密）；柱高 8–31（画布 34，底部留基线），
  最高 31 = `round(100/100×31)`；隔 260ms 两帧柱子整体左移（rAF 滚动）；pageErrors=[]。
- 右轨读数实测：强度 `0–22 / 200`，title `强度范围 0–22 / 200（0%–11%）`；频率 `10–90 Hz`。
- 截图：`.ui-shots/t7-wave/`（gitignored）。

## 3. 限制 / 已知取舍

1. **强度上限是人类的**：模型只能在 `[minPercent, maxPercent]` 内工作；当前用户配置 11%/15%（原生 0–22/0–30），
   把滑杆拉高即可。默认策略 `maxPercent=20` 也偏保守（新装用户同样会觉得“弱”），是否提高默认值需产品决策。
   另外模型有些回合本身会写较小的相对 `targetPercent`（审计里有 1–4%），上限是“天花板”而非每个低值的唯一原因；
   已加 `strength` 随节奏递进的 prompt 约束，但仍是软约束。UI 单位仍混用：live 条/效果框显示满量程百分比，
   软上限行显示原生 `0–22 / 200`（P2，后续可统一）。
2. **合并语义**：同通道后置 beat 覆盖前置（最终状态 = 最后一条），duration 取该通道非 stop 最大值；
   `plan_resolved.actions` 与 preemption `remainingBeats` 的计数语义随之变化（按合并后命令）；短促动作后接长保持时
   可能被拉长（为了不让长保持被短纹理截断），这是有意的取舍。
3. **续接 hold** 只在“旧效果剩余 ≤6s 且距上次 model 命令 ≤90s”时桥接，bounded ≤30s；只记录 model 计划命令
   （人类直控不重放），stop/暂停/急停/结束立即清空；hold 用 steady min=max 重放，平均力度可能高于原 wave/pulse
   包络（已知取舍）；hold 是 `system` 动作，外部审计工具需按 actor 过滤。
4. **默认波形回退**使用包内第一个波形（规范暂无 default 字段）；若模型反复引用不存在的 id，纹理会退化为该资产
   （审计仍有 warning）；去波形重试只对 waveform 阶段错误生效（其它 safety code 不重试）。
5. 真实郊狼 BLE 波形端到端仍未在开发环境验证（本机无硬件）；真实模型与 mock 波形通道覆盖了数据链。
   第二轮修复尚未在用户真实进程复测——重建后需要用户跑一局验证“思考期不断/不重复部位/波形可用/柱状图”。

## 4. 相关文件

- 图表：[`apps/desktop/src/ui/chart-math.js`](../apps/desktop/src/ui/chart-math.js)、[`play.js`](../apps/desktop/src/ui/play.js)、
  [`style.css`](../apps/desktop/src/ui/style.css)、[`chart-math.spec.ts`](../apps/desktop/tests/chart-math.spec.ts)
- 宿主：[`apps/desktop/src/main/play.ts`](../apps/desktop/src/main/play.ts)
- core：[`packages/core/src/scenario/intents.ts`](../packages/core/src/scenario/intents.ts)、
  [`packages/core/src/execution/executor.ts`](../packages/core/src/execution/executor.ts)
- 复核：[`analysis/ui-v11-review.md`](ui-v11-review.md)
