# ui-v13：强度百分比语义澄清、请求值审计、延续/停止、波形名（2026-11-03）

> 用户第四轮反馈：
> 1. 软上限 0–20 时对话下方模型“请求的通道强度”很低（10% 以下）；放宽到 100 时才开始请求 30%+；调回低值实际输出又 <10%。怀疑软上限错误约束了 plan 的百分比强度。
> 2. loop 存在时需要模型显式 stop；未提及的通道默认延续上一回合。
> 3. 若未来做队列：同通道多次输出必须是“固定时长输出-loop 输出”，loop 只能在最后。
> 4. 界面波形图一直很疏，看不出波形是否变化——加波形名字小字。

## 1. 诊断：不是引擎二次缩放，是“模型请求偏低 + UI 只显示实际值”

用真实 DeepSeek 模型 + 默认软上限 0–20（4 通道 waveform mock）抓到原始 plan：

```
turn1 b1 strength=low  waveform cilia-tickle
      b2 strength=low  level targetPercent=15
turn2 b1 strength=med  waveform stroker-tide
      b2 strength=low  waveform cilia-tickle
```

- 引擎只有**一路** `mapPercentThroughRange`（`requestedPercent × band`），不存在第二次缩放：`targetPercent 15` × 上限 20% = **实际 3%**；`strength low` = 区间 40% → 实际 **8%**（wave/pulse 包络最低到 35% 峰值，采样平均约 5–6%）。
- 所以用户看到的 5–6% 有两个来源：模型确实写了偏低的区间请求（targetPercent 15 / strength low），以及效果小框只显示**映射后的实际 percent**，没有显示模型请求值。
- 把软上限放宽到 100 时，同样的相对请求映射出 30–50 实际值；调回低值时实际值随之下降——这是“软上限定义区间、客户端做映射”的**预期行为**，不是 bug。模型侧看不到 cap 数值。

## 2. 修复

### 2.1 模型侧语义：0–100 区间百分比，cap 数值不可见（core tools + host prompt）

- `targetPercent` 描述：`0–100 的区间百分比：100 = 玩家设定的通道上限，50 = 区间中点；请直接给普通强度 40–70 这类值，不要用 5–20 表达普通强度；具体上限数值对模型不可见。`
- `deltaPercent`：`区间百分点微调（±20 相当于区间的 20%），只用于微调。`
- `strength` 描述：`low = 40%、med = 70%、high = 100%（100% = 玩家设定的通道上限；具体数值不向模型暴露）。`
- `WAVEFORM_CHANGE_SCHEMA`：明确“波形动作幅度由 `beat.strength` 决定，waveform change 不接受 targetPercent/deltaPercent”。
- `TURN_PROTOCOL`：`普通接触用 med，升级/高峰用 high，low 只用于真正的试探/停顿，不要整局 low`；`targetPercent 给 40–70 这类值，不要 5–20`。任何具体 cap 数字都不进入 prompt（测试断言不含“上限 20 时输出 10”）。

修复后同一真实模型冒烟（cap 0–20）：plan 请求 **strength med→70 / low→40**，实际 percent **14 / 8**，不再出现 targetPercent 15。

### 2.2 请求值进入审计与效果小框（可诊断性）

- `ResolvedCommand.request` / `DispatchStatus.request` / `plan_resolved.actions[].request`：
  `{ strength, targetPercent?, deltaPercent?, requestedPercent }`；`requestedPercent` 是**映射前的 0–100 区间值**，不含 cap 数值。
- 效果小框（`play.js`）：有 request 时显示 `部位 · 区间 40% → 实际 8% · 波形名`；旧宿主/旧路径保持 `部位 · 8% · 波形名`；两端相等（cap 100%）简化成单个 `40%`。去重/rejected 规则不变。
- 这样“模型请求多少、软上限映射成多少”一眼可见，不会再被“实际值低”误导。

### 2.3 未提及通道默认延续、显式 stop 才停（host）

- `lastBodies` 记录每回合**最终合并命令的原始 body**（level percent / pattern envelope+waveformId+durationSec）；stop/percent 0 删除该通道；stop 事件（含 all）无条件清空。**复核后改为事务式提交**：dispatch 前的 resolve 只取命令；dispatch 后若 blocked、actions 数量与命令数不一致（preempt/abort 尾部）、或 action 身份不匹配 → 整轮不提交、保留旧状态；只有 `status !== 'rejected'` 的命令才提交（被拒 stop 不删旧 body）。host 的 TurnExecutor 包装已透传第 4 个 `options`（含 abort signal），preempt/超时可停止剩余 dispatch。
- 每回合开始 `holdContinuity` 用原 body 重放（不再用 steady 覆盖 loop 纹理），去掉 90s TTL，仅保留“旧效果 remaining >6s 不重启”门槛；仍走 registry 的 cap/ceiling/LOCKED 夹紧。人类直控（可信 dispatch 窗口外的 level/pattern/waveform 事件）会清除该通道 lastBodies，避免下一回合覆盖人类操作。
- 提示词：`本回合未提及的通道默认延续上一回合输出；不再刺激某个部位时必须用 stop 意图（可带 regions）显式停止。`
- 人类直控（非 model plan 路径）不会进入延续集合。

