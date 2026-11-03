// 波形柱状图纯函数的真行为测试。
//
// 图表几何的计算规则（细柱、柱高只跟波形 intensity 走、频率决定疏密、
// phase 滚动循环）全部在 `src/ui/chart-math.js` 里。这里不用 grep 源码冒充
// 行为测试：用 node:vm 在一个只有 `window` 的干净上下文里执行整份 classic
// script（没有 DOM、没有时钟），再对 computeBars 的输出做几何断言。

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

interface ChartMath {
  computeBars: (input: ComputeBarsInput) => Bar[]
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

describe('chart-math', () => {
  it('is a pure classic script: one frozen window API, no extra entries', () => {
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
    expect(Object.isFrozen(chartMathWindow)).toBe(true)
  })

  it('draws thin 2px bars and never widens them to fill the spacing', () => {
    const sparse = uniform(10, 10, 60)
    const dense = uniform(10, 240, 60)
    expect(sparse.length).toBeGreaterThan(0)
    expect(dense.length).toBeGreaterThan(0)
    for (const bar of [...sparse, ...dense]) {
      expect(bar.width).toBe(2)
    }
    // 高、低频两种疏密下柱宽都一样：宽度不随 spacing 变。
    expect(new Set(sparse.map(bar => bar.width))).toEqual(new Set([2]))
    expect(new Set(dense.map(bar => bar.width))).toEqual(new Set([2]))
    // 输出只有可 fillRect 的三个字段（没有 y、没有可传通道强度的字段）。
    expect(Object.keys(sparse[0] ?? {}).sort()).toEqual(['height', 'width', 'x'])
  })

  it('ties bar height to the waveform intensity only, not the channel strength', () => {
    const full = uniform(10, 125, 100)
    const half = uniform(10, 125, 50)
    const fullHeight = full[0]?.height ?? 0
    const halfHeight = half[0]?.height ?? 0
    // 34px 画布：height-3 = 31px 可用高度。
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

    // 自右向左：最后一根（最右）用最后一个采样点的 intensity，依次向左。
    expect(base.map(bar => bar.height)).toEqual([16, 31, 16, 1])
  })

  it('spaces bars by each sample point frequency: low sparse, high dense', () => {
    const sparse = uniform(10, 10, 60)
    const dense = uniform(10, 240, 60)
    const sparseGaps = gaps(sparse)
    const denseGaps = gaps(dense)
    expect(sparseGaps.length).toBeGreaterThan(3)
    expect(denseGaps.length).toBeGreaterThan(3)
    // 协议频率 10 → 28px；240 → 4px（公式是确定的，同时验证「明显大于」）。
    expect(new Set(sparseGaps)).toEqual(new Set([28]))
    expect(new Set(denseGaps)).toEqual(new Set([4]))
    const sparseAvg = sparseGaps.reduce((sum, gap) => sum + gap, 0) / sparseGaps.length
    const denseAvg = denseGaps.reduce((sum, gap) => sum + gap, 0) / denseGaps.length
    expect(sparseAvg - denseAvg).toBeGreaterThan(20)

    // 一帧里频率混合时，每根柱用自己采样点的频率决定间距，而不是平均值。
    const mixed = bars({
      freq: [10, 240],
      intensity: [60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    })
    const mixedGaps = gaps(mixed)
    expect(mixedGaps).toContain(28)
    expect(mixedGaps).toContain(4)
  })

  it('scrolls with phase and wraps around the frame cycle', () => {
    const base = uniform(10, 125, 60, 0)
    // 一帧总柱距 = 10 * 16 = 160px，是滚动的循环周期。
    const cycle = 160
    // 最右一根柱贴住画布右缘（2px 柱 → x = width - 2）。
    expect(base[0]?.x).toBe(WIDTH - 2)
    // phase 增加 → 所有柱整体左移 5px（仍在画布内的那些）。
    const shifted = uniform(10, 125, 60, 5)
    const shiftedXs = new Set(shifted.map(bar => bar.x))
    for (const bar of base) {
      if (bar.x - 5 >= 0) expect(shiftedXs.has(bar.x - 5)).toBe(true)
    }
    expect(shifted).not.toEqual(base)
    // phase 取模循环：相差整数个周期的相位输出完全一致（含负数相位）。
    expect(uniform(10, 125, 60, cycle)).toEqual(base)
    expect(uniform(10, 125, 60, cycle * 2)).toEqual(base)
    expect(uniform(10, 125, 60, -cycle)).toEqual(base)
    // 确定性：同一输入重复调用结果不变。
    expect(uniform(10, 125, 60, 5)).toEqual(shifted)
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
