// 波形柱状图的纯计算（v11，v15 调整柱距归一化）。
//
// 右轨的实时波形图只做一件事：把宿主给出的一帧采样（每 25ms 一个 slot）
// 画成柱子。但它的几条用户可见规则很容易被「顺手」改回去 —— 柱宽跟柱距
// 绑在一起会变粗、柱高乘上当前通道强度会整片缩水、柱距映射域选错会让疏密
// 看不出变化 —— 所以几何计算全部放在这个 classic script 里，不碰 DOM、
// 不读时钟：输入一次采样与画布尺寸，输出可以直接 fillRect 的矩形列表。
//
// 规则：
//   - 柱宽固定 2px：用户要的是「很细」的柱子，不随柱距变粗；
//   - 柱高只由波形自身的 intensity 决定（round(intensity/100*(height-3))，
//     最小 1px）—— 波形是作品给的表现纹理，当前通道强度只通过设备输出
//     生效，不再二次缩放这张图；
//   - 柱距按**当前这一帧 preview 自身的频率范围**归一化：min → 22px（疏），
//     max → 3px（密），同一帧里疏密跟着波形变化。真实波形的协议频率通常只
//     覆盖一小段（如 20–80），按绝对 10–240 映射会把 20–28px 压成几乎一样
//     的稀疏柱（用户反馈「一直是间隔相等的稀疏柱状图」就是它）；
//   - 频率恒定（min==max）时用固定中间柱距，不做除零；
//   - 自右往左排布，phase（像素）控制滚动；一帧的总柱距是一个循环周期，
//     phase 对它取模 —— 图会无缝循环，不随运行时长漂移。
//
// 加载方式：index.html 在 play.js 之前用普通 <script src> 引入（CSP 是
// script-src 'self'），play.js 只读 window.EmbodiedChartMath。
(() => {
  'use strict'

  /** 柱子宽度：固定 2px，不随 spacing 变粗。 */
  const BAR_WIDTH = 2
  /** 柱子的最小高度：intensity 为 0 的采样点也留一条 1px 基线。 */
  const MIN_BAR_HEIGHT = 1
  /** 画布底部留给基线的像素：柱高域是 height-3，底部 1px 给基线。 */
  const BASELINE = 1
  /** 柱距范围：本帧最低频 → 22px（疏），最高频 → 3px（密）。 */
  const MIN_SPACING = 3
  const MAX_SPACING = 22
  /** 频率恒定时用的固定柱距：取区间中间值（12–14px 之间），避免除零。 */
  const CONSTANT_SPACING = 13

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /**
   * 一个采样点的协议频率 → 它与左边那根柱子的柱距（像素）。
   *
   * `low`/`high` 是当前 preview 自身的频率 min/max：真实波形通常只覆盖协议
   * 域的一小段，按绝对域映射会让整帧柱距几乎一样。频率恒定（high<=low）
   * 时退回固定中间柱距，不做除零。
   */
  function spacingFor(freq, low, high) {
    if (!(high > low)) return CONSTANT_SPACING
    const value = clamp(finiteOr(freq, low), low, high)
    return MAX_SPACING - (value - low) / (high - low) * (MAX_SPACING - MIN_SPACING)
  }

  /** 波形自身的 intensity（0-100）→ 柱高；不乘当前通道强度/percent。 */
  function heightFor(intensity, canvasHeight) {
    const value = clamp(finiteOr(intensity, 0), 0, 100)
    const usable = Math.max(0, canvasHeight - 3)
    return Math.max(MIN_BAR_HEIGHT, Math.round(value / 100 * usable))
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
   * }} input 采样点的协议频率/波形强度，画布尺寸（像素）；phase 是滚动相位。
   * @returns {{x: number, width: number, height: number}[]} 按绘制顺序（右 → 左）。
   */
  function computeBars(input) {
    const freq = Array.isArray(input?.freq) ? input.freq : []
    const intensity = Array.isArray(input?.intensity) ? input.intensity : []
    const count = Math.min(freq.length, intensity.length)
    const width = Math.floor(finiteOr(input?.width, 0))
    const height = Math.floor(finiteOr(input?.height, 0))
    if (count === 0 || width <= 0 || height <= 0) return []

    // 先求这一帧自身的频率范围：柱距按它归一化（min→疏，max→密）。
    // 非有限采样点不参与范围计算；整帧没有有限值时退回恒定柱距。
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (let index = 0; index < count; index += 1) {
      const value = freq[index]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      low = Math.min(low, value)
      high = Math.max(high, value)
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = 0
      high = 0
    }

    // 每根柱用自己采样点的频率（在当前帧的 min/max 之间归一化）决定到左边
    // 那根柱的距离。
    const spacings = new Array(count)
    let cycle = 0
    for (let index = 0; index < count; index += 1) {
      spacings[index] = spacingFor(freq[index], low, high)
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

  window.EmbodiedChartMath = Object.freeze({ computeBars })
})()