### 2.4 同通道 loop 顺序约束（为未来队列做准备）

- 当前仍按 per-channel merge（最后一条 body 生效、duration 取最长、loop sustain 只作用于最终 body）。
- 若被 merge 掉的**非最终**命令是 loop 波形，审计追加 warning：`loop output must be the last beat on <device>/<channel>; earlier beats need a fixed duration`——对应“队列时 loop 只能在最后、前面必须固定时长”的约束；提示词同步声明。
- 隐式队列仍未实现（BeatPlan 无时间轴，会与下一 plan/选项/暂停/preempt/probe/审计/效果框抢占；未来应做显式 `beats[].startMs/sequence`）。

### 2.5 右轨波形名（UI）

- 波形通道 canvas 下方新增小字：`波形：腔鞘套弄抽吸`（无波形 `波形：未选择`），随 2s snapshot 的 `channel.waveform` 实时更新（同 id 改名/换 id 都刷新，title 含 id）；非波形通道不显示；窄屏 ellipsis。CDP 截图 `.ui-shots/t15-wavename/`。

## 3. 验证

- `packages/core`：**52 files / 743 tests passed**；`apps/desktop`：**18 files / 253 tests passed**；两包 `tsc` 0；main/dev-server 构建通过。
- 真实模型冒烟（cap 0–20）：`plan_resolved.actions[].request` = `{strength:'med',requestedPercent:70}` / `{strength:'low',requestedPercent:40}`，对应实际 percent 14/8；效果小框显示 `区间 70% → 实际 14%`。
- UI CDP：效果小框 `阴蒂 · 区间 40% → 实际 8% · 腔鞘套弄抽吸`、旧路径 `胸部 · 55% · 涟漪`、cap100 简化 `大腿 · 40%`；390 窄屏 ellipsis、无溢出。波形名：显示/切换/未选择/长名截断/390 窄屏均通过。
- 独立复核：[ui-v13-review.md](ui-v13-review.md)（见该文件结论）。

## 4. 限制 / 已知取舍

1. **模型仍可能保守**：prompt 已引导 40–70/med/high，但 15–20 这类过小 targetPercent 仍可能偶发；审计和效果小框现在能直接看到请求值，便于判断是“模型写低”还是“映射后低”。
2. 软上限仍是安全边界：模型看不到具体数值；同一模型请求在 cap 20 时实际值自然是 cap 100 时的 1/5，这是区间映射的定义，不是衰减 bug。
3. 未提及通道默认延续只在有回合发生时续接；若长时间无回合，单个效果仍受 `maxDurationSec` 上限保护会停。
4. loop 顺序约束目前只是 warning/提示词；真正队列需要显式时间轴后再强制。`loop → stop` 视为合法终止（不再误报 warning）。
5. 延续状态是“事务式”的：preempt 回合整轮不提交（保留更早的 body，安全侧保守）；`hold` 自身下发的极短窗口内若有人类直控同通道，可能被当作可信事件；rejected stop 不删除旧 body（真正生效的 stop 事件仍清空）。
6. 真实郊狼 BLE 波形、修复后真实进程整局仍待硬件回归。
7. 延续 body 存的是解析结果：若某条 pattern 在 dispatch 时因 waveform 失败降级为 plain，下一回合 hold 仍会尝试原 waveform（可能再次失败并静默）——下一批建议在 degraded 时提交降级后的 plain body，或 hold 失败时重试 plain。

## 5. 相关文件

- core：[`packages/core/src/agent/tools.ts`](../packages/core/src/agent/tools.ts)、
  [`packages/core/src/scenario/intents.ts`](../packages/core/src/scenario/intents.ts)、
  [`packages/core/src/execution/executor.ts`](../packages/core/src/execution/executor.ts)
- host：[`apps/desktop/src/main/play.ts`](../apps/desktop/src/main/play.ts)
- UI：[`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)、
  [`apps/desktop/src/ui/style.css`](../apps/desktop/src/ui/style.css)
- 截图：`.ui-shots/t15-wavename/`、`.ui-shots/t18-effects/`
