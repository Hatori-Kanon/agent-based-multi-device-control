# ui-v17 对抗复核：柱距按物理脉冲周期（1–100Hz）

> 复核员：reviewer（只读）。基线 **HEAD = d02cf62**；对象 = 工作区未提交 v17：`chart-math.js`、`chart-math.spec.ts`、`play.js`（仅注释）、`README.md`、`前端界面设计.md` §14.3/§21、`analysis/ui-v17.md`，以及 `.ui-shots/t22-chart-physical/` 证据。
> **复核期间工作区被并发更新**：`chart-math.js` 23:47:28 后未变；`chart-math.spec.ts` 23:51:47、`前端界面设计.md` 23:51:58、`analysis/ui-v17.md` 23:52:49 有更新。本报告以 23:55 的最终状态为准；关键门禁在最终测试文件上重跑。
> 快照哈希：`chart-math.js 0c947141…`、`chart-math.spec.ts 34876390…`、`analysis/ui-v17.md 163de41d…`、`README.md 30d2fb05…`、`前端界面设计.md 9690bdad…`。
> 唯一写入本文件；未改源码/测试/文档，未 commit，未触碰 `deliverables/content-pack-kit/`。CDP 未重跑（只读；且证据脚本的 expected 仍是旧值），用 Node/vm + 既有 `report.json`/截图核对。

---

## 0. 结论

| 项 | 结果 |
| --- | --- |
| **P0** | **0** |
| **P1** | **0** |
| **P2** | **4**（P2-1 证据、P2-2 文档、P2-3 测试强度、P2-4 低频口径） |
| **判定** | **可交付（代码/功能）**；P2 的文档/证据数字与测试强度不阻断代码，但对外引用前应修 |

核心判断：映射数学正确。`periodMsForCode` 与 core `frequency.ts` 在 12 个抽点（含 101/200/201 边界）上逐点一致；`spacingFor` 的端点、半像素、方向、0/NaN/非法码行为均符合 v17 规格；v16 的反向映射被单调性、对表、真实资产三层测试挡住。未发现 P0/P1 代码缺陷。

---

## 1. 映射数学：12/12 与 core 一致，端点/方向/fallback 正确

### 1.1 逐点对表

独立探针在 vm 中加载真实 `chart-math.js`，仅把内部函数暴露到同一 IIFE 的返回值上（**未写文件**），与 `packages/core/src/backends/coyote/frequency.ts` 的 `codeToHz` 对比：

```
code  chartPeriod  corePeriod  chartSpacing  expectedSpacing  hz
10    10           10          1             1                100.00
11    11           11          1             1                90.91
25    25           25          2.5           2.5              40.00
50    50           50          5             5                20.00
99    99           99          10            10               10.10
100   100          100         10            10               10.00
101   105          105         10.5          10.5             9.52
110   150          150         15            15               6.67
150   350          350         20            20               2.86
200   600          600         20            20               1.67
201   610          610         20            20               1.64
240   1000         1000        20            20               1.00
MISMATCHES 0
```

- `chart-math.js:62-67` 的 `periodMsForCode` 与 `frequency.ts:66-71` 是同一张分段表：`v≤100 → v`、`101–200 → 100+(v-100)*5`、`201–240 → 600+(v-200)*10`；`clamp` 边界也一致（`frequency.ts:48-52` 非有限值按 10，chart 的 `periodMsForCode` 对非有限值有限化后同样落到 10）。
- `chart-math.js:78-83` 的 `spacingFor`：`round((period/10)*2)/2`，再 `clamp(1,20)`，与规格 `clamp(1,20, round((periodMs/10)*2)/2)` 完全一致。

### 1.2 端点与方向

按实际计算（不是文档抄写）：

| 码 | 物理频率 | 柱距 |
| --- | --- | --- |
| 10 | 100 Hz | **1 px** |
| 20 | 50 Hz | **2 px** |
| 25 | 40 Hz | **2.5 px（半像素）** |
| 50 | 20 Hz | **5 px** |
| 80 | 12.5 Hz | **8 px** |
| 100 | 10 Hz | **10 px** |
| 110 | 6.67 Hz | **15 px** |
| 120 | 5 Hz | **20 px** |
| 240 | 1 Hz | **20 px（clamp）** |

