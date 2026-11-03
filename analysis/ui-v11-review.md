# ui-v11 第二轮修复 · 对抗复核

> 复核员：reviewer（task-8）。基线 **HEAD = f3dfa25**（v10）。对象：工作区未提交第二轮 diff
> （16 files +939/−89，含 2 个新文件 `apps/desktop/src/ui/chart-math.js`、`apps/desktop/tests/chart-math.spec.ts`）。
> 只读复核；本文是唯一写入。未改代码、未 commit。
> 真实运行证据：本机 audit `C:/Users/HatoriKanon/AppData/Roaming/@embodied/desktop/embodied/audit/device.jsonl`
> （943 行，最后一局 `c96ce5c0…`，本地 08:44–08:47；**是 v10 构建跑的，第二轮修复尚未在真机/真实进程里跑过**）。

---

## 0. 门禁与独立验证

| 检查 | 结果 |
| --- | --- |
| core `vitest run` | **52 files / 715 tests passed**（与 Lead 数字一致） |
| desktop `vitest run` | **18 files / 239 tests passed**（一致；新增 chart-math.spec 7 条） |
| 两包 `tsc --noEmit` | 均 exit 0 |
| esbuild `main/index.ts` / `dev-server.ts`（`--outfile=/dev/null`，不落盘） | 均 exit 0（618.5 kb / 含 chart-math 的 dev bundle） |
| `node --check` | `play.js`、`chart-math.js` 均 ok |
| 图表 CDP 产物 | `.ui-shots/t7-wave/report.json`：canvas 300×34、CSS 高 34px、`pixelated`、柱宽集合 `{2}`、柱距集合 `{4,28}`、柱高 8–31、两帧左移 ✓ |
| 真实模型冒烟 | **无可复核产物**（ui-v11 §2 声称的临时 dataDir 已删；无法独立验证 4/4 唯一/0 波形失败） |

---

## 1. 结论速览

- **P0：0 项。** 合并/重试/续接都没有绕过 cap/ceiling/LOCKED，也没有新增 agent 可达的控制入口。
- **P1：1 项（需 Lead 明确接受，或在交付说明里写成已知取舍）**
  - **P1-1 `holdContinuity` 无 TTL、事件不带 actor**：任何被安全层接受的最近输出（包括**人类直控**与已自然结束的计划输出）
    都会在之后**每个回合**以 `actor=system` 被重新下发（≤30s/次），直到 stop/pause/panic/end 或新计划覆盖。
    安全上仍被 cap/LOCKED 兜底，但“计划是唯一动作来源”的契约被实质放宽；人类直控的时限/到期语义会被覆盖。
- **P2：10 项**（重试错误分类/双审计行、合并的 probe/preemption/duration/优先级副作用、默认波形任意、
  hold 审计噪音/电平抬升、UI 单位混用、模型相对强度不可审计、默认策略 20% 偏保守、测试缺口、文档声明）。
- **复核判定：技术上可交付（真机回归除外）**；但建议在交付说明中把 **P1-1（续接语义）** 写成明确取舍，
  并最好下一轮给 hold 加 **TTL/actor 过滤**（见 §3）。若产品不接受“回合边界可能重新拉起输出”，则需先修 P1-1。

> **更新（2026-11-03 12:24 后）**：Lead 已按建议修复 P1-1（TTL=90s / 剩余 >6s 跳过 / 仅记录 model 窗口 / 人类直控不重放）
> 与 P2-1（去波形重试只对 waveform 阶段错误 + abort 感知）。复核见 **§6**：两者均**闭环**，无新 P0/P1；
> 最终判定仍为 **可交付（真机回归除外）**，残余仅 P2 清单。

---

## 2. 逐项复核（a–g）

### a) `mergeChannelCommands`（core `intents.ts`）

- 实现位置：`resolvePlan` 在 `resolveBeat` 之后调用合并（`intents.ts:192/228`），按 `(device,channel)` 分组：
  末条 body 胜出；`durationSec = max(非 stop duration)`（`:259-279`）；末条是 stop 时保持 stop；
  被丢弃命令写 `superseded` warning。
