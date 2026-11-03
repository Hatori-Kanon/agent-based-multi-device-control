// 波形柱状图纯函数的真行为测试。
//
// 图表几何的计算规则（1px 细柱、柱高只跟波形 intensity 走、物理频率决定
// 疏密、显示用升采样、phase 滚动循环）全部在 `src/ui/chart-math.js` 里。
// 这里不用 grep 源码冒充行为测试：用 node:vm 在一个只有 `window` 的干净
// 上下文里执行整份 classic script（没有 DOM、没有时钟），再对 computeBars /
// upsampleLinear 的输出做几何断言。
//
// 频率口径（v17）：柱距按**物理脉冲周期**映射，协议码先按厂商分段表还原成
// 周期（码 10 = 100Hz、码 100 = 10Hz、码 240 = 1Hz），再用周期/10px 算柱距。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as vm from 'node:vm'
import { codeToHz, createBuiltinWaveforms } from '@embodied/core'
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

/** 内置波形编译后的逐 slot freq/intensity（真实资产，不是手写合成数组）。 */
function builtinSlots(id: string): { freq: number[]; intensity: number[] } {
  const waveform = createBuiltinWaveforms().find(candidate => candidate.id === id)
  if (waveform === undefined) throw new Error(`missing builtin waveform "${id}"`)
  const freq: number[] = []
  const intensity: number[] = []
  for (const frame of waveform.frames) {
    for (let slot = 0; slot < 4; slot += 1) {
      freq.push(frame.freq[slot] ?? 0)
      intensity.push(frame.intensity[slot] ?? 0)
    }
  }
  return { freq, intensity }
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
    const sparsest = uniform(10, 240, 60)
    const densest = uniform(10, 10, 60)
    expect(sparsest.length).toBeGreaterThan(0)
    expect(densest.length).toBeGreaterThan(0)
    for (const bar of [...sparsest, ...densest]) {
      expect(bar.width).toBe(1)
    }
    // 20px 最疏 / 1px 最密两种柱距下柱宽都一样：宽度不随 spacing 变。
    expect(new Set(sparsest.map(bar => bar.width))).toEqual(new Set([1]))
    expect(new Set(densest.map(bar => bar.width))).toEqual(new Set([1]))
    // 输出只有可 fillRect 的三个字段（没有 y、没有可传通道强度的字段）。
    expect(Object.keys(sparsest[0] ?? {}).sort()).toEqual(['height', 'width', 'x'])
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

  it('maps the physical pulse period to spacing: high Hz dense, low Hz sparse', () => {
    // 协议码不是频率，是压缩后的脉冲周期：码 10 = 100Hz、码 50 = 20Hz、
    // 码 100 = 10Hz、码 240 = 1Hz；柱距 = 周期/10px，夹在 1–20px。
    expect(new Set(gaps(uniform(10, 10, 60)))).toEqual(new Set([1]))
    expect(new Set(gaps(uniform(10, 20, 60)))).toEqual(new Set([2]))
    expect(new Set(gaps(uniform(10, 40, 60)))).toEqual(new Set([4]))
    expect(new Set(gaps(uniform(10, 50, 60)))).toEqual(new Set([5]))
    expect(new Set(gaps(uniform(10, 80, 60)))).toEqual(new Set([8]))
    expect(new Set(gaps(uniform(10, 100, 60)))).toEqual(new Set([10]))
    // 压缩段：110 → 150ms → 15px；120 → 200ms → 20px；240 → 1000ms → clamp 20px。
    expect(new Set(gaps(uniform(10, 110, 60)))).toEqual(new Set([15]))
    expect(new Set(gaps(uniform(10, 120, 60)))).toEqual(new Set([20]))
    expect(new Set(gaps(uniform(10, 240, 60)))).toEqual(new Set([20]))

    // 半像素：25 → 2.5px，整数 x 取整后相邻差 2–3、均值≈2.5。
    const gaps25 = gaps(uniform(10, 25, 60))
    expect(new Set(gaps25)).toEqual(new Set([2, 3]))
    expect(Math.abs(mean(gaps25) - 2.5)).toBeLessThan(0.5)

    // 方向与体感一致：100Hz（码 10）比 10Hz（码 100）密。
    expect(mean(gaps(uniform(10, 10, 60)))).toBeLessThan(mean(gaps(uniform(10, 100, 60))))

    // 码越大 → 物理频率越低 → 柱距单调不减（v16 的 200/码 是反的）。
    const monotonic = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 150, 200, 240]
      .map(code => mean(gaps(uniform(10, code, 60))))
    for (let index = 1; index < monotonic.length; index += 1) {
      expect(monotonic[index]).toBeGreaterThanOrEqual(monotonic[index - 1]!)
    }

    // 0/非有限/非法码（<10）fallback 到最疏 20px，不产生 NaN。
    const fallback = bars({
      freq: [0, Number.NaN, 5],
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

    // 窄域 [20,20,80,80]：50Hz→2px、12.5Hz→8px，不再被归一化拉满。
    const narrow = gaps(bars({
      freq: [20, 20, 80, 80],
      intensity: [60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.max(...narrow)).toBe(8)
    expect(Math.min(...narrow)).toBe(2)

    // 宽域 [10,240] 覆盖两个极值（100Hz 1px / 1Hz clamp 20px）。
    const wide = gaps(bars({
      freq: [10, 10, 240, 240],
      intensity: [60, 60, 60, 60],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(new Set(wide)).toEqual(new Set([1, 20]))
  })

  it('matches the Coyote backend code->Hz table (one physical source of truth)', () => {
    // 与 packages/core 的 frequency.ts 对表：柱距 = clamp(1,20, 周期/10)，
    // 周期 = 1000/codeToHz(code)。9 根柱 → 8 个间隔，半像素码的均值精确。
    for (const code of [10, 11, 25, 50, 80, 90, 100, 110, 150, 200, 201, 240]) {
      const expected = Math.min(20, Math.max(1, Math.round((1000 / codeToHz(code) / 10) * 2) / 2))
      const observed = gaps(uniform(9, code, 60))
      const integers = Number.isInteger(expected) ? [expected] : [Math.floor(expected), Math.ceil(expected)]
      expect(new Set(observed)).toEqual(new Set(integers))
      expect(Math.abs(mean(observed) - expected)).toBeLessThan(0.01)
    }
    // 101 → 10.5px：相邻差 10/11 交替、均值精确 10.5。
    const halfPixel = gaps(uniform(9, 101, 60))
    expect(new Set(halfPixel)).toEqual(new Set([10, 11]))
    expect(Math.abs(mean(halfPixel) - 10.5)).toBeLessThan(0.01)
    // 121–240 在 20px 上限下不可区分；第三段（201–240）的斜率由与 core 的
    // codeToHz 对表（codeToHz 已含 610/1000ms）与独立探针保证，不是本测试能观测的量。
    for (const code of [121, 150, 200, 201, 240]) {
      expect(new Set(gaps(uniform(9, code, 60)))).toEqual(new Set([20]))
    }
  })

  it('gives real assets their physical density (pack slices + compiled builtins)', () => {
    // pack 0.4.0 编译后真实 slot 序列（前 17 个）：纤毛 50–80、微须 70–98。
    const cilia = gaps(bars({
      freq: [50, 52, 54, 56, 58, 59, 61, 63, 65, 67, 69, 71, 73, 74, 76, 78, 80],
      intensity: [15, 17, 19, 21, 23, 24, 26, 28, 30, 28, 26, 24, 22, 20, 18, 16, 15],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.min(...cilia)).toBeGreaterThanOrEqual(5)
    expect(Math.max(...cilia)).toBeLessThanOrEqual(8)

    const flutter = gaps(bars({
      freq: [70, 70, 71, 72, 73, 74, 76, 79, 81, 84, 87, 91, 98],
      intensity: [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90],
      width: WIDTH,
      height: HEIGHT,
      phase: 0,
    }))
    expect(Math.min(...flutter)).toBeGreaterThanOrEqual(7)
    expect(Math.max(...flutter)).toBeLessThanOrEqual(10)

    // 内置波形直接从 core 的编译结果取 slot（不是手写合成数组）：
    // breathing 恒 100Hz、tide 23.8–100Hz、climb 11.1–55.6Hz。
    const meanGapOf = (id: string): number => {
      const { freq, intensity } = builtinSlots(id)
      return mean(gaps(bars({ freq, intensity, width: WIDTH, height: HEIGHT, phase: 0 })))
    }
    const breathing = meanGapOf('breathing')
    const tide = meanGapOf('tide')
    const climb = meanGapOf('climb')
    expect(breathing).toBeLessThanOrEqual(1.01) // 100Hz → 1px
    expect(tide).toBeGreaterThanOrEqual(1)
    expect(tide).toBeLessThanOrEqual(5) // 23.8–100Hz → 1–4.2px
    expect(climb).toBeGreaterThanOrEqual(2) // 11.1–55.6Hz → 2–9px
    expect(climb).toBeLessThanOrEqual(10)
    // 平均物理频率越低 → 平均柱距越大（呼吸 100Hz < 潮汐 < 攀升 11–56Hz）。
    expect(breathing).toBeLessThan(tide)
    expect(tide).toBeLessThan(climb)
    // 跨资产方向：低频的微须（10–14Hz）比纤毛（12.5–20Hz）疏。
    expect(mean(flutter)).toBeGreaterThan(mean(cilia))

    // UI 实际路径先 2x 升采样再算柱距：升采样不改变物理映射的上下界。
    const upsampledGaps = (id: string): number[] => {
      const { freq, intensity } = builtinSlots(id)
      const smooth = chartMath.upsampleLinear(freq, intensity, 2)
      return gaps(bars({ freq: smooth.freq, intensity: smooth.intensity, width: WIDTH, height: HEIGHT, phase: 0 }))
    }
    const tide2x = upsampledGaps('tide')
    expect(Math.min(...tide2x)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...tide2x)).toBeLessThanOrEqual(5)
    const climb2x = upsampledGaps('climb')
    expect(Math.min(...climb2x)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...climb2x)).toBeLessThanOrEqual(10)
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
    // 恒定码 40 = 40ms 周期 → 4px 柱距：一帧总柱距 = 10 * 4 = 40px，是滚动周期。
    const base = uniform(10, 40, 60, 0)
    const cycle = 40
    // 最右一根柱贴住画布右缘（1px 柱 → x = width - 1）。
    expect(base[0]?.x).toBe(WIDTH - 1)
    // phase 增加 → 所有柱整体左移 2px（仍在画布内的那些；2 不是 4px 柱距的整数倍）。
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

    // variable spacing 的整帧总柱距也要取模：混合 freq [10,50,10,50] 的
    // 总柱距 = 1+5+1+5 = 12px，相位 ±12 与 0 等价。
    const mixed = { freq: [10, 50, 10, 50], intensity: [60, 60, 60, 60], width: WIDTH, height: HEIGHT }
    const mixedBase = bars({ ...mixed, phase: 0 })
    expect(bars({ ...mixed, phase: 12 })).toEqual(mixedBase)
    expect(bars({ ...mixed, phase: -12 })).toEqual(mixedBase)
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