方向正确：码 10（100Hz）1px 最密，码 120（5Hz）20px 最疏，码 240（1Hz）仍是 20px；码增大 → 物理频率降低 → 柱距单调不减。v16 的 `200/码` 在码 10 给 20px、码 240 给 1px，正好相反，已被 v17 修正。

### 1.3 0/NaN/非法码与边界安全

同一探针的边界输出：

```
spacingFor: 0=20 1=20 9=20 9.5=20 10=1 -5=20 NaN=20 Infinity=20 -Infinity=20 1000=20 '50'=20 null=20 undefined=20
periodMsForCode: 0=10 1=10 9=10 9.5=10 10=10 -5=10 NaN=10 Infinity=10 -Infinity=10 1000=1000 '50'=10 null=10 undefined=10
```

- `spacingFor` 先用 `finiteOr` + `value >= MIN_FREQ_CODE` 拦截 `<10`/非有限/非 number，直接返回 20px（`chart-math.js:79-80`），不会把 NaN 带进 `cycle`/`x`。
- `periodMsForCode` 对 `<10`/非有限值按边界夹到 10ms，但它只在 `spacingFor` 的合法分支里被调用；`spacingFor(0/NaN/5)` 实际不会走这条夹紧路径，因此“period 夹到 10ms”与“柱距 fallback 20px”的差异是**有意的安全 fallback**，不是不一致。
- 码 >240 或 `1000` 一律 20px；`-Infinity`/字符串/`null` 不崩。未发现 NaN、负间距、零周期。

### 1.4 物理口径的残余（P2-4）

- 码 120–240（5–1Hz）全部 20px，**1–5Hz 在图上不可区分**。这是 `period/10` 线性映射 + 20px 上限的必然结果；`analysis/ui-v17.md:92-93` 已披露。若验收要求严格“1–100Hz 都可辨”，需要改成对数映射（该文档也给了 1Hz→20、10Hz→10.5、100Hz→1 的备选），这是产品决策，不是当前实现的算术错误。
- `analysis/ui-v17.md:70` 的历史对照写“v16 tide 4.5–20px”是**算错**：v16 公式 `round((200/42)*2)/2 = round(9.5238)/2 = 5`，应为 **5–20px**（同文 `:25` 写的是 5–20）。这是 P3 文档小错。

---

## 2. 测试：真行为断言，v16 反向回归覆盖；有测试强度缺口（P2-3）

`chart-math.spec.ts` 现在 **10/10**（独立重跑见 §6）。测试用 `node:vm` 执行整份 classic script，不 grep 源码；对 `computeBars`/`upsampleLinear` 的 x/width/height 做几何断言。

覆盖点（逐条对应）：

- 1px 柱宽、不随 spacing 变粗：`:125-138`。
- 柱高只随 intensity，额外 `level/percent/strength` 不改变输出，右→左顺序：`:140-172`。
- 物理周期映射与端点：`:174-237`（10→1、20→2、40→4、50→5、80→8、100→10、110→15、120→20、240→20；25→2.5；方向；单调性；0/NaN/5 fallback；窄域/宽域）。
- 与 core `codeToHz` 对表：`:239-247`（12 个码，含 101/200/201/240）。
- 真实资产：`:249-288`（pack 0.4.0 的 cilia/flutter 真实 freq slice；builtin breathing/tide/climb 直接从 `createBuiltinWaveforms()` 编译结果取 slot；`breathing < tide < climb`）。
- 升采样 2x/4x、空/NaN：`:290-310`。
- phase 取模/平移/负数/确定性：`:312-331`。
- 高度上限/画布太矮：`:333-353`。
- 空/长度不一致/非有限：`:355-375`。

**v16 反向回归确实被覆盖**：v16 下码 10→20px、码 240→1px；当前 `:177`（10→1）与 `:196-201`（单调不减）会立刻失败；`:239-247` 对表在码 10 会差 19px；`:280`（breathing ≤1.01）在 v16 下是 20px。不存在“v16 也能绿”的路径。

发现的测试强度缺口（不影响当前实现正确性）：