- **正确性**：分组/稳定性/确定性正确（`Map` 插入序 + 之后仍 `sort(compareCommands)`，测试 `scenario-resolve.spec.ts:195/218+`
  断言到 beat/channel/body/warning 级）。stop 不会被 duration 合并（测试 `:270`）；只碰撞通道合并、其它通道不动（`:295`）。
- **安全**：合并发生在 clamp 之后且只做“取最后 body + 取最大已夹紧 duration”，
  `duration ≤ 该通道 maxDurationSec` 仍成立；percent/envelope 均来自已夹紧命令；registry 还会再夹一次。
  LOCKED/ceiling/cap 不受影响（executor/registry 未改安全路径）。**未发现安全回归。**
- **边界/语义变化**：
  - 被 superseded 的 beat 不再产生 action/probe，`plan_resolved.actions` 与 preemption 的 `remainingBeats`
    都按合并后命令计数；executor 的“one probe per dispatched beat”实际变为“按合并后命令”。属于**契约变化**，
    文档已写（导演契约 v0.1.2），但下游 probe/审计回放需要一次性确认（见 P2-3）。
  - `duration` 取 max 会让**后置的短动作被拉长**：同通道“40s level + 4s pattern”最终是 4s pattern 跑 40s
    （`scenario-resolve.spec.ts:222` 明确断言）。与新增协议“短促/瞬动用 ramp/pulse 且 duration 设短”存在张力（P2-4）。
  - 末条若是 **fallback/degraded** 命令，会覆盖同通道先前精确命中的命令，最终 status 变 degraded（P2-5）。
  - 显式 `targets` 若在同一 beat 里重复点名同一通道，合并会生成一条 `superseded by beat <同一 beat>` 的 warning，
    文案略显奇怪（低优先级，未单列）。

### b) executor 去波形重试（`execution-executor.ts`）

- 实现：带 waveform 的 pattern 第一次 `registry.runPattern` 抛错 → `warnings.push(...)` →
  **同一 envelope 去掉 waveform 再跑一次**；成功返回 `status:'degraded'` + reason；第二次失败才由外层 catch → `rejected`
  （`executor.ts:362-408`）。
- **假设成立**：“波形选择在 effect start 之前”已核实：registry 顺序是 `prepare → assertDuration → clamp → assertValid →
  selectWaveform → runner.start → emit → audit`（`registry.runPattern` 453-500）。waveform 阶段失败时 envelope 尚未 start，
  因此重试不会并行驱动/双倍输出。**未发现重复驱动。**
- **问题**：
  1. catch 是**全量**的：NOT_CONNECTED / LOCKED / INVALID_POLICY / duration 等非 waveform 错误也会被重试一次，
     warning 与 action.reason 统一写成 “waveform failed … ran a plain pattern”，诊断误导。
     `execution-executor.spec.ts:425` 的第二个测试即把 NOT_CONNECTED 的第二次失败记录成 “waveform "tide" failed” warning。
  2. registry 每次失败会 `recordFailure` 写一条审计（`registry.ts:947-960`），所以**一条最终 rejected 的命令现在可能产生两条失败审计行**
     （第一次波形尝试 + 第二次 plain 尝试）；对审计消费方是噪音。
  3. 两次尝试之间**没有 abort 检查**（executor 只在命令之间查 signal），若第一次失败后 panic/preempt 已到，
     仍可能再跑一次 plain pattern（短窗口、仍受 registry lock 检查，但会“在已中止后又输出一下”）。
  4. 若第一次失败发生在 `runner.start` 之后（emit/audit 监听器抛错等），重试会再次 `runner.start`（替换 runner），
     不是并行双驱动，但会重启包络——概率极低，记录为残余风险。
- 建议：只对“waveform 选择/资产类”失败重试（按错误码/阶段标记），其它错误直接 rejected；重试前查 abort；
  失败审计只保留最终结果或标记第一次为 `waveform_degraded`。

### c) `holdContinuity`（play.ts）

