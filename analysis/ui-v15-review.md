# ui-v15 快速复核：柱状图柱距按波形频域归一化

> 复核员：reviewer（task-25），只读。基线 **HEAD = 363826b（v14）**；对象 = 工作区未提交 v15 diff
> （4 files **+125/−49**：`chart-math.js` + `chart-math.spec.ts` + README/前端设计文档）。唯一写入本文件；未改代码/未 commit。
> 证据：独立门禁 + `.ui-shots/t20-chart-density/report.json` + 截图 + 代码/测试阅读 + `computeBars` 行为推演。

---

## 0. 门禁（独立复跑）

| 检查 | 结果 |
| --- | --- |
| desktop `vitest run` | **18 files / 256 tests passed** |
| desktop `tsc --noEmit` | exit 0 |
| `node --check chart-math.js` / `play.js` | ok |
| esbuild `main/index.ts` / `dev-server.ts`（NUL） | 均 exit 0 |
| CDP `.ui-shots/t20-chart-density/` | report + 5 截图；canvas 300×34，tide/cilia gapRange **3–22px**、barColumns `[2]`、height 3–31、rowOverflow 0、无 page/console error |

（core 本轮未改，未复跑；desktop 门禁与 Lead 数字一致。）

---

## 1. 结论速览

- **P0：0 项。**
- **P1：0 项。** 归一化实现正确：min/max 按本帧 freq、min→22/max→3、恒定→13、非有限/空/单点均有保护；柱宽/柱高/phase/右→左未回归。
- **P2：约 5 项**（证据/文档口径、绝对频率尺度丢失、窄域放大/帧间跳变、测试覆盖、CDP 用合成 preview）。
- **判定：可交付（真机回归除外）**；P2 均不阻断，建议下一批补真实资产频率范围测试与窄域阈值/帧间平滑的产品决策。

---

## 2. 逐项复核（a–f）

### a) 归一化正确性与边界

- 实现（`chart-math.js:53-65/84-103`）：先扫 `freq[0..count-1]` 的有限 min/max；`spacingFor(freq, low, high)`：
  - `high <= low` → `CONSTANT_SPACING=13`（不做除零）；
  - `value = clamp(finiteOr(freq, low), low, high)`；`22 - (value-low)/(high-low)*19` → 低 22px、高 3px。
- **边界**：空数组/长度不一致 → `count=0`；width/height≤0 → `[]`；整帧无非有限值 → low=high=0 → 恒定 13；单个有限点 → 恒定 13；NaN 采样点不参与 min/max，单点 fallback low；空/长度不一致/NaN 在 `chart-math.spec.ts:246` 有真断言。**未发现除零、NaN、负数/越界间距。**
- **phase**：`offset=((phase%cycle)+cycle)%cycle`；spacing 最小 3，cycle>0；无零周期。`phase` 非有限 → 0。
- **间距范围**：value clamp 后公式输出严格 ∈[3,22]；没有额外 clamp 也不会越界。
- **结论**：正确；**没有单点/空/非有限边界问题**。

### b) 回归（柱宽/柱高/phase/右→左/换波形）

- 柱宽仍固定 `BAR_WIDTH=2`；柱高仍 `heightFor(intensity, height)`（不读通道 percent/strength）；测试 `:94/:109` 真断言；right-to-left 的 x 走向与 `Math.round(x)` 未变。
- phase：`cycle` 现在按本帧 spacing 求和；测试 `:203` 用恒定 13 → cycle=130，验证 +5px 平移、±cycle 取模、确定性；**通过**。
- 换波形：UI `play.js` 的 preview cache 按 `waveform.id` 取 `/api/waveforms/preview`，`drawWave` 每帧把当前 preview 的 `freq/intensity` 交给 `computeBars`；换 id 会取新 preview 并重算，逻辑未改。**未发现回归。**
- 唯一回归观感：旧的 `uniform(10,10)`/`uniform(10,240)` 测试标题还写“sparse/dense”，但两者现在都是恒定频率→13px；测试只断言柱宽/高度，不断言密度，标题略过时（P3 文案）。

### c) 真实波形频率（cilia/tide/climb）

- 新测试 `:178` 的 “real pack frequency ranges” 实际用**硬编码合成数组**：`[50,56,62,68,74,80]`、`[25,34,43,52,61,70]`、`[90,106,122,138,154,170]`；不是从 `WaveformLibrary`/内容包 preview 读取。公式上这些数组确实会得到 3–22px，但测试没有证明仓库/用户包的实际资产范围就是这些。
- **P2-1 证据/文档不一致**：仓库内置 `climb` 的脚本是 `freq: {from:90, to:18}`（`builtin.ts:120-126`），**实际范围 18–90，不是 90–170**；`ui-v15.md`/前端设计却写“climb（内置）90–170”，并把 90–170 当成实测范围。若用户包另有 `climb` 90–170，需要注明来源；否则该行是错误证据。建议加一条从真实 `WaveformLibrary`/`createBuiltinWaveforms()` 读取 frames 的测试，或注明“合成数组”。
- **CDP** 的 tide/cilia 是 CDP 脚本里手写的 `PREVIEWS`（tide 25–70、cilia 50–80），不是真实后端 preview；像素结果真实，但“真实波形”证据仍是合成的。

### d) 测试与 CDP

