# ui-v15：波形柱状图柱距按当前波形频域归一化（2026-11-03）

> 用户反馈：右侧波形图“一直是间隔相等的稀疏柱状图”，和“频率越高柱越密”不符。

## 1. 诊断

`chart-math.js` 的柱距公式是**绝对协议频率域**：

```
spacing = 28 - (freq - 10) / (240 - 10) * 24   // 10→28px, 240→4px
```

真实内容包/内置波形的协议频率大多只覆盖一小段：

| 波形 | freq 范围 | 旧公式柱距 | 观感 |
|---|---|---|---|
| cilia-tickle | 50–80 | 20.7–23.8px | 几乎等距、稀疏 |
| stroker-tide | 25–70 | 21.7–26.4px | 几乎等距、稀疏 |
| climb（内置脚本 from 90 → to 18，实际 18–90） | ~19.7–27.2px | 3–22px |

不是 preview 数据缺失（API 的 `freq[]` 每 25ms slot 都有值），而是映射域选得太宽。

## 2. 修复

`apps/desktop/src/ui/chart-math.js`：

- `computeBars` 先扫本帧 `freq` 的 min/max（忽略非有限值）；
- `spacing = 22 - (clamp(freq,min,max)-min)/(max-min) * (22-3)`：**当前波形最低频→22px 疏，最高频→3px 密**；
- 频率恒定（min==max）→ 固定 `CONSTANT_SPACING=13px`，不做除零；空/单点/非有限输入行为不变；
- 柱宽仍固定 2px；柱高仍只由波形自身 intensity 决定；phase 对整帧总柱距取模、右→左、`round(x)` 全部保留；
- 暂停/切换波形时按新 preview 自动重算。

`play.js` 不改：它本来只把 preview 的 `freq/intensity` 数组交给纯函数。

## 3. 验证

**单测（chart-math.spec.js，8/8）**

- 窄域 `freq=[20,20,80,80]` → 柱距 {22,3}，极差 19px（旧实现下几乎等距）；
- 恒定 `[40,40,40]` → 柱距恒 13、无 NaN；
- 宽域 `[10,240]` → 覆盖 3/22 两个极端；
- 真实范围用例（cilia 50–80 / tide 25–70 / climb 18–90；测试用合成数组，不是从 WaveformLibrary 读帧）：每段 gap min≤4、max≥21、极差>15；
- 回归：柱宽恒 2、height 只随 intensity、phase 平移/取模循环、空/长度不一致/非有限输入不产生 NaN。

**Node 实跑 `computeBars`（width 320, height 34）相邻柱距**

| 波形 | 旧绝对映射 | 新归一化 |
|---|---|---|
| cilia 50–80 | 20.7–23.8px | **3–22px**（均值 11.7） |
| tide 25–70 | 21.7–26.4px | **3–22px** |
| climb 18–90 | ~19.7–27.2px | **3–22px**（均值约 12） |

**CDP 真页面**（`.ui-shots/t20-chart-density/`，stub preview tide 25→70、切到 cilia 50→80）：

- 像素反推 canvas 柱距 tide/ cilia 均为 **3–22px、15 种不同间隔**；柱宽全 2 列；柱高 3–31；
- rowOverflow=0、pageErrors/consoleErrors=[]；390 窄屏同样不溢出；
- 截图：`02-canvas-tide-zoom.png`（4x 放大可见明显疏密）、`04-canvas-cilia-zoom.png`。

![tide 25–70](.ui-shots/t20-chart-density/02-canvas-tide-zoom.png)
![cilia 50–80](.ui-shots/t20-chart-density/04-canvas-cilia-zoom.png)

**门禁**：`apps/desktop` **18 files / 256 tests**；`tsc --noEmit` 0；`node --check chart-math.js` 通过。

## 4. 限制 / 残余

1. 归一化按当前 preview 的 min/max 拉满对比：若某波形频率只在很窄区间轻微抖动（如 78–80），也会被放大成明显的 22↔3 疏密变化。若觉得“跳”，可加最小频率域阈值（如 range<5 时退回固定 13px），目前按用户要的“看得出疏密”优先。
2. 柱距是视觉纹理映射，不再对应“绝对协议频率”的线性读数；同一 freq（如 60）在不同波形里可能对应不同柱距，这是为了让每个波形自身的疏密可见。
3. 真实 Coyote 输出与真实进程整局仍待硬件回归。

## 5. 相关文件

- [`apps/desktop/src/ui/chart-math.js`](../apps/desktop/src/ui/chart-math.js)
- [`apps/desktop/tests/chart-math.spec.js`](../apps/desktop/tests/chart-math.spec.js)
- 复核：[`analysis/ui-v15-review.md`](ui-v15-review.md)
