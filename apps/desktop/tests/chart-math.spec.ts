// 波形柱状图纯函数的真行为测试。
//
// 图表几何的计算规则（1px 细柱、柱高只跟波形 intensity 走、绝对频率决定
// 疏密、显示用升采样、phase 滚动循环）全部在 `src/ui/chart-math.js` 里。
// 这里不用 grep 源码冒充行为测试：用 node:vm 在一个只有 `window` 的干净
// 上下文里执行整份 classic script（没有 DOM、没有时钟），再对 computeBars /
// upsampleLinear 的输出做几何断言。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'

interface Bar {
  x: number
  width: number
  height: number
}

interface ComputeBarsInput {
  freq?: readonly number[]
  intensity?: readonly number[]
  width?: number
  height?: number
  phase?: number
  /** 旧实现会把当前通道强度乘进柱高；新 API 不认这个字段。 */
  [extra: string]: unknown
}

interface Upsampled {
  freq: number[]
  intensity: number[]
}

interface ChartMath {
  computeBars: (input: ComputeBarsInput) => Bar[]
  upsampleLinear: (freq: readonly number[], intensity: readonly number[], factor?: number) => Upsampled
}

interface ChartMathWindow {
  EmbodiedChartMath?: ChartMath
}

const SOURCE_URL = new URL('../src/ui/chart-math.js', import.meta.url)

/** 在无 DOM、无时钟的 vm 上下文里执行 chart-math.js，取回纯函数。 */
function loadChartMath(): ChartMath {
  const source = readFileSync(fileURLToPath(SOURCE_URL), 'utf8')
  const sandbox: { window: ChartMathWindow } = { window: {} }
  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'chart-math.js' })
  const chartMath = sandbox.window.EmbodiedChartMath
  if (chartMath === undefined) throw new Error('chart-math.js did not install window.EmbodiedChartMath')
  return chartMath
}

const chartMath = loadChartMath()

const WIDTH = 320
const HEIGHT = 34

function bars(input: ComputeBarsInput): Bar[] {
  return chartMath.computeBars(input)
}

/** 均匀采样：count 个点全是同一个 freq / intensity。 */
function uniform(count: number, freq: number, intensity: number, phase = 0): Bar[] {
  return bars({
    freq: Array.from({ length: count }, () => freq),
    intensity: Array.from({ length: count }, () => intensity),
    width: WIDTH,
    height: HEIGHT,
    phase,
  })
}