- `chart-math.spec.ts` **8 tests**，用 `node:vm` 执行真实 classic script（不是 grep 源码），对 x/width/height 做几何断言；正常/边界有真断言，**质量合格**。
- 缺口（P2）：
  1. 只有恒定频率的 phase 循环测试；**没有 variable-spacing 的 phase 平移/取模/右→左**测试（虽然逻辑未变，回归风险）；
  2. 边界测试的 `odd` 实际 `count=1`（intensity 长度 1），没有覆盖“混合有限/非有限 freq + 多柱”的 min/max 跳过路径；
  3. 没有按真实 preview 数据（例如 `createBuiltinWaveforms()` 的 frames）断言 3–22；
  4. UI 的切换波形/预览 cache/每帧重算没有 vitest，只有 CDP 手写脚本。
- **CDP 真实性**：`.ui-shots/t20-chart-density.mjs` 用真实 index.html/play.js/chart-math.js + stub 宿主/预览；report 的 `gapRange 3–22`、`barColumns [2]`、`heightRange 3–31`、无 overflow 与截图一致；**是真实 UI 渲染证据**，但 preview 频率是合成的（见 c）。

### e) 产品/性能风险

- **性能**：每帧对 preview 的 freq 数组做一次 O(n) min/max（n 最多约 64 个 slot），再 O(n) 生成 bars；canvas 300px、60fps 下开销可忽略。**无性能风险。**
- **P2-2 绝对频率尺度丢失**：归一化后“同一 freq 在不同波形里柱距不同”，同一波形内能看到疏密；但**恒定频率波形一律 13px**（如恒定 240 也显示中密，而非最密），跨波形无法比较绝对频率。ui-v15 限制 #2 已承认；建议在交付说明/产品答复中讲清“这是波形内相对纹理，不是绝对频率读数”。
- **P2-3 窄域放大/帧间跳变**：若某帧 freq 只在 78–80 轻微抖动，也会被放大成 22↔3 的强对比；帧 min/max 变化时柱距会整体跳变，没有最小频率域阈值/平滑。ui-v15 限制 #1 已承认；建议产品决定是否加 `range<5 → 13px` 或平滑，当前按“看得出疏密”优先，**不阻断**。
- **P2-4 视觉柱数变化**：spacing 变密后同一宽度显示更多柱，旧视觉的柱数/密度会变化；用户要求就是更密，正常。

### f) 门禁

- desktop 256 / tsc 0 / node --check / esbuild main+dev-server 均通过（独立复跑，与 Lead 一致）；diff 4 files +125/−49（仅 UI 图表 + 文档 + 测试，无 host/core 改动）。
- 真实 Coyote BLE / 真实进程整局仍未回归（与本轮无关）。

---

## 3. 问题清单

### P0

无。

### P1

无。

### P2

**P2-1｜“真实波形范围”的证据/文档不准确**
- `ui-v15.md`、`前端设计.md` 写“climb（内置）90–170”，但仓库内置 `climb` 是 `from:90,to:18`（18–90）；测试用硬编码合成数组，CDP 用脚本内 `PREVIEWS`，不是真实 preview。
- 影响：结论“真实波形 3–22px”只证明了公式对合成数组成立，不是从真实资产取数；文档具体数字可能误导。
- 建议：测试从 `createBuiltinWaveforms()`/真实 pack frames 取 freq 断言；文档注明合成/真实来源，或修正 climb 范围。

**P2-2｜绝对频率尺度丢失（恒定频率一律 13px）**
- 归一化按帧 min/max，恒定频率波形固定 13px；同一 freq 在不同波形中密度不同，跨波形不能比较绝对频率；ui-v15 限制 #2 已承认。
- 影响：用户若拿“恒定高频波形”与“恒定低频波形”对比，会看到同样 13px，可能再次感觉“没有频率越高越密”；但这是“波形内可见疏密”的取舍。
- 建议：交付说明明确；若产品要求绝对感，可对恒定/窄域帧回退一个绝对映射或显示频率值。

**P2-3｜窄域放大与帧间跳变**
- 78–80 的轻微 jitter 会被拉满 22↔3；帧 min/max 变化会导致整帧柱距跳变；ui-v15 限制 #1 已承认，无最小域阈值/平滑。
- 建议：产品决定是否加 `range<5 → 13px` 或跨帧平滑；当前不阻断。

**P2-4｜测试覆盖缺口**
- 只有恒定 spacing 的 phase 测试；没有 variable-spacing phase/右→左回归；`odd` 边界实际 count=1；没有真实 preview 数据的测试；UI 切换/缓存无 vitest。
- 建议补 1 条 variable-spacing phase + 1 条真实 builtin frames；其余可 CDP 保留。

**P2-5｜CDP 使用合成 preview**
- 真实 UI/像素证据可信，但不是真实 `/api/waveforms/preview` 数据；与 P2-1 同源。建议在报告中标注“合成 preview”，或接真实 stub 资产。

### P3

- `chart-math.spec.ts:94` 的“sparse/dense”测试标题已过时（两个 uniform 现在都是恒定 13px，只测柱宽/高度）。
- `CONSTANT_SPACING=13` 注释说“12–14 中间值”，实际 13 不在精确中点 12.5；无功能影响。

---

## 4. 复核记录

- 只读复核：`git diff`（HEAD 363826b → 工作区，4 files +125/−49）+ `analysis/ui-v15.md` + `.ui-shots/t20-chart-density/`；未改源码，唯一写入本文件，未 commit。
- 独立门禁：desktop 18/256、tsc 0、esbuild main/dev-server 0、`node --check` chart-math.js/play.js ok。
- 行为推演/核对：空、单点、非有限、恒定、窄域、宽域、phase、右→左、柱宽/柱高；CDP report 与截图对照。
- **最终：P0=0、P1=0，可交付（真机回归除外）**；P2 为证据/文档/产品取舍/测试缺口，不阻断。