1. **对表断言是 ±1 容差，不是严格逐点**：`:243-245` 用 `Math.abs(actual-expected) <= 1`；整数 x 取整确实需要 ±1，但可以用 `mean(gaps(...))` 做精确到 0.01 的断言。码 101/99 若差 1px 仍会通过。
2. **201–240 段被 20px clamp 吃掉**：`expected` 和 `actual` 都是 20，第三段斜率写错也测不出来；`150/200/201/240` 都不能区分第三段。实现本身已被本次独立探针核对为 610/1000ms，但测试的“逐点对表”对这一段是空断言。
3. **中间码（如 90）没有精确断言**：端点覆盖 80/100，`monotonic` 只保证顺序；若只把 81–98 映射错 +1px，所有现有断言（含 climb 的 `mean ≤ 10`）可能仍然通过。建议加 90→9 或对每个分段取均值精确断言。
4. **真实 pack slice 是硬编码**：cilia/flutter 的 freq 来自外部 `%APPDATA%/…/tentacle-shadow/0.4.0`，仓库里没有该资产；CI 上只能靠硬编码快照，不是自包含真实读取。intensity 数组也是手写的（只影响高度，不影响 gap 断言）。
5. **没有“真实资产 + 2x 升采样”的单测**：`:249-288` 用原始 slot，UI 实际先 `upsampleLinear(...,2)`；CDP 覆盖了这一点，但单测层没有。
6. **phase 测试仍是恒定 spacing（码 40 → 4px）**，没有 variable-spacing 的 phase 平移/取模；这是 v15 复核就提过的旧缺口，本轮逻辑未变，风险低。
7. **当前版没有显式的 `mean(flutter) > mean(cilia)`**：保留了 `breathing < tide < climb`，但 cilia 5–8 与 flutter 7–10 有重叠；建议补均值比较以固定“低频更疏”的跨资产方向。

---

## 3. 其它规则：未回归

`git diff -- apps/desktop/src/ui/play.js` 只有注释（`:1041-1049`）；绘制/取数逻辑未动（`:1051-1085`）。逐项核对：

- **柱宽**：`BAR_WIDTH = 1`（`chart-math.js:32`），输出字段只有 `x/width/height`；测试 `:125-138`。
- **柱高**：`heightFor` 只读 intensity，`round(intensity/100*(height-3))`、最小 1px（`:85-90`）；测试 `:140-172`。
- **phase**：`finiteOr` + 双重取模（`:155-157`）；cycle 由新 spacing 求和，正数；测试 `:312-331`。
- **右→左**：起点 `width - BAR_WIDTH - offset + cycle*ceil(...)`，`index = count-1`，逐步减 spacing（`:159-175`）；柱高顺序测试 `:170-171` 验证最右用最后一个采样点。
- **2x 升采样 / canvas**：`upsampleLinear` 未变（`:92-125`）；`WAVE_UPSCALE=2`、`WAVE_DEVICE_SCALE=2`、`WAVE_CANVAS_HEIGHT=34`（`play.js:41-44`）；`syncLiveWaveSize` 仍是 `cssWidth*2 × 68`（`:1031-1038`）；`ctx.setTransform(2,0,0,2,0,0)` 后按 CSS 逻辑尺寸计算（`:1058-1061`）。
- **旧宿主无 preview**：`preview === undefined || EmbodiedChartMath === undefined` 时画基线并 return（`:1064-1073`），未变。
- **性能**：`computeBars` 的循环次数约为 `width/minSpacing + cycle`，spacing 最小 1、cycle 有限（count×≤20）；最密 100Hz 时宽度 310/390 的每个通道每帧约 310/390 根柱，2 通道 60fps 约 4–5 万次 `fillRect/s`，属正常量级，未发现无界循环或每帧 O(n²)。

**非本轮引入的残余**：`drawLiveWave` 的 preview 按 waveform id 取（`play.js:1064`），是波形原始 slot；通道的 `minFreq/maxFreq` 频带在设备下发时由 core 的 `clampWaveformFrequency` 重映射，但图表没有按该频带重算。若玩家把频率软上限收窄，图表密度与真实输出会不一致。这是 v16 以前就存在的显示口径问题，不是 v17 引入，但值得后续产品确认。

