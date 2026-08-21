import { describe, expect, it } from 'vitest'
import { assertValidEnvelope, createEnvelopeSampler, EffectRunner, FakeClock, SafetyError, type Envelope } from '../src/index.ts'

function steady(percent: number): Envelope {
  return { preset: 'steady', minPercent: percent, maxPercent: percent, periodMs: 1_000, jitter: 0 }
}

function harness() {
  const clock = new FakeClock()
  const emitted: number[] = []
  const errors: unknown[] = []
  const finished: number[] = []
  const runner = new EffectRunner({
    clock,
    emit: percent => { emitted.push(percent); return Promise.resolve() },
    onError: error => { errors.push(error) },
    onFinished: () => { finished.push(clock.now()) },
    tickMs: 50,
    random: () => 0.5,
  })
  return { clock, emitted, errors, finished, runner }
}

describe('envelope sampler', () => {
  it('holds a steady level', () => {
    const sampler = createEnvelopeSampler(steady(30), () => 0.5)
    expect(sampler.valueAt(0)).toBe(30)
    expect(sampler.valueAt(777)).toBe(30)
  })

  it('alternates a pulse between max and min each half period', () => {
    const sampler = createEnvelopeSampler(
      { preset: 'pulse', minPercent: 5, maxPercent: 40, periodMs: 1_000, jitter: 0 },
      () => 0.5,
    )
    expect(sampler.valueAt(0)).toBe(40)
    expect(sampler.valueAt(499)).toBe(40)
    expect(sampler.valueAt(500)).toBe(5)
    expect(sampler.valueAt(999)).toBe(5)
    expect(sampler.valueAt(1_000)).toBe(40)
  })

  it('traces a full sine cycle for wave', () => {
    const sampler = createEnvelopeSampler(
      { preset: 'wave', minPercent: 0, maxPercent: 100, periodMs: 400, jitter: 0 },
      () => 0.5,
    )
    expect(sampler.valueAt(0)).toBe(0)
    expect(sampler.valueAt(100)).toBe(50)
    expect(sampler.valueAt(200)).toBe(100)
    expect(sampler.valueAt(300)).toBe(50)
  })

  it('rises then holds for ramp', () => {
    const sampler = createEnvelopeSampler(
      { preset: 'ramp', minPercent: 10, maxPercent: 30, periodMs: 1_000, jitter: 0 },
      () => 0.5,
    )
    expect(sampler.valueAt(0)).toBe(10)
    expect(sampler.valueAt(500)).toBe(20)
    expect(sampler.valueAt(1_000)).toBe(30)
    expect(sampler.valueAt(9_999)).toBe(30)
  })

  it('holds a random draw for a whole period instead of jumping every tick', () => {
    const draws = [0.25, 0.75]
    let index = 0
    const sampler = createEnvelopeSampler(
      { preset: 'random', minPercent: 0, maxPercent: 100, periodMs: 1_000, jitter: 0 },
      () => draws[index++ % draws.length] ?? 0,
    )
    const first = sampler.valueAt(0)
    expect(sampler.valueAt(400)).toBe(first)
    expect(sampler.valueAt(900)).toBe(first)
    // A new period redraws.
    expect(sampler.valueAt(1_000)).not.toBe(first)
  })

  it('keeps jitter inside the min-max range', () => {
    const sampler = createEnvelopeSampler(
      { preset: 'steady', minPercent: 20, maxPercent: 30, periodMs: 200, jitter: 100 },
      () => 1,
    )
    for (let t = 0; t < 2_000; t += 50) {
      const value = sampler.valueAt(t)
      expect(value).toBeGreaterThanOrEqual(20)
      expect(value).toBeLessThanOrEqual(30)
    }
  })
})