/** 相邻柱子（右 → 左）的 x 差。 */
function gaps(computed: readonly Bar[]): number[] {
  const out: number[] = []
  for (let index = 1; index < computed.length; index += 1) {
    out.push((computed[index - 1]?.x ?? 0) - (computed[index]?.x ?? 0))
  }
  return out
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

describe('chart-math', () => {
  it('is a pure classic script: one frozen window API, no DOM/clock', () => {
    const source = readFileSync(fileURLToPath(SOURCE_URL), 'utf8')
    // 纯计算：不碰 document / performance / Date —— vm 上下文里本来也没有，
    // 能执行成功就说明没有偷偷依赖它们。
    expect(source).not.toMatch(/\bdocument\b/u)
    expect(source).not.toMatch(/\bperformance\b/u)
    const chartMathWindow = vm.runInNewContext(
      `${source}\nwindow.EmbodiedChartMath`,
      { window: {} },
    ) as ChartMath
    expect(typeof chartMathWindow.computeBars).toBe('function')
    expect(typeof chartMathWindow.upsampleLinear).toBe('function')
    expect(Object.isFrozen(chartMathWindow)).toBe(true)
  })

  it('draws thin 1px bars and never widens them to fill the spacing', () => {
    const sparse = uniform(10, 10, 60)
    const dense = uniform(10, 240, 60)
    expect(sparse.length).toBeGreaterThan(0)
    expect(dense.length).toBeGreaterThan(0)
    for (const bar of [...sparse, ...dense]) {
      expect(bar.width).toBe(1)
    }
    // 最疏/最密两种柱距下柱宽都一样：宽度不随 spacing 变。
    expect(new Set(sparse.map(bar => bar.width))).toEqual(new Set([1]))
    expect(new Set(dense.map(bar => bar.width))).toEqual(new Set([1]))
    // 输出只有可 fillRect 的三个字段（没有 y、没有可传通道强度的字段）。
    expect(Object.keys(sparse[0] ?? {}).sort()).toEqual(['height', 'width', 'x'])
  })

  it('ties bar height to the waveform intensity only, not the channel strength', () => {
    const full = uniform(10, 125, 100)
    const half = uniform(10, 125, 50)
    const fullHeight = full[0]?.height ?? 0
    const halfHeight = half[0]?.height ?? 0
    // 34px 逻辑高：height-3 = 31px 可用高度。
    expect(fullHeight).toBe(Math.round(1 * (HEIGHT - 3)))
    expect(halfHeight).toBe(Math.round(0.5 * (HEIGHT - 3)))
    expect(Math.abs(halfHeight * 2 - fullHeight)).toBeLessThanOrEqual(1)

    // 同样的采样在额外传入「当前强度/百分比」时输出完全一样：高度不乘通道强度。
    const base = bars({
      freq: [125, 125, 125, 125],
      intensity: [0, 50, 100, 50],
      width: 64,
      height: HEIGHT,
      phase: 0,
    })
    const withStrength = bars({
      freq: [125, 125, 125, 125],
      intensity: [0, 50, 100, 50],
      width: 64,
      height: HEIGHT,
      phase: 0,
      level: 100,
      percent: 100,
      strength: 200,
    })
    expect(withStrength).toEqual(base)

    // 自右向左：最右一根用最后一个采样点的 intensity，依次向左。
    expect(base.map(bar => bar.height).slice(0, 4)).toEqual([16, 31, 16, 1])
  })

  it('maps absolute frequency to 1/f spacing: high frequency visibly denser', () => {
    // 绝对协议频率（不按本帧 min/max 归一化）：spacing = clamp(1,20,200/freq)。
    expect(new Set(gaps(uniform(10, 10, 60)))).toEqual(new Set([20]))
    expect(new Set(gaps(uniform(10, 50, 60)))).toEqual(new Set([4]))
    expect(new Set(gaps(uniform(10, 240, 60)))).toEqual(new Set([1]))
    // 80 → 200/80 = 2.5px；整数 x 取整后相邻差在 2–3 之间、均值≈2.5。
    const gaps80 = gaps(uniform(10, 80, 60))
    expect(new Set(gaps80)).toEqual(new Set([2, 3]))
    expect(Math.abs(mean(gaps80) - 2.5)).toBeLessThan(0.5)
    // 高频明显比低频密（v15 的归一化会把两者都拉满到 3–22，已撤销）。
    expect(mean(gaps(uniform(10, 10, 60))) - mean(gaps(uniform(10, 240, 60)))).toBeGreaterThan(10)

    // 0/非有限频率 fallback 到最疏 20px，不产生 NaN。
    const fallback = bars({
      freq: [0, Number.NaN, 0],
      intensity: [60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    })
    expect(new Set(gaps(fallback))).toEqual(new Set([20]))
    for (const bar of fallback) {
      expect(Number.isFinite(bar.x)).toBe(true)
      expect(bar.width).toBe(1)
    }

    // 窄域 [20,20,80,80]：绝对映射下柱距约 10px 与 2–3px，不再被归一化拉满。
    const narrow = gaps(bars({
      freq: [20, 20, 80, 80],
      intensity: [60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.max(...narrow)).toBe(10)
    expect(Math.min(...narrow)).toBeLessThanOrEqual(3)
    expect(Math.max(...narrow) - Math.min(...narrow)).toBeGreaterThan(6)

    // 宽域 [10,240] 覆盖两个极值（整数 x 下正好是 20px / 1px）。
    const wide = gaps(bars({
      freq: [10, 10, 240, 240],
      intensity: [60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(new Set(wide)).toEqual(new Set([1, 20]))
  })

  it('gives real pack frequency ranges their physical density (cilia/tide/climb)', () => {
    // 绝对域下真实波形不再“全等且疏”：cilia 50–80 ≈2–4px、tide 25–70 ≈3–8px、
    // climb 18–90 ≈2–11px（整数 x 取整后相邻差会 ±1）。
    const cilia = gaps(bars({
      freq: [50, 56, 62, 68, 74, 80],
      intensity: [60, 60, 60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.min(...cilia)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...cilia)).toBeLessThanOrEqual(5)

    const tide = gaps(bars({
      freq: [25, 34, 43, 52, 61, 70],
      intensity: [60, 60, 60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.min(...tide)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...tide)).toBeGreaterThanOrEqual(7)
    expect(Math.max(...tide) - Math.min(...tide)).toBeGreaterThan(3)

    const climb = gaps(bars({
      freq: [18, 34, 50, 66, 82, 90],
      intensity: [60, 60, 60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.min(...climb)).toBeLessThanOrEqual(3)
    expect(Math.max(...climb)).toBeGreaterThanOrEqual(9)
    // 高频端（90）比低频端（18）密得多：绝对体感而不是等距。
    expect(Math.max(...climb) - Math.min(...climb)).toBeGreaterThan(6)
  })

  it('linearly upsamples the preview for smoother display (2x/4x)', () => {
    // 2x：相邻 slot 之间插中点；最后一根回到第一根（loop 首尾连续）。
    const doubled = chartMath.upsampleLinear([10, 20, 30, 40], [0, 40, 80, 120], 2)
    expect(doubled.freq).toHaveLength(8)
    expect(doubled.intensity).toHaveLength(8)
    expect(doubled.freq).toEqual([10, 15, 20, 25, 30, 35, 40, 25])
    expect(doubled.intensity).toEqual([0, 20, 40, 60, 80, 100, 120, 60])

    // 4x：每个 slot 后插 3 个插值点，长度翻 4 倍。
    const quadrupled = chartMath.upsampleLinear([10, 20], [0, 100], 4)
    expect(quadrupled.freq).toHaveLength(8)
    expect(quadrupled.freq).toEqual([10, 12.5, 15, 17.5, 20, 17.5, 15, 12.5])
    expect(quadrupled.intensity).toEqual([0, 25, 50, 75, 100, 75, 50, 25])

    // 空数组 / 非有限值：不崩、不产生 NaN。
    expect(chartMath.upsampleLinear([], [], 2)).toEqual({ freq: [], intensity: [] })
    const safe = chartMath.upsampleLinear([Number.NaN, 20], [10, 40], 2)
    expect(safe.freq).toHaveLength(4)
    expect(safe.freq.every(value => Number.isFinite(value))).toBe(true)
    expect(safe.intensity.every(value => Number.isFinite(value))).toBe(true)
  })

  it('scrolls with phase and wraps around the frame cycle', () => {
    // 恒定频率 40 → 绝对 5px 柱距：一帧总柱距 = 10 * 5 = 50px，是滚动周期。
    const base = uniform(10, 40, 60, 0)
    const cycle = 50
    // 最右一根柱贴住画布右缘（1px 柱 → x = width - 1）。
    expect(base[0]?.x).toBe(WIDTH - 1)
    // phase 增加 → 所有柱整体左移 2px（仍在画布内的那些；2 不是 5px 柱距的整数倍）。
    const shifted = uniform(10, 40, 60, 2)
    const shiftedXs = new Set(shifted.map(bar => bar.x))
    for (const bar of base) {
      if (bar.x - 2 >= 0) expect(shiftedXs.has(bar.x - 2)).toBe(true)
    }
    expect(shifted).not.toEqual(base)
    // phase 取模循环：相差整数个周期的相位输出完全一致（含负数相位）。
    expect(uniform(10, 40, 60, cycle)).toEqual(base)
    expect(uniform(10, 40, 60, cycle * 2)).toEqual(base)
    expect(uniform(10, 40, 60, -cycle)).toEqual(base)
    // 确定性：同一输入重复调用结果不变。
    expect(uniform(10, 40, 60, 2)).toEqual(shifted)
  })

  it('never lets a bar exceed the canvas height', () => {
    const heights = [0, 1, 33, 50, 66, 99, 100]
    for (const intensity of heights) {
      for (const bar of uniform(8, 125, intensity)) {
        expect(bar.height).toBeGreaterThanOrEqual(1)
        // 底部留 1px 基线：柱顶不会跑到画布外。
        expect(HEIGHT - 1 - bar.height).toBeGreaterThanOrEqual(0)
        expect(bar.height).toBeLessThanOrEqual(HEIGHT)
      }
    }
    // 画布太矮时仍然留 1px 基线，不会出现 0 或负数高度。
    for (const bar of bars({
      freq: [125, 125],
      intensity: [100, 0],
      width: 100,
      height: 3,
      phase: 0,
    })) {
      expect(bar.height).toBe(1)
    }
  })

  it('tolerates empty, mismatched and non-finite samples', () => {
    expect(bars({ freq: [], intensity: [], width: WIDTH, height: HEIGHT, phase: 0 })).toEqual([])
    expect(bars({ freq: [125], intensity: [], width: WIDTH, height: HEIGHT, phase: 0 })).toEqual([])
    expect(bars({ freq: [125], intensity: [60], width: 0, height: HEIGHT, phase: 0 })).toEqual([])
    expect(bars({ freq: [125], intensity: [60], width: WIDTH, height: 0, phase: 0 })).toEqual([])
    expect(bars({})).toEqual([])
    // 长度不一致时按较短的采样数取（index 对 count 取模），非有限值不产生 NaN。
    const odd = bars({
      freq: [Number.NaN, 125, 240],
      intensity: [60],
      width: 100,
      height: HEIGHT,
      phase: Number.NaN,
    })
    expect(odd.length).toBeGreaterThan(0)
    for (const bar of odd) {
      expect(Number.isFinite(bar.x)).toBe(true)
      expect(Number.isFinite(bar.width)).toBe(true)
      expect(Number.isFinite(bar.height)).toBe(true)
    }
  })
})