---

## 4. 文档/说明：端点正确，数字有 P2/P3 不一致

### 4.1 正确的部分

- `README.md:9`（v17 段）与 `README.md:48-49`（通道实时预览）：协议码→周期→`period/10`、1–20px、100Hz→1px、20Hz→5px、10Hz→10px、≤5Hz→20px、0/非有限/非法码 fallback 20px；与实现一致。
- `README.md:261-262` 测试数 753/258；独立复跑一致。
- `前端界面设计.md:590-594`（§14.3）：分段表、物理 1–100Hz、端点、fallback 与实现一致。
- `前端界面设计.md:752-756`（§21）：端点 100/50/20/10/5Hz 与实现一致；tide 1–4px 与本次 Node 抽样一致。
- `analysis/ui-v17.md:43-53` 的映射表（10→1、20→2、25→2.5、50→5、80→8、100→10、110→15、120→20、240→20）与实现一致；`:67-71` 的 Node 列（cilia 5–8、flutter 7–10、climb 2–9、tide 1–4）与本次独立抽样一致。

### 4.2 P2-1：证据 `report.json` / 生成脚本的 tide 仍是旧数字，且测量口径混淆

- `.ui-shots/t22-chart-physical/report.json:9`：`builtin:tide` expected 写 **1–7px**；实际真实 tide 码 10–42 → **1–4px**（Node 抽样见 §5；同文 `analysis/ui-v17.md:70` 也已改为 1–4）。这是报告生成于 23:49、测试/文档 23:51–23:52 才修正造成的**陈旧证据**。
- `.ui-shots/t22-chart-physical.mjs:3` 注释仍写 `tide 2–7`，`:258` expected 仍写 `1–7px (tide min 2.5 -> 2-3)`；重跑会继续产出错误期望。
- `report.json:96-104` 的 `barColumnsDevice [2,4,52]`、`barWidthCss [1.006, 2.013, 26.17]` 不是“柱宽变 26px”，而是 tide 高频段 1px 柱距 + 1px 柱宽**相邻 26 根柱连成 52 device 列**的合并 run；`report.json:106-114` 的 `gapRangeCss [2.01, 27.18]` 也因此混入了 27.18（52+2 device 列 / 1.987）的合并块跨度，不能当作 spacing 范围引用。`analysis/ui-v17.md:74` 的“柱宽全部 2 device 列 = 1 CSS px”只对单根柱成立，与 report 的 52 列 run 并列时容易误读，建议注明“52 列 = 26 根相邻 1px 柱合并”。
- 结论：代码/截图本身没问题；**报告与生成脚本需要重跑或改注**后再作为交付证据引用。

### 4.3 P2-2：`analysis/ui-v17.md:85` 把“测试断言上限”写成了真实范围

该行写“真实资产（… tide 1–5、climb 2–10）”。实际：

- tide 真实码 10–42 → **1–4px**（测试 `:281-282` 的 `≥1、≤5` 是宽断言，不是实测范围）；
- climb 真实码 18–90 → **2–9px**（测试 `:283-284` 的 `≥2、≤10` 同理）。

cilia 5–8、flutter 7–10 是准确的。建议改成“测试断言范围 tide 1–5 / climb 2–10；实测 tide 1–4 / climb 2–9”，避免读者把上限当实测。

### 4.4 P3 的文档细节

- **P3**：`analysis/ui-v17.md:70` 的 v16 tide 4.5–20px 应为 **5–20px**（v16 `200/42` 经半像素 `round` 得 5；同文 `:25` 已写 5–20）。
- **P3**：`前端界面设计.md:755` 写“Node + CDP”：cilia 5–7 / flutter 7–9 是 **CDP 单帧可见范围**；Node 全范围是 5–8 / 7–10（`analysis/ui-v17.md:67-68`）。建议注明“CDP 快照”或分别列 Node/CDP。
- **P3**：`前端界面设计.md:761` 验收写“码越大柱距越大”，但码 120–240 都是 20px（clamp），应写成“柱距不减/单调不减”。
- **P3**：`前端界面设计.md:757` 与 `analysis/ui-v17.md:74` 的“柱宽全部 1 CSS px / 2 device 列”是单根柱的 nominal 值；tide 的 52 列 run 是相邻柱合并，不是柱宽回归（见 P2-1）。