describe('envelope validation', () => {
  it('rejects a max above the channel cap', () => {
    expect(() => { assertValidEnvelope(steady(50), 40) }).toThrow(/must not exceed 40/)
  })

  it('rejects inverted bounds', () => {
    expect(() => {
      assertValidEnvelope({ preset: 'wave', minPercent: 30, maxPercent: 10, periodMs: 1_000, jitter: 0 }, 40)
    }).toThrow(/must not exceed maxPercent/)
  })

  it('rejects a period below the floor and bad jitter', () => {
    expect(() => {
      assertValidEnvelope({ preset: 'wave', minPercent: 0, maxPercent: 10, periodMs: 10, jitter: 0 }, 40)
    }).toThrow(/periodMs/)
    expect(() => {
      assertValidEnvelope({ preset: 'wave', minPercent: 0, maxPercent: 10, periodMs: 1_000, jitter: 101 }, 40)
    }).toThrow(/jitter/)
  })

  it('reports a SafetyError so the caller can branch on the code', () => {
    try {
      assertValidEnvelope(steady(99), 40)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyError)
      expect((error as SafetyError).code).toBe('POLICY_ENVELOPE')
    }
  })
})

describe('EffectRunner', () => {
  it('emits immediately and deduplicates an unchanged steady level', async () => {
    const { clock, emitted, runner } = harness()
    runner.start(steady(30), 5_000)
    await runner.settled()
    expect(emitted).toEqual([30])

    clock.advance(1_000)
    await runner.settled()
    // Twenty ticks passed; a steady level needs no repeat traffic.
    expect(emitted).toEqual([30])
  })

  it('drives output to zero and reports completion when the duration elapses', async () => {
    const { clock, emitted, finished, runner } = harness()
    runner.start(steady(30), 200)
    await runner.settled()
    clock.advance(200)
    await runner.settled()
    expect(emitted).toEqual([30, 0])
    expect(finished).toHaveLength(1)
    expect(runner.active).toBe(false)

    clock.advance(5_000)
    await runner.settled()
    expect(emitted).toEqual([30, 0])
  })

  it('does not let a superseded effect stop a newer one', async () => {
    const { clock, emitted, runner } = harness()
    runner.start(steady(30), 1_000)
    await runner.settled()
    clock.advance(950)
    await runner.settled()

    // Replace the effect just before the old deadline would fire.
    runner.start(steady(35), 5_000)
    await runner.settled()
    expect(emitted).toEqual([30, 35])

    clock.advance(300)
    await runner.settled()
    // The old generation's terminal zero must not reach through.
    expect(emitted).toEqual([30, 35])
    expect(runner.active).toBe(true)
  })

  it('re-writes the same level after output was zeroed out of band', async () => {
    const { emitted, runner } = harness()
    runner.start(steady(30), 5_000)
    await runner.settled()
    // The registry cancels the effect and writes zero through its own path,
    // so the runner must not treat the next request as a duplicate.
    runner.cancel()
    runner.start(steady(30), 5_000)
    await runner.settled()
    expect(emitted).toEqual([30, 30])
  })

  it('coalesces to the newest value when a write outlasts a tick', async () => {
    const clock = new FakeClock()
    const emitted: number[] = []
    let release: (() => void) | undefined
    const runner = new EffectRunner({
      clock,
      emit: percent => {
        emitted.push(percent)
        return new Promise<void>(resolve => { release = resolve })
      },
      onError: () => {},
      tickMs: 50,
      random: () => 0.5,
    })

    runner.start({ preset: 'wave', minPercent: 0, maxPercent: 100, periodMs: 400, jitter: 0 }, 10_000)
    expect(emitted).toEqual([0])

    // Three ticks land while the first write is still in flight.
    clock.advance(50)
    clock.advance(50)
    clock.advance(50)
    release?.()
    await Promise.resolve()
    await Promise.resolve()

    // Only the newest sample follows; 15 and 50 were dropped as stale.
    expect(emitted).toEqual([0, 85])
  })

  it('retries a value whose write failed instead of deduplicating it away', async () => {
    const clock = new FakeClock()
    const emitted: number[] = []
    const errors: unknown[] = []
    let failNext = true
    const runner = new EffectRunner({
      clock,
      emit: percent => {
        emitted.push(percent)
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('link busy'))
        }
        return Promise.resolve()
      },
      onError: error => { errors.push(error) },
      tickMs: 50,
      random: () => 0.5,
    })

    runner.start(steady(30), 5_000)
    await runner.settled()
    expect(emitted).toEqual([30])
    expect(errors).toHaveLength(1)

    clock.advance(50)
    await runner.settled()
    expect(emitted).toEqual([30, 30])
  })
})
