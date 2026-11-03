# ui-v17：右轨柱状图柱距改为物理脉冲周期（1–100Hz）映射（2026-11-03）

> 用户口径：v16 的柱距/柱宽做错了；柱状图的频率高低疏密要基于**郊狼实际映射的 1–100Hz**，
> 而不是协议频宽 10–240。要求"尽量贴近体感"。
>
> 结论：v16 把**协议码当成了频率**。协议码是厂商分段压缩后的**脉冲周期**，码越大物理频率越低，
> 所以 `200/码` 把疏密方向整体画反了；v17 先还原周期再映射柱距。

## 1. 根因：协议频率字节是周期，不是 Hz

`packages/core/src/backends/coyote/frequency.ts`（厂商表，已有实现）：

```
period(v) = v                    for  10 <= v <= 100
          = 100 + (v - 100)*5    for 101 <= v <= 200
          = 600 + (v - 200)*10   for 201 <= v <= 240
物理频率 = 1000 / period(v) Hz   →  码 10 = 100Hz、码 100 = 10Hz、码 240 = 1Hz，即 1–100Hz
```

v16 的 `chart-math.js` 直接把 preview 里的协议码喂进 `spacing = 200/freq`，于是一整排真实资产被画反：

| 资产 | 协议码 | 实际物理频率 | v16 柱距 | 观感（v16） |
|---|---|---|---|---|
| builtin breathing | 10 | 100Hz | **20px** | 最疏（错，应最密） |
| builtin tide | 10–42 | 23.8–100Hz | 5–20px | 越快的段落越疏（错） |
| pack cilia-tickle | 50–80 | 12.5–20Hz | 2.5–4px | 越慢的段落越密（错） |
| pack flutter-suck | 70–98 | 10.2–14.3Hz | 2–3px | 整段最密（错，应较疏） |
| builtin climb | 18–90 | 11.1–55.6Hz | 2–11px | 方向反过来 |

## 2. 修法

`apps/desktop/src/ui/chart-math.js` 新增 `periodMsForCode()`（与 core 的
`frequency.ts` 同一张分段表），柱距改为**物理脉冲周期映射**：

```
spacing(code) = clamp(1, 20, round((periodMs(code) / 10) * 2) / 2)
```

即「每 10ms 物理脉冲间隔 1px」：100Hz（10ms）→ 1px、50Hz→2px、20Hz→5px、10Hz→10px、
5Hz（200ms）→20px，更慢的周期被 20px 上限截住（画布/滚动尺度放不下等比例的 100–1000ms 间隔）。
0/非有限/非法码（<10）仍 fallback 最疏 20px。

| 协议码 | 周期 | 物理频率 | v17 柱距 |
|---|---|---|---|
| 10 | 10ms | 100Hz | 1px |
| 20 | 20ms | 50Hz | 2px |
| 25 | 25ms | 40Hz | 2.5px |
| 50 | 50ms | 20Hz | 5px |
| 80 | 80ms | 12.5Hz | 8px |
| 100 | 100ms | 10Hz | 10px |
| 110 | 150ms | 6.67Hz | 15px |
| 120 | 200ms | 5Hz | 20px |
| 240 | 1000ms | 1Hz | 20px（clamp） |

同一批真实 preview 数组下 v16 / v17 的柱距对比（左两列是 pack 纤毛/微须，右两列是内置攀升/潮汐）：

![v16 与 v17 对比](../.ui-shots/chart-candidates/compare-v16-v17.png)

不变的部分：**柱宽固定 1px**、**柱高只由波形自身 intensity 决定**、自右往左、phase 取模、
2x 显示升采样、canvas 内部按 `clientWidth×2 × 68` 绘制（1 CSS px 柱 = 2 device px）。
`play.js` 只更新了注释，没有改绘制/取数逻辑。

## 3. 真实资产实测（Node + CDP）