### 4.5 文档对“测试逐点对表”的表述偏强

`analysis/ui-v17.md:84-85` 写“与 core codeToHz 分段表逐点对表”，但测试 `:243-245` 是 ±1 容差，且 201–240 段被 clamp 吸收（见 §2）。实现本身已由本次独立探针核对为 610/1000ms，但文档应加“±1 容差 / 第三段被 clamp”限定，或补更严格的测试。

---

## 5. 独立抽样：真实 preview 数组的柱距

用与 `.cache/build_previews.mjs` 相同的 payload 结构（真实 `previews.json`，来自 `.ui-shots/t22-chart-physical/previews.json`），在 vm 中执行真实 `chart-math.js`，对 `upsampleLinear(...,2)` 后的数组在 8 个 phase（0/37/100/250/500/777/1000/2000）上取 `computeBars` 的相邻 x 差：

| 资产 | 协议码 | 原始/2x spacing | 8 phase 观测 x-gap | 2x cycle |
| --- | --- | --- | --- | --- |
| builtin:breathing | 10 | 1 | 1 | 96 |
| builtin:tide | 10–42 | 1–4 | 1–4 | 456.5 |
| builtin:climb | 18–90 | 2–9 | 2–9 | 657 |
| pack:cilia-tickle | 50–80 | 5–8 | 5–8 | 611 |
| pack:flutter-suck | 70–98 | 7–10 | 7–10 | 664.5 |

与 `analysis/ui-v17.md:67-71` 的 Node 列完全一致；与 `report.json` 的 CDP 单帧可见范围（cilia 5.03–7.05、flutter 7.05–9.06、climb 2.01–9.06）也不矛盾（单帧只显示窗口内的一段，所以比全数组窄）。tide 的全数组是 **1–4**，再次说明 `report.json:9` 的 1–7 与 `.mjs:258` 的 1–7 是旧值。

---

## 6. 门禁（独立复跑）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 专项测试 | `cd apps/desktop && node ../../packages/core/node_modules/vitest/vitest.mjs run tests/chart-math.spec.ts` | **10/10 passed, exit 0** |
| desktop 全量 | 同上 `... run` | **18 files / 258 tests passed, exit 0** |
| desktop tsc | `cd apps/desktop && node_modules/.bin/tsc --noEmit` | **exit 0** |
| core 全量 | `cd packages/core && node_modules/.bin/vitest run` | **52 files / 753 tests passed, exit 0** |
| core tsc | `cd packages/core && node_modules/.bin/tsc --noEmit` | **exit 0** |
| 语法 | `node --check apps/desktop/src/ui/chart-math.js` / `play.js` | 均 **ok** |
| esbuild | `COREPACK_HOME=$PWD/.cache/corepack corepack pnpm --filter @embodied/desktop build` | **exit 0**（main/preload/camera 全部生成） |
| dev-server | 同上 `build:dev` | **exit 0**（`dist/dev-server.mjs 902.5kb`） |
| diff 空白 | `git diff --check`（5 个已跟踪 v17 文件；analysis 为新文件另行审读） | **exit 0** |

CDP 证据未重跑：只读约束下不覆盖 `.ui-shots/`；且 `.mjs:258` 的 expected 仍是旧 tide 1–7，重跑会复制错误。已读 `report.json`、截图清单与 `compare-v16-v17.png`，并抽查 `04-canvas-builtin-tide-zoom.png`；像素分组/溢出/错误数组与文档一致。真实 Coyote BLE / 真实进程整局仍未回归（无硬件），与本轮无关。

---

## 7. 残余风险（非 P0/P1）