- 实现：`subscribeDispatch` 订阅 registry 事件（`:1214-1217`），按 `device:channel` 记录最近输出的 `percent/waveform`；
  `stop`（单通道或 `all`）清条目（`:1231-1244`）；每回合 `runOneTurn` 开头、冻结快照前调用 `holdContinuity()`
  （`:991`）；对 ready 且 last percent>0 的 level 通道，用 `registry.setLevel('system')` 或带波形的
  `registry.runPattern('system', steady, duration=min(30,maxDurationSec))` 重发（`:1274-1322`），失败吞掉。
- **安全边界核查（通过）**：
  - 只重发**registry 已接受**的事件（rejected 不产生事件），且 registry 会再次按当前 policy/ceiling/cap 夹紧；
  - `isLocked` 直接跳过（`:1275`）；panic → `emergencyStop` 发 `stop all` 清空；pause/end 的 hook 调 `registry.stop('system')`
    （`play.ts:591/599`）同样发 stop 事件清空；新 plan 随后覆盖；human stop 也清空。**没有复活已停止通道的直接证据。**
  - 不注册 probe、不写入 plan_resolved/ledger；审计为 `actor=system`，m2-e2e 已按 actor 过滤。
- **P1-1（语义/授权）**：
  - **无 TTL/次数上限**：`effect_finished` 不清 `lastDispatched`，因此某通道“上一次非零输出”即使已自然到期，
    之后每个回合都会被重新拉起 ≤30s；autopilot 10s 间隔下等价于**持续输出**。若模型连续 narrative-only
    （真实审计里出现过），设备仍按最后 percent 持续动作，正文却可能写“放空/退出”。
  - **事件不带 actor**（`events.ts:31-42` 只有 kind/device/channel/at/percent/waveformId/durationSec）：
    host 无法区分“模型 plan 的输出”和“人类直控的输出”。人类在设备页拖动强度条产生 `setLevel('human', …, duration=capacity)`
    （`bootstrap.ts:1447`），若未 promote/未 stop，下一次模型回合的 hold 会把它以 `actor=system` 续接，
    把“人类限时/释放即到期”的直控变成每回合续接；这改变的是直控的时限语义，不只是模型连续性。
  - **电平抬升**：hold 用 `steady, min=max=last.percent`，而原 plan 可能是 `wave`/`pulse`（min≈0.35×max），
    hold 会把平均力度抬到 max 并持续 ≤30s，回合边界可感知为力度跳变（P2-7）。
- 建议（优先级从高到低）：① 加 TTL（例如只续接“距上次接受输出 ≤ 60–90s”，或仅续接一个回合）；
  ② 在 `DispatchEvent` 增加 actor 或只把 model 的 dispatch 写入 `lastDispatched`（human/system 不写）；
  ③ UI/文档明确“思考期由宿主续接”的语义；④ 补测试：effect 自然到期 + 多回合 no-plan、人类直控后释放、
  LOCKED/panic/pause 不复活、波形通道 hold（当前无测试）。

### d) 默认波形回退（`intents.ts` + host `play.ts`）

- `ResolveContext.defaultWaveformId`（`intents.ts:108`）：`resolveWaveform` 处理未知引用时，若通道支持波形且
  default 可解析 → 返回 default 的 canonical id + `degraded:'unknown-waveform'` 并写 warning；否则 plain pattern（`:728-760`）。
- host 传 `pack.waveforms[0]?.id`（`play.ts:1007-1012`）。行为与测试（`scenario-resolve.spec.ts:621+`、
  `play.spec.ts` “wires the pack default waveform”）一致；无波形能力/无 default/默认不可解析均回退 plain，正确。
- **问题（P2）**：规范/`pack.json` 没有“默认波形”字段（`内容包规范.md` §4.5 只说“回退默认波形”），“包内第一个波形”
  是按 loader 文件序任取的资产（0.3.0 是 `cilia-tickle`）；对频繁写未知 id 的模型，全部纹理会被固定成同一资产，
  且作者无法指定。建议加 `pack.json.defaultWaveform`（可选）或明确用内置中性波形；至少在规范写死规则。