| 资产 | 协议码 | 物理频率 | v16 柱距 | v17 柱距（Node） | v17 CDP 像素 |
|---|---|---|---|---|---|
| pack cilia-tickle | 50–80 | 12.5–20Hz | 2.5–4px | 5–8px | **5.03–7.05px** |
| pack flutter-suck | 70–98 | 10.2–14.3Hz | 2–3px | 7–10px | **7.05–9.06px** |
| builtin climb | 18–90 | 11.1–55.6Hz | 2–11px | 2–9px | **2.01–9.06px** |
| builtin tide | 10–42 | 23.8–100Hz | 5–20px | 1–4px | **1–2px 段连成实心** |
| builtin breathing | 10 | 100Hz | 20px | 1px | 实心（Node 验证） |

CDP（`.ui-shots/t22-chart-physical/`）用真实 `index.html + play.js + chart-math.js`，宿主 stub 回放
**真实资产的 preview 数组**（builtin 潮汐/攀升、pack 纤毛/微须）：单根柱宽 2 device 列 = 1 CSS px；
1600/390 均无文档/行溢出、无 page/console error；截图见
[`01-canvas-cilia-zoom`](../.ui-shots/t22-chart-physical/01-canvas-pack-cilia-tickle-zoom.png)、
[`02-canvas-flutter-zoom`](../.ui-shots/t22-chart-physical/02-canvas-pack-flutter-suck-zoom.png)、
[`04-canvas-tide-zoom`](../.ui-shots/t22-chart-physical/04-canvas-builtin-tide-zoom.png)。

> 口径注：CDP 是单帧可见窗口，所以 cilia/flutter 的 CDP 区间（5–7 / 7–9）比 Node 全数组
> （5–8 / 7–10）窄。tide 高频段 1px 柱距 + 1px 柱宽会让相邻柱连成实心 run（report 里的
> `barColumns [2,4,52]` 是 52 device 列 = 26 根相邻 1px 柱合并，不是柱宽变 26px），
> 因此它的 `gapRange 27.18` 是合并块跨度、不能当作 spacing 引用。

## 4. 验证

- `chart-math.spec.ts` **10/10**：物理端点（10→1px、20→2、40→4、50→5、80→8、90→9、100→10、110→15、120→20、240→20）、
  半像素（25→2.5、101→10.5）、方向（100Hz 比 10Hz 密）、单调性（码 10→240 柱距单调不减，v16 是反的）、
  0/NaN/非法码 fallback、窄域/宽域、**与 core `codeToHz` 的分段表对表**（整数柱距精确断言 + 均值精确到 0.01；
  201–240 段在 20px 上限下不可区分，分段斜率由与 core 的对表保证）、真实资产（pack 0.4.0 的 cilia/flutter
  实际 slot 快照 + core 编译出的内置 breathing/tide/climb：测试断言范围 cilia 5–8 / flutter 7–10 /
  tide 1–5 / climb 2–10，实测 tide 1–4 / climb 2–9；且平均柱距 呼吸 < 潮汐 < 攀升、微须 > 纤毛，
  另加 2x 升采样路径的同界断言）。
- `apps/desktop` **18 files / 258 tests**；`packages/core` **52 files / 753 tests**；两包 `tsc --noEmit` 0；
  Electron `build` 与 dev-server `build:dev` 通过；`node --check chart-math.js` 通过。

## 5. 限制 / 残余

1. **≤5Hz 统一 20px 最疏**：按「周期/10px」等比例映射时 1Hz 应 100px，画布放不下也不适合滚动，
   因此 5Hz 以下统一封顶；若以后要区分 1–5Hz，可改成对数映射（1Hz→20、10Hz→10.5、100Hz→1）。
2. **100Hz 附近会连成实心**：柱距 1px + 柱宽 1px 时相邻柱无空隙，这是"最密"的表现，不是渲染错误。
3. 柱宽保持 1px（v16 用户要求"更细"），本轮只改疏密映射，没有改柱宽/柱高规则。
4. 真实 Coyote BLE 输出与真实进程整局仍未回归（开发环境无硬件）；CDP 是真实页面 + 真实 preview 数据，
   但宿主仍是 stub。

## 6. 相关文件

- [`apps/desktop/src/ui/chart-math.js`](../apps/desktop/src/ui/chart-math.js)
- [`apps/desktop/tests/chart-math.spec.ts`](../apps/desktop/tests/chart-math.spec.ts)
- [`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)
- [`前端界面设计.md`](../前端界面设计.md) §14.3 / §21
- [`README.md`](../README.md) v17
