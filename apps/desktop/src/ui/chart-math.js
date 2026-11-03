// 波形柱状图的纯计算（v11；v15 曾按波形 min/max 归一化，v16 用协议码做
// 绝对映射，v17 改为按物理脉冲周期映射）。
//
// 右轨的实时波形图只做一件事：把宿主给出的一帧采样（每 25ms 一个 slot）
// 画成柱子。但它的几条用户可见规则很容易被「顺手」改回去 —— 柱宽跟柱距
// 绑在一起会变粗、柱高乘上当前通道强度会整片缩水、柱距映射域选错会让疏密
// 看不出变化甚至画反 —— 所以几何计算全部放在这个 classic script 里，不碰
// DOM、不读时钟：输入一次采样与画布尺寸，输出可以直接 fillRect 的矩形列表。
//
// 规则：
//   - 柱宽固定 1px（用户要更细的柱子）：画布内部按 2x 设备像素绘制，1 CSS px
//     柱 = 2 device px，pixelated 缩放后仍然清晰；
//   - 柱高只由波形自身的 intensity 决定（round(intensity/100*(height-3))，
//     最小 1px）—— 波形是作品给的表现纹理，当前通道强度只通过设备输出
//     生效，不再二次缩放这张图；
//   - 柱距按**物理脉冲周期**：郊狼协议里的频率字节不是 Hz，而是被厂商分段
//     压缩过的脉冲周期（10–100 段 1:1、101–200 段 1:5、201–240 段 1:10），
//     对应物理 100Hz–1Hz。所以先把码还原成周期，再取 spacing = 周期/10px、
//     夹在 1–20px：100Hz→1px、20Hz→5px、10Hz→10px、5Hz 及更慢→20px。
//     高频密、低频疏，与体感（脉冲间隔）同序。**不要直接用协议码算**：
//     码越大物理频率越低，200/码 会把疏密画反（v16 的错误）。
//   - 0/非有限/非法码 fallback 到最疏 20px，不让 NaN 进布局；
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
  /** 协议频率码：10 = 最快（10ms 周期 = 100Hz），240 = 最慢（1000ms = 1Hz）。 */
  const MIN_FREQ_CODE = 10
  const MAX_FREQ_CODE = 240
  /** 柱距映射比例：每 10ms 物理脉冲周期 1px（100Hz→1px、10Hz→10px）。 */
  const PERIOD_MS_PER_PIXEL = 10

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
  }

  /**
   * 协议频率码 → 物理脉冲周期（ms）。
   *
   * 与 `packages/core/src/backends/coyote/frequency.ts` 的 `periodMsForCode`
   * 是同一张厂商表：10–100 段 1:1、101–200 段 1:5、201–240 段 1:10；物理
   * 频率 = 1000/周期，所以码 10 = 100Hz、码 100 = 10Hz、码 240 = 1Hz。
   * 越界码按边界夹紧，让坏数据也画得出东西。
   */
  function periodMsForCode(code) {
    const value = clamp(finiteOr(code, 0), MIN_FREQ_CODE, MAX_FREQ_CODE)
    if (value <= 100) return value
    if (value <= 200) return 100 + (value - 100) * 5
    return 600 + (value - 200) * 10
  }

  /**
   * 一个采样点的协议频率码 → 它与左边那根柱子的柱距（CSS 像素）。
   *
   * 先把码还原成物理脉冲周期（10–1000ms = 100–1Hz），再按「每 10ms 周期
   * 1px」映射：100Hz→1px、50Hz→2px、20Hz→5px、10Hz→10px、5Hz→20px，
   * 更慢的周期被 20px 上限截住。高频更密、低频更疏，与脉冲间隔同序；只做
   * 半像素取整：2x 内部画布上半像素正好落在整数 device px 上。0/非有限/
   * 非法码（<10）退到最疏柱距。
   */
  function spacingFor(code) {
    const value = finiteOr(code, 0)
    if (!(value >= MIN_FREQ_CODE)) return MAX_SPACING
    const spacing = Math.round((periodMsForCode(value) / PERIOD_MS_PER_PIXEL) * 2) / 2
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
   * }} input 采样点的协议频率码/波形强度，画布逻辑尺寸（CSS 像素）；phase 是滚动相位。
   * @returns {{x: number, width: number, height: number}[]} 按绘制顺序（右 → 左）。
   */
  function computeBars(input) {
    const freq = Array.isArray(input?.freq) ? input.freq : []
    const intensity = Array.isArray(input?.intensity) ? input.intensity : []
    const count = Math.min(freq.length, intensity.length)
    const width = Math.floor(finiteOr(input?.width, 0))
    const height = Math.floor(finiteOr(input?.height, 0))
    if (count === 0 || width <= 0 || height <= 0) return []

    // 每根柱用自己采样点的物理脉冲周期决定到左边那根柱的距离（高频更密）。
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