### e) 图表（chart-math.js / play.js / CSS）

- 实现：`chart-math.js` 纯函数（无 DOM/时钟），`BAR_WIDTH=2`、`spacingFor` 按**每个采样点**频率 10→28px / 240→4px、
  `heightFor` 只用 waveform intensity（`round(intensity/100×(h−3))`，最小 1px）、phase 对整帧总柱距取模；
  `play.js` 只取 preview + `fillRect`（`:868`），canvas 高 34 与 CSS 一致（`:771`、`style.css:1317-1327`），`pixelated`。
- **验证真实性**：`chart-math.spec.ts` 用 `node:vm` 在无 DOM 上下文执行整份脚本，断言柱宽恒 2、柱高只跟 intensity、
  混频采样间距 {28,4}、phase 循环/负相位/确定性、越界与 NaN；CDP `report.json` 用真实像素列反推 `{2}`/`{4,28}`/高 8–31/两帧左移。
  **不是 grep 假测试。**
- 残余：canvas 属性宽 300 而 CSS 宽 310（rail 宽度驱动），`pixelated` 下柱宽显示约 2.07px（窄 rail 会 <2px），
  属正常缩放；无功能 bug。旧实现 `view.level/100` 已删除（dashboard.spec 断言反查）。

### f) 软上限读数 `0–22 / 200` 与“强度一直很低”的判断

**结论：Lead 的判断（用户通道软上限 11/15 是“强度低”的主因/硬上限）有代码与 UI 双重支持，没有发现反驳它的代码/UI 证据；
但需要修正两点表述（见下），否则最终答复会过度简化。**

证据链：

1. `state/policy.json`（本机）：`coyote:a maxPercent=11`、`coyote:b maxPercent=15`，`minPercent=0`，ceiling=100。
2. 强度档位映射：`STRENGTH_RATIO = {low:0.4, med:0.7, high:1}`（`default-intents.ts:24`）；
   `mapPercentThroughRange` 把相对量映射进 `[min,max]`（`policy.ts:222-228`）。所以 **high 档 = 11%/15% 绝对百分比**。
3. Coyote 原生换算：`percentToStrength = round(percent × 2)`，满量程 200（`backends/coyote/protocol.ts:169-172`）
   → 11%/15% = **原生 22/30 out of 200**。UI 读数 `0–22 / 200`、title `0%–11%` 与此完全一致
   （CDP report 实测 `hiMax=200, loMax=20, hiMin=2`，读数为 `0–22 / 200`）。
4. 真实审计最后一局 `c96ce5c0` 的 `plan_resolved.actions` 百分比：coyote:a ∈ {1,2,4,6,8,9,10,11}，
   coyote:b ∈ {1,3,5,6,7}——**全部 ≤ 各自软上限**，没有任何越权/隐藏缩放。11% 是唯一一次触顶（channel a），b 最高只到 7%。
5. 旁证（UI 误导的历史）：HEAD f3dfa25 的读数是 `0–22`（`git show HEAD:apps/desktop/src/ui/play.js:1174-1181`），
   **没有满量程参照**；用户看到“0–22”和运行中的“6%”很容易误判为强度坏了。本轮改成 `0–22 / 200` + title 百分比，
   这是正确的修复方向。

**两点必须补充的 nuance（否则最终答复不准确）**：

- **模型本身多数回合也在请求低档**：审计里的 1/2/3/4% 无法由 low/med/high（0.4/0.7/1.0）解释（a 的 low=4、b 的 low=6），
  说明模型写了较小的相对 `targetPercent`（例如 10→1%、20→2%、40→4%），或连续用了 low。
  所以“软上限 11/15”解释的是**天花板**，不是每个低值的唯一原因；模型动作强度也偏低（新 TURN_PROTOCOL 已提示 med/high，
  但没有强制/审计请求值）。
