// 波形柱状图的纯计算（v11；v15 曾按波形 min/max 归一化，v17 改回绝对频率）。
//
// 右轨的实时波形图只做一件事：把宿主给出的一帧采样（每 25ms 一个 slot）
// 画成柱子。但它的几条用户可见规则很容易被「顺手」改回去 —— 柱宽跟柱距
// 绑在一起会变粗、柱高乘上当前通道强度会整片缩水、柱距映射域选错会让疏密
// 看不出变化 —— 所以几何计算全部放在这个 classic script 里，不碰 DOM、
// 不读时钟：输入一次采样与画布尺寸，输出可以直接 fillRect 的矩形列表。
//
// 规则：
//   - 柱宽固定 1px（用户要更细的柱子）：画布内部按 2x 设备像素绘制，1 CSS px
//     柱 = 2 device px，pixelated 缩放后仍然清晰；
//   - 柱高只由波形自身的 intensity 决定（round(intensity/100*(height-3))，
//     最小 1px）—— 波形是作品给的表现纹理，当前通道强度只通过设备输出
//     生效，不再二次缩放这张图；
//   - 柱距按**绝对协议频率**（物理体感：脉冲间隔 ∝ 1/freq）：
//     spacing = clamp(1, 20, 200/freq 取半像素)，10→20px、50→4px、80→2.5px、
//     240→1px，高频明显更密。不再用波形自己的 min/max 归一化：那会把
//     2.5–4px 的窄域拉满成 3–22px，反而失去真实体感；
//   - 0/非有限频率 fallback 到最疏 20px，不让 NaN 进布局；
//   - 自右往左排布，phase（像素）控制滚动；一帧的总柱距是一个循环周期，
//     phase 对它取模 —— 图会无缝循环，不随运行时长漂移。
//
// 加载方式：index.html 在 play.js 之前用普通 <script src> 引入（CSP 是
// script-src 'self'），play.js 只读 window.EmbodiedChartMath。
(() => {
  'use strict'

  /** 柱子宽度：固定 1px（CSS 逻辑像素），不随 spacing 变粗。 */
  const BAR_WIDTH = 1
  /** 柱子的最小高度：intensity 为 0 的采样点也留一条 1px 基线。 */
  const MIN_BAR_HEIGHT = 1
  /** 画布底部留给基线的像素：柱高域是 height-3，底部 1px 给基线。 */
  const BASELINE = 1
  /** 柱距范围：最密 1px，最疏 20px。 */
  const MIN_SPACING = 1
  const MAX_SPACING = 20
  /** 绝对频率映射的参考值：spacing ≈ REF_FREQ / freq（脉冲间隔 ∝ 1/频率）。 */
  const REF_FREQ = 200

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /**
   * 一个采样点的协议频率 → 它与左边那根柱子的柱距（CSS 像素）。
   *
   * 绝对映射（不再按本帧 min/max 归一化）：200/freq，10→20px、50→4px、
   * 80→2.5px、240→≈0.83→1px。只做半像素取整：2x 内部画布上半像素正好落在
   * 整数 device px 上，1px 细柱不会被抗锯齿糊掉。0/非有限频率退回最疏柱距。
   */
  function spacingFor(freq) {
    const value = finiteOr(freq, 0)
    if (!(value > 0)) return MAX_SPACING
    const spacing = Math.round((REF_FREQ / value) * 2) / 2
    return clamp(spacing, MIN_SPACING, MAX_SPACING)
  }

  /** 波形自身的 intensity（0-100）→ 柱高；不乘当前通道强度/percent。 */
  function heightFor(intensity, canvasHeight) {
    const value = clamp(finiteOr(intensity, 0), 0, 100)
    const usable = Math.max(0, canvasHeight - 3)
    return Math.max(MIN_BAR_HEIGHT, Math.round(value / 100 * usable))
  }

  /**
   * 显示用线性升采样：相邻 slot 之间按 `factor` 插值（最后一根回到第一根，
   * 保持循环波形首尾连续），让柱状图的曲线更平滑、细节更多。
   *
   * 硬件输出仍是 25ms 一个 slot —— 这里只影响画面，不改变设备行为。
   * 长度 = count * factor（2x 即翻倍）。非有限采样点按端点/0 回退，不产生 NaN。
   *
   * @param {readonly number[]} freq
   * @param {readonly number[]} intensity
   * @param {number} [factor]
   * @returns {{freq: number[], intensity: number[]}}
   */
  function upsampleLinear(freq, intensity, factor = 2) {
    const sourceFreq = Array.isArray(freq) ? freq : []
    const sourceIntensity = Array.isArray(intensity) ? intensity : []
    const count = Math.min(sourceFreq.length, sourceIntensity.length)
    const steps = Math.max(1, Math.floor(finiteOr(factor, 1)))
    if (count === 0) return { freq: [], intensity: [] }
    const outFreq = []
    const outIntensity = []
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count
      const freqFrom = finiteOr(sourceFreq[index], 0)
      const freqTo = finiteOr(sourceFreq[next], freqFrom)
      const intensityFrom = finiteOr(sourceIntensity[index], 0)
      const intensityTo = finiteOr(sourceIntensity[next], intensityFrom)
      for (let step = 0; step < steps; step += 1) {
        const ratio = step / steps
        outFreq.push(freqFrom + (freqTo - freqFrom) * ratio)
        outIntensity.push(intensityFrom + (intensityTo - intensityFrom) * ratio)
      }
    }
    return { freq: outFreq, intensity: outIntensity }
  }

  /**
   * 一帧采样 → 画布内可见的柱子。
   *
   * @param {{
   *   freq?: readonly number[],
   *   intensity?: readonly number[],
   *   width?: number,
   *   height?: number,
   *   phase?: number,
   * }} input 采样点的协议频率/波形强度，画布逻辑尺寸（CSS 像素）；phase 是滚动相位。
   * @returns {{x: number, width: number, height: number}[]} 按绘制顺序（右 → 左）。
   */
  function computeBars(input) {
    const freq = Array.isArray(input?.freq) ? input.freq : []
    const intensity = Array.isArray(input?.intensity) ? input.intensity : []
    const count = Math.min(freq.length, intensity.length)
    const width = Math.floor(finiteOr(input?.width, 0))
    const height = Math.floor(finiteOr(input?.height, 0))
    if (count === 0 || width <= 0 || height <= 0) return []

    // 每根柱用自己采样点的绝对频率决定到左边那根柱的距离（高频更密）。
    const spacings = new Array(count)
    let cycle = 0
    for (let index = 0; index < count; index += 1) {
      spacings[index] = spacingFor(freq[index])
      cycle += spacings[index]
    }

    // phase 对一个整帧的总柱距取模：滚动无缝循环、且完全确定。
    const phase = finiteOr(input?.phase, 0)
    const offset = ((phase % cycle) + cycle) % cycle

    // 从画布右侧之外开始向左走，起点是「这一帧的最后一根柱」（最右边那根）。
    // 起点至少放到 width 之外，再一路走到画布左边之外，中间可见的都收下。
    const bars = []
    let x = width - BAR_WIDTH - offset
      + cycle * Math.ceil((offset + BAR_WIDTH) / cycle)
    let index = count - 1
    while (x > -BAR_WIDTH) {
      if (x + BAR_WIDTH > 0 && x < width) {
        bars.push({
          x: Math.round(x),
          width: BAR_WIDTH,
          height: heightFor(intensity[index], height),
        })
      }
      x -= spacings[index]
      index = index === 0 ? count - 1 : index - 1
    }
    return bars
  }

  window.EmbodiedChartMath = Object.freeze({ computeBars, upsampleLinear })
})()