1. **≤5Hz 全部 20px**：1–5Hz 视觉不可区分；是否改对数映射是产品决策（`analysis/ui-v17.md:92-93` 已披露）。
2. **图表不按通道频率软上限重映射**：`play.js:1064` 用 waveform 原始 preview；通道 `minFreq/maxFreq` 只在设备下发时由 core 重映射。若玩家收窄频带，图表与真实输出不一致；v16 以前就有，非本轮引入。
3. **厂商表在 classic script 里复制了一份**：与 core 无共享模块，未来 core 改表不会自动同步；当前测试能覆盖 10–200 段的主要路径，但 201–240 段被 20px clamp 吸收。
4. **真实 pack slice 硬编码**：cilia/flutter 来自外部 0.4.0 资产快照，CI 不读仓库资产；资产更新后测试不会自动发现。
5. **CDP 测量口径**：`CANVAS_PROBE` 以连续填充列分组，1px 柱距时相邻柱合并成 run，`gapRangeCss` 不能直接当 spacing；建议报告里注明或改为按柱起点/固定采样点测量。

---

## 8. 建议

- **不需要改 `chart-math.js`**：映射数学、端点、方向、fallback 均正确。
- **P2-1（证据）**：改 `.ui-shots/t22-chart-physical.mjs:3,258` 的 tide 期望为 1–4（或删掉硬编码 expected），重跑报告；在报告中注明 tide 的 52 列 run 是 26 根 1px 柱合并、`gapRangeCss` 不是 spacing。
- **P2-2（文档）**：把 `analysis/ui-v17.md:85` 的 tide 1–5 / climb 2–10 明确标为“测试断言上限”，实测写 1–4 / 2–9。
- **P2-3（测试强度）**：把 `:243-245` 的 ±1 对表改为 `mean(gaps(...))` 精确断言，补 90→9、101→10.5 等中间点；至少加一条对 201/240 第三段的直接 period 断言（若愿意暴露内部函数）。
- **P2-4（产品）**：确认“1–5Hz 统一 20px”是否满足“尽量贴近体感”；若不满足，按 `analysis/ui-v17.md:93` 的对数备选做产品决策。
- **P3**：修 §4.4 的 v16 4.5→5、Node+CDP 标注、验收“越大”→“不减”、柱宽合并 run 说明；补 cilia/flutter 均值顺序断言、真实资产 2x 单测。

**最终判定：可交付（代码/功能）；无 P0/P1；建议先修 P2-1/P2-2 的文档/证据数字再对外引用。**

---

## 9. 复核后处置（Lead，2026-11-04 00:05）

| 项 | 处置 | 证据 |
|---|---|---|
| P2-1 证据 tide 旧值 | 已改 `.ui-shots/t22-chart-physical.mjs` 的 expected/注释为 **1–4px**，并在 `report.json` 增加 `notes`（52 device 列 run = 26 根 1px 柱合并；gapRange 不是 spacing），已重跑 CDP 生成新 report（0 page/console error、0 溢出） | `.ui-shots/t22-chart-physical/report.json` |
| P2-2 文档把断言上限当实测 | `analysis/ui-v17.md` §4 改为“测试断言范围 cilia 5–8 / flutter 7–10 / tide 1–5 / climb 2–10，实测 tide 1–4 / climb 2–9”；§3 增加 CDP 单帧窗口与合并 run 口径说明 | `analysis/ui-v17.md` |
| P2-3 对表测试强度 | `chart-math.spec.ts` 对表改为**精确断言**（整数柱距集合精确、半像素 101→{10,11} 均值 10.5、补 90→9），并注明 201–240 段在 20px 上限下不可区分；另补 `mean(flutter) > mean(cilia)`、2x 升采样同界、variable-spacing phase 取模 | `apps/desktop/tests/chart-math.spec.ts` |
| P3 文档 | v16 tide 改回 **5–20px**；§21 区分 Node 全数组 / CDP 单帧；验收改为“柱距单调不减（121–240 被 20px 上限压平）”；柱宽/合并 run 已注明 | `analysis/ui-v17.md`、`前端界面设计.md` |
| P2-4 产品口径 | 保留“周期/10 + 20px 上限”，已向用户披露“≤5Hz 统一最疏 20px；若要求 1–5Hz 可辨需改对数映射” | `analysis/ui-v17.md` §5 |

> 说明：复核之后 Lead 又修改了测试与文档；§6 门禁表是复核时刻的结果，最终门禁以 Lead 提交前的复跑为准。