- **UI 单位仍混用（P2-8）**：右轨 live 强度条/数字与效果框显示的是**满量程绝对百分比**（`channel.percent`，如 6%），
  软上限行显示**原生 0–22/200**；两者都对但尺度不同（6% = 12/200 = 该通道上限 11% 的约 55%）。
  用户仍可能把“6%”理解成“6% 的上限”。另外默认策略 `maxPercent=20`（原生 40/200，`policy.ts:85-92`）对新用户也偏保守，
  属产品默认值决策，不是 bug。

**给 Lead 最终答复的建议措辞**：先给结论“主要原因是你的两个通道把强度上限设成了 11% / 15%（原生 22/30，满量程 200）；
模型 high 档也只能到 22/30，所以看起来一直很弱。把该通道『强度上限』滑杆拉高即可（UI 现在显示 `0–22 / 200`）”，
再补一句“另外模型有些回合只请求了更低的档位（审计实际下发 1–11%），不是只有上限问题；下一轮会让模型在推进/高峰用 med/high”。
不要只把原因归给用户，也不要暗示存在代码 bug（当前没有）。

### g) 全量门禁 / 覆盖

- 门禁：§0 已独立复跑（715/239、两包 tsc、esbuild、node --check 全过）。构建不写仓库产物（输出到 NUL）。
- **关键路径测试真实性（抽检全部通过）**：
  - 合并：`scenario-resolve.spec.ts:195/221/256/277`（body/duration/stop/旁路通道 + 字节稳定）。
  - 波形重试：`execution-executor.spec.ts:384/385/425`（一次成功事件、degraded/reason、二次失败 rejected）。
  - 续接：`play.spec.ts:1665/1703/1720`（hold 行存在、actor system、先于 plan、duration 有界、stop 清除、失败不阻断）、
    `:1352/:1370`（人类波形跨 start/dispose）。
  - 图表：`chart-math.spec.ts:80/94/109/143/170/191/213` + CDP 像素报告。
  - 默认波形：`scenario-resolve.spec.ts:621+`、`play.spec.ts` default-waveform 用例。
  - m2-e2e 按 actor 过滤 system 行（`m2-e2e.spec.ts:288/689`），避免 hold 污染 beat→command 时间线。
- **覆盖缺口**：hold 的 TTL/自然到期后多回合、human 直控续接、LOCKED/panic/pause 不复活、波形通道 hold；
  重试的非 waveform 错误/abort；merge 的 fallback 优先级与合并后 remainingBeats/probe；UI 单位一致性；
  真实 BLE 郊狼波形（P1-5 仍开放）。

---

## 3. 问题清单（严重度 / file:line / 证据 / 建议）

### P0

无。

### P1

**P1-1｜续接 hold 无 TTL、事件无 actor，可能无限续接（含人类直控）**
- 位置：`apps/desktop/src/main/play.ts:439`（lastDispatched）、`:1214-1305`（subscribe/noteDispatch/hold）、
  `packages/core/src/devices/events.ts:31-42`（DispatchEvent 无 actor）、`bootstrap.ts:1447`（人类直控 setLevel）、
  `play.ts:591/599`（pause/end → stop，会清空）。
- 证据/推理：`effect_finished` 不清 map；每回合都会 hold；无 TTL；人类直控同样写入 map（事件无 actor）。
  实机审计前没有 round2 运行，无法展示真实“复活”行；代码路径确定。
- 影响：叙述“放空/退出”时设备可能仍按上次 percent 动作；人类释放强度条后的限时输出会被 system 续接；
  与“plan 是唯一动作来源”的契约冲突（安全仍由 cap/LOCKED 兜底）。
- 建议：TTL（如 60–90s 或只桥接下一回合）+ 事件带 actor/仅记录 model + 测试覆盖；若产品接受当前语义，
  必须在交付说明中写成已知取舍。

### P2

