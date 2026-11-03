# ui-v16：绝对频率柱距、1px 细柱、升采样与 2x canvas（2026-11-03）

> 用户最终口径：按**绝对频率**疏密来，柱子更细、间隔更密，采样频率高一点，让图像贴近体感。
> （v15 的“按波形自身 min/max 归一化”被替换。）

## 1. 绝对频率映射（物理感）

`chart-math.js`：

```
BAR_WIDTH = 1
MIN_SPACING = 1
MAX_SPACING = 20
spacing(freq) = clamp(1, 20, round((200 / freq) * 2) / 2)
```

| freq | 10 | 20 | 25 | 50 | 80 | 170 | 240 |
|---|---|---|---|---|---|---|---|
| 柱距 | 20px | 10px | 8px | 4px | 2.5px | 1px | 1px |

- 采用 `≈200/freq` 而不是旧的线性 10–240→28–4：更接近“脉冲间隔 ∝ 1/频率”的体感；
- 0/非有限频率 fallback 到 20px；恒定频率按同一公式固定，不会除零；
- 柱宽固定 **1px**（可在 2x canvas 上保持锐利），柱高只跟波形自身 intensity，phase 取模/右→左/round(x) 不变；
- 不再读取 preview 的 min/max。

真实波形柱距（2x 升采样后，320×34 逻辑画布）：

| 波形 | 柱距 |
|---|---|
| cilia-tickle 50–80 | **2–4px**（均值 3.1） |
| stroker-tide 25–70 | **3–8px**（均值 4.5） |
| 内置 climb 18–90 | **2–11px**（均值 4.4） |

## 2. 更高采样/分辨率

- `chart-math.js` 新增并导出 `upsampleLinear(freq, intensity, factor=2)`：相邻 slot 线性插值（含 loop 首尾），
  长度 ×factor，非有限安全。`play.js` 绘制前 2x 升采样（12.5ms 显示步长）；**硬件波形仍是 25ms slot**，
  升采样只用于画面平滑，不改变设备输出。
- canvas 内部尺寸改为 `round(clientWidth) × 2` 宽、`68` 高；绘制前 `ctx.setTransform(2,0,0,2,0,0)`，
  逻辑坐标仍按 CSS px（300 宽 / 34 高）计算 —— 1px CSS 柱 = 2 device px，`image-rendering: pixelated` 下更细更清晰；
  rail 宽度变化时自动重设 buffer 并按新宽度重绘，不再把固定 300 的画布拉伸。

## 3. 验证

- `chart-math.spec` **9/9**：端点 10→20 / 50→4 / 240→1；80→2.5（整数 x 下 2–3）；0/NaN fallback 20；
  窄域 [20,20,80,80] 为 10 与 ≤3（绝对映射，不再拉满 3–22）；宽域覆盖 {1,20}；upsample 2x/4x 中点与 loop 回绕；
  phase 周期 50px；柱宽全 1；height 只随 intensity；空/长度不一致/单点不崩。
- Node 实跑 computeBars（320×34，2x 升采样）：cilia 2–4px、tide 3–8px、climb 2–11px；端点 20/4/2.5/1；柱宽 {1}。
- CDP 真页面（`.ui-shots/t21-chart-absolute/`）：canvas 内部 616×68（CSS content 308×34，恰 2x 无拉伸）；
  柱宽全部 **2 device 列 = 1 CSS px**；cilia 柱距 2–4 CSS px、tide 3–8 CSS px；1600/390 均无溢出、无 JS 错误。
- `apps/desktop`：**18 files / 257 tests**；`tsc --noEmit` 0；`node --check chart-math.js/play.js` 通过；main/dev 构建通过。

![tide 25–70](.ui-shots/t21-chart-absolute/02-canvas-tide-zoom.png)
![cilia 50–80](.ui-shots/t21-chart-absolute/04-canvas-cilia-zoom.png)

## 4. 限制 / 残余

1. 绝对频率意味着“低频谱天然稀疏”：cilia 50–80 的柱距只有 2–4px，视觉上变化不如 v15 的归一化夸张；这是用户要的绝对口径。
2. `round((200/freq)*2)/2` 允许半像素柱距（80→2.5），在 2x canvas 上对应整数 device px；若未来要求严格整像素，可改整数映射。
3. 升采样是显示插值，不增加设备的真实时间分辨率（25ms slot）。
4. 真实 Coyote BLE 输出与真实进程整局仍待硬件回归。

## 5. 相关文件

- [`apps/desktop/src/ui/chart-math.js`](../apps/desktop/src/ui/chart-math.js)
- [`apps/desktop/tests/chart-math.spec.js`](../apps/desktop/tests/chart-math.spec.js)
- [`apps/desktop/src/ui/play.js`](../apps/desktop/src/ui/play.js)