| # | 问题 | 位置 | 证据/建议 |
| --- | --- | --- | --- |
| P2-1 | 去波形重试未限定错误类型：非 waveform 失败也重试，warning/reason 误报“waveform failed”；同一命令可能两条失败审计 | `executor.ts:383-403`；`registry.ts:947-960` | `execution-executor.spec.ts:425` 把 NOT_CONNECTED 写成 “waveform tide failed”；建议按阶段/错误码过滤 |
| P2-2 | 两次尝试之间无 abort 检查 | `executor.ts:388-403` | 第一次失败后 panic/preempt 已到仍会再跑 plain pattern；建议重试前 `isAborted(signal)` |
| P2-3 | 合并改变 probe/action/preemption 计数语义（被 superseded 的 beat 无 action/probe） | `intents.ts:192/228`；`executor.ts` noteProbeTarget | 文档已声明；测试把 probe 用例改成“不同通道”以保留旧断言，合并 turn 的 remainingBeats/probe 未覆盖 |
| P2-4 | duration 取 max 会拉长后置短动作，与新协议“短促动作 duration 短”矛盾 | `intents.ts:259-279` | `scenario-resolve.spec.ts:222` 期望 4s pattern 跑 40s；建议在文档/规则上明确取舍 |
| P2-5 | 末条 fallback/degraded 命令覆盖同通道精确命令，最终 status 可能变 degraded | `intents.ts:228-257` | 建议优先保留 exact（非 fallback）body 或至少在 warning 中标注降级来源 |
| P2-6 | 默认波形 = `pack.waveforms[0]`，规范无该字段（任意资产） | `play.ts:1007-1012`；`内容包规范.md` §4.5 | 建议 `pack.json.defaultWaveform` 或内置中性波形，并写进规范 |
| P2-7 | hold 用 steady max 重放，平均力度高于原 wave/pulse 包络（回合边界跳变） | `play.ts:1293-1310` | 原 envelope min≈0.35max；hold min=max=percent |
| P2-8 | UI 单位混用：live/效果框是满量程百分比（6%），软上限行是原生 `0–22/200` | `play.js:805-808`（live percent）、`:1169-1185`（readout） | 6% = 12/200 = 上限 11% 的 ~55%；建议标注“满量程”或统一相对上限显示 |
| P2-9 | 模型请求的相对强度未被审计：审计只记 resolved percent，1–4% 的真因难追溯 | `intents.ts:618/522`；plan_resolved detail | 建议 plan_resolved 带 requested strength/targetPercent（或效果框 title 显示档位） |
| P2-10 | 默认策略 `maxPercent=20`（原生 40/200）对新用户同样偏保守 | `policy.ts:85-92` | ui-v11 §3 已提；产品决策项 |
| P2-11 | hold 失败会经 registry `recordFailure` 写失败审计（actor system），审计尾部可能被刷 | `registry.ts:947-960`；`play.ts:1303` | m2-e2e 已过滤；外部工具需知道 |
| P2-12 | 测试缺口 | 见 §2g | hold TTL/自然到期/human 直控/LOCKED/panic/波形 hold；重试非 waveform/abort；merge fallback/remainingBeats；UI 单位；真实 BLE |
| P2-13 | 文档声明无法完全复核 | `analysis/ui-v11.md` §2 | 真实模型冒烟无产物（临时 dataDir 已删）；CDP 报告已核；§0 “实际下发 3–11%”实为 1–11%；README 链接的 `ui-v11.md` 目前是 untracked 文件（提交时需一并 add） |

---

## 4. 与交付判断

**可交付（真机回归除外）**，前提是 Lead 接受/写明 **P1-1 的续接语义**：
- 技术上：P0=0、门禁全绿、核心功能有真断言；合并/重试/默认波形/图表均按用户反馈工作。
- 产品上：P1-1 会让“输出”在模型思考期继续，且可超出单次 plan 的生命周期（仍受人类 cap/ceiling/LOCKED 约束）；
  这是用户明确想要的“别停”，但需要明确“续接上限/结束条件”，否则用户可能遇到“叙述说停但设备还在动/人类直控释放后仍在动”。
  最低成本处理：交付说明写清“思考期最多续接 30s/回合，stop/暂停/急停/结束立即清空；人类直控也会被续接”；
  建议下一轮按 §3 的 TTL + actor 过滤收口。
- 真机回归必须做：真实郊狼 BLE 波形（v10 后仍未验证）；本轮 round2 尚未在真实进程跑过（最新 audit 仍是 v10 构建）。

**给用户的最终答复（关于强度）**：认可 Lead 的判断方向，但建议按 §2f 的措辞加两句 nuance（模型亦常请求低档；
旧 UI 缺满量程参照已修；live 百分比仍是满量程百分比）。没有发现“代码偷偷压强度”的证据——“低”来自
`state/policy.json` 的 11/15（原生 22/30 of 200）与模型请求值，而非隐藏 bug。

---

## 5. 复核记录

- 复核范围：`git diff`（HEAD f3dfa25 → 工作区）+ 2 个新文件 + `analysis/ui-v11.md` 声明核对 + 本机 audit 最后一局
  `c96ce5c0`（真实强度/重复/空窗/波形证据）+ `.ui-shots/t7-wave/report.json`（图表像素断言）。
- 未修改任何源码；唯一写入本文件。
- 门禁复跑（core 715 / desktop 239 / 两包 tsc 0 / esbuild 0 / node --check ok）见 §0。

---

## 6. P1-1 / P2-1 修复复核（delta，2026-11-03 12:24–12:35）

> Lead 已按 §3 建议修复 P1-1（hold 的 TTL/actor/人类直控）与 P2-1（去波形重试错误分类/abort）。
> 本轮只复核增量；HEAD 未变、未 commit；diff 16 files **+1268/−101**，源码 mtime ≤12:22。
> 独立门禁：**core 52 files/717 tests、desktop 18 files/243 tests、两包 tsc 0、esbuild main/dev-server 0、
> `node --check` play.js/chart-math.js ok**（与 Lead 数字一致）。

### 6.1 P1-1（holdContinuity）— ✅ 闭环

实现（`play.ts`）：
- `lastDispatched` 记录 `{percent, waveformId?, at, durationSec?}`（`:456-461`），事件只在
  `executor.dispatch` 包装窗口（`modelDispatchActive`）内记录（`:1014-1021`、`:1285`）；窗口外的人类直控 / 宿主自身 hold 不进入记忆。
- `stop` 在 actor 过滤**之前**无条件清除（单通道或 `all`）（`:1277-1281`），所以 model/human/pause/panic/end 的 stop 都能清空。
- `holdContinuity` 双门槛（`:1337-1370`）：TTL `90s`（`:137`）；若上一条命令自身 duration 仍覆盖 >6s 的思考窗口
  （`remaining = at + duration − now > 6s`）则跳过（不重复/不拉长）；仅对 ready 通道、last.percent>0 重发 bounded ≤30s。
- 人类直控不再被重放（窗口外 `noteDispatch` 直接 return，测试 `play.spec.ts:1763` 用真实 `registry.setLevel('human')` 验证）。

测试真实性（新增/更新，`play.spec.ts`）：`holds the last output…`（`:1670`，先推进 4s 让旧效果过期再验证 hold 先于 plan）、
`does not restart an effect that still covers the think time`（`:1728`，60s 效果 → 0 hold；3s 效果 + 4s → hold）、
`does not revive a plan output older than the TTL`（`:1750`，91s → 0 hold）、`does not replay human direct control`（`:1763`）、
`holds a waveform channel with a steady pattern`（`:1788`，run_pattern + waveformId + duration 30）、
`never blocks the turn when a hold command fails`（:1810 附近）。**真断言，覆盖了上轮 §3 指出的 TTL/人类直控/波形 hold 缺口。**

残留（均为 P2，不阻断）：
- **R1**：`modelDispatchActive` 是单个 boolean；若人类直控恰好发生在模型 dispatch 窗口内（毫秒级窗口，autopilot 下
  理论上可能并发），该事件会被误记为 model 输出并在后续回合 hold。根治需给 `DispatchEvent` 加 actor 或从 executor
  结果（而非 registry 事件）记录；当前概率极低，记录为残余风险。
- **R2**：6s 门槛是“思考时间 ≤6s”的启发式；若上一效果剩余 6–10s 而模型某次特别慢（>剩余），空窗仍会出现几秒。
  若要更强连续性，可在 `effect_finished` 到达且当前 turn 仍在模型调用时补一次 hold（或提高门槛但限制只续一次）。
- **R3**（上轮 P2-7 未变）：hold 用 `steady, min=max=last.percent` 重放，平均力度高于原 `wave/pulse` 包络，
  回合边界可能有可感知的力度跳变。
- **R4**：TTL 90s 是产品参数；超过 90s 未再规划的输出不复活（符合“叙述可能已写放开”的取舍），但用户若希望
  更长/更短需后续配置化。

### 6.2 P2-1（去波形重试）— ✅ 闭环

实现（`executor.ts`）：
- 首次带波形 `runPattern` 抛错后先 `isWaveformStageFailure(error)` 判断（`:509-523`）：仅
  `UNKNOWN_WAVEFORM` / `WRONG_CHANNEL_KIND` / **无 code**（backend 写入类未分类错误）才继续；
  `NOT_CONNECTED`/`LOCKED`/`INVALID_POLICY` 等直接 rethrow → 外层 rejected（不再误报 waveform、不再重复尝试）。
- 重试前 `isAborted(signal)` 检查（`:392-400`）：已 abort 则不再发第二次 registry 调用，返回 rejected（原错误），不发
  “retrying as a plain pattern” warning。
- 第二次仍失败才 rejected；成功仍然 `status:'degraded'` + reason + warning。

测试（`execution-executor.spec.ts`）：`:425`（第二次也 UNKNOWN_WAVEFORM → `runPatternCalls===2`、rejected、
warning 含 waveform failed）；`:496`（NOT_CONNECTED → 仅 **1** 次 run_pattern、无 “waveform failed” warning）；
`:530`（第一次 UNKNOWN 后 abort → 仅 1 次调用、rejected、无 retry warning）。**覆盖到位。**

残留（P2）：
- **R5**：`code === undefined` 仍按 waveform 阶段重试；若未来 registry 在非波形阶段抛无 code 错误，会被误重试一次
  （当前 registry 的 safety 错误均带 code，风险低；建议在 executor 侧用阶段标记替代“无 code”推断）。
- **R6**：重试成功仍会留下 registry 的一条失败审计（`recordFailure`）+ 一条成功审计；审计消费方需按
  `degraded`/warning 理解“恢复”，不是 bug，但仍是噪音。
- **R7**：abort 分支返回 `rejected` 而不抛错；若这是本回合最后一条命令，`dispatch()` 的 `preempted` 仍为 false
  （审计 `plan_resolved` 不标 preempted），与 abort 语义略有出入；影响仅审计，建议后续把“命令内 abort”也计入 preempted。
- **R8**：`WRONG_CHANNEL_KIND` 与“无 code”两条重试分支缺少直接单测（当前由分支逻辑与第一次 UNKNOWN 用例覆盖）。

### 6.3 最终结论（更新）

- **P1-1、P2-1 均已闭环**：原 P1（跨回合无限续接 / 人类直控重放 / 无 TTL）与 P2（非波形错误被重试、无 abort 检查）
  都有实现 + 真断言测试；**无新 P0、无新 P1**。新增/残余只有 P2（R1–R8）与 §3 原有的 P2（合并语义/默认波形/UI 单位/
  模型请求强度不可审计/默认策略 20%/真实 BLE 未验等）。
- **最终判定：可交付（真机回归除外）。** 两处修复把上轮唯一的 P1 与最相关的审计正确性 P2 收口；剩余 P2 均为
  取舍/体验/可观测性，不阻断。交付前仍需：真实郊狼 BLE 波形回归 + round2/round3 在用户真实进程里跑一局
  （当前最新 audit 仍是 v10 构建 08:44–08:47，修复后的版本尚未在真实会话产生审计行）。
- 文档：`analysis/ui-v11.md` 12:24 已同步本次补丁（TTL/门槛/仅 model 记录/错误分类），与本 delta 实现一致；
  其真实模型冒烟仍无可复核产物（临时 dataDir 已删），只能作为作者口述。
