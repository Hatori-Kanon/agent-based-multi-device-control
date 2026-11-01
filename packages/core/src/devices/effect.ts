/**
 * Per-channel background effect scheduling.
 *
 * One runner owns one `(device, channel)` pair. It answers a single question
 * on every tick — "what is the target level right now" — and hands the answer
 * to the backend, which owns keep-alive.
 *
 * Two correctness properties are load-bearing:
 *
 * 1. **Generation tokens.** Every `start` invalidates the previous generation,
 *    so a tick or terminal stop belonging to an older effect can never reach
 *    through and zero a newer one. This is the race that a naive
 *    `setTimeout(stop, duration)` design gets wrong.
 * 2. **Coalesced emits.** Emits are serialised with last-write-wins. If a
 *    transport write takes longer than a tick, intermediate values are
 *    dropped rather than queued, because a stale level is never worth sending.
 */

import { SafetyError } from './errors.ts'
import type { Clock, Timer } from '../ports/clock.ts'

/** Default scheduling granularity, aligned with the Coyote 100 ms frame. */
export const DEFAULT_TICK_MS = 50

/** Shortest envelope period a caller may request. */
export const MIN_PERIOD_MS = 100

/** Shape of the amplitude curve over time. */
export type EnvelopePreset = 'steady' | 'pulse' | 'wave' | 'random' | 'ramp'

/**
 * An amplitude curve.
 *
 * `periodMs` means different things per preset: the full cycle for `pulse` and
 * `wave`, the redraw interval for `random`, the rise time for `ramp`, and
 * nothing at all for `steady`. `jitter` perturbs the value once per period
 * rather than per tick, so it reads as variation instead of noise.
 */
export interface Envelope {
  readonly preset: EnvelopePreset
  readonly minPercent: number
  readonly maxPercent: number
  readonly periodMs: number
  /** Perturbation as a percentage of the min-max range, 0-100. */
  readonly jitter: number
}

/** What the UI and the model see about a running effect. */
export interface EffectSnapshot {
  readonly preset: EnvelopePreset
  readonly minPercent: number
  readonly maxPercent: number
  readonly periodMs: number
  readonly jitter: number
  readonly remainingMs: number
}

export interface EffectRunnerOptions {
  readonly clock: Clock
  /** Send one level to the transport. */
  readonly emit: (percent: number) => Promise<void>
  /** Receives transport failures; the runner keeps ticking. */
  readonly onError: (error: unknown) => void
  /** Called after the effect ends on its own and output has reached zero. */
  readonly onFinished?: () => void
  readonly tickMs?: number
  /** Injectable randomness for deterministic tests. */
  readonly random?: () => number
}

function whole(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

/** Reject an envelope that is malformed or outside the channel cap. */
export function assertValidEnvelope(envelope: Envelope, maxPercent: number): void {
  const { preset, minPercent, maxPercent: envMax, periodMs, jitter } = envelope
  if (!['steady', 'pulse', 'wave', 'random', 'ramp'].includes(preset)) {
    throw new SafetyError('POLICY_ENVELOPE', `unknown preset: ${String(preset)}`)
  }
  if (!whole(minPercent) || !whole(envMax) || minPercent < 0 || envMax < 0) {
    throw new SafetyError('POLICY_ENVELOPE', 'minPercent and maxPercent must be whole numbers of at least 0')
  }
  if (minPercent > envMax) {
    throw new SafetyError('POLICY_ENVELOPE', 'minPercent must not exceed maxPercent')
  }
  if (envMax > maxPercent) {
    throw new SafetyError('POLICY_ENVELOPE', `maxPercent must not exceed ${maxPercent} for this channel`)
  }
  if (!whole(periodMs) || periodMs < MIN_PERIOD_MS) {
    throw new SafetyError('POLICY_ENVELOPE', `periodMs must be a whole number of at least ${MIN_PERIOD_MS}`)
  }
  if (!whole(jitter) || jitter < 0 || jitter > 100) {
    throw new SafetyError('POLICY_ENVELOPE', 'jitter must be a whole number from 0 to 100')
  }
}

/**
 * Play a caller-authored envelope inside the channel cap: the cap is the
 * human's boundary, so an authored pattern that asks for more is tightened to
 * it rather than refused (the device would be clamped downstream anyway).
 * Shape problems (negative, min>max, odd preset) are still the caller's bug
 * and stay refusals.
 */
export function clampEnvelopeToCap(envelope: Envelope, maxPercent: number): Envelope {
  const capped = Math.min(envelope.maxPercent, maxPercent)
  if (capped === envelope.maxPercent && envelope.minPercent <= capped) return envelope
  return { ...envelope, maxPercent: capped, minPercent: Math.min(envelope.minPercent, capped) }
}

/**
 * Fit an envelope inside the channel's output interval.
 *
 * Both ends are clamped: a floor below `minPercent` is lifted to it, and a
 * peak above `maxPercent` is lowered to it, so an authored pattern plays
 * across the human's band instead of being refused. A zero envelope (silence)
 * is left alone rather than lifted to the floor, because 0 means "stop".
 */
export function clampEnvelopeToRange(envelope: Envelope, minPercent: number, maxPercent: number): Envelope {
  if (envelope.maxPercent <= 0) return envelope
  // A legacy session ceiling can leave the floor above the ceiling; safety
  // wins, so the effective floor is the lower of the two.
  const floor = Math.min(minPercent, maxPercent)
  const upper = Math.max(floor, Math.min(envelope.maxPercent, maxPercent))
  const lower = Math.min(Math.max(envelope.minPercent, floor), upper)
  if (lower === envelope.minPercent && upper === envelope.maxPercent) return envelope
  return { ...envelope, minPercent: lower, maxPercent: upper }
}

/** Stateful sampler for one envelope. */
export interface EnvelopeSampler {
  valueAt(elapsedMs: number): number
}

/**
 * Build a sampler.
 *
 * `random` and `jitter` hold their drawn value for a whole period, so the
 * sampler is stateful rather than a pure function of elapsed time.
 */
export function createEnvelopeSampler(envelope: Envelope, random: () => number = Math.random): EnvelopeSampler {
  const { preset, minPercent, maxPercent, periodMs, jitter } = envelope
  const range = maxPercent - minPercent
  let drawnStep = -1
  let drawnBase = maxPercent
  let drawnJitter = 0

  const base = (elapsedMs: number, step: number): number => {
    switch (preset) {
      case 'steady':
        return maxPercent
      case 'pulse':
        return elapsedMs % periodMs < periodMs / 2 ? maxPercent : minPercent
      case 'wave': {
        const phase = (elapsedMs % periodMs) / periodMs
        return minPercent + (range * (1 - Math.cos(2 * Math.PI * phase))) / 2
      }
      case 'random': {
        if (step !== drawnStep) drawnBase = minPercent + range * random()
        return drawnBase
      }
      case 'ramp': {
        const progress = Math.min(1, elapsedMs / periodMs)
        return minPercent + range * progress
      }
    }
  }

  return {
    valueAt(elapsedMs: number): number {
      const step = Math.floor(elapsedMs / periodMs)
      const value = base(elapsedMs, step)
      if (step !== drawnStep) {
        drawnJitter = jitter === 0 ? 0 : ((random() * 2 - 1) * jitter * range) / 100
        drawnStep = step
      }
      const jittered = value + drawnJitter
      return Math.max(minPercent, Math.min(maxPercent, Math.round(jittered)))
    },
  }
}

export class EffectRunner {
  private generation = 0
  private ticker: Timer | undefined
  private sampler: EnvelopeSampler | undefined
  private envelope: Envelope | undefined
  private startedAt = 0
  private durationMs = 0
  /**
   * Last value *requested*, not last value written.
   *
   * Deduplicating against the written value is wrong: a terminal zero can
   * still be in flight when the next effect requests the level it replaces,
   * and the request would be dropped as a duplicate — leaving the device at
   * zero while the runner believes it is driving.
   */
  private lastRequested: number | undefined
  private queued: { percent: number; force: boolean } | undefined
  private emitting = false
  private drainPromise: Promise<void> = Promise.resolve()

  constructor(private readonly options: EffectRunnerOptions) {}

  get active(): boolean {
    return this.ticker !== undefined
  }

  /**
   * Begin an effect, replacing any effect already running on this channel.
   *
   * The previous generation is invalidated first, so its pending tick and
   * terminal stop become no-ops instead of interfering with this one.
   */
  start(envelope: Envelope, durationMs: number): void {
    this.cancelTicker()
    const generation = ++this.generation
    // A fresh effect always writes its first value: output may have been
    // zeroed out of band by a registry stop that this runner never saw.
    this.lastRequested = undefined
    this.envelope = envelope
    this.sampler = createEnvelopeSampler(envelope, this.options.random ?? Math.random)
    this.startedAt = this.options.clock.now()
    this.durationMs = durationMs
    const tickMs = this.options.tickMs ?? DEFAULT_TICK_MS
    this.ticker = this.options.clock.interval(tickMs, () => { this.tick(generation) })
    this.emitCurrent(generation)
  }

  /** Drop the effect without touching output. The caller must stop the device. */
  cancel(): void {
    this.cancelTicker()
    this.generation += 1
    this.envelope = undefined
    this.sampler = undefined
    this.lastRequested = undefined
  }

  /** Drop the effect and drive output to zero, awaiting the write. */
  async stop(): Promise<void> {
    this.cancel()
    this.request(0, true)
    await this.settled()
  }

  /** Resolve once no emit is in flight. */
  async settled(): Promise<void> {
    while (this.emitting) await this.drainPromise
  }

  /**
   * Forget the deduplication memory without disturbing the effect.
   *
   * The registry calls this when a human moves a cap: the sampler still
   * returns the same value, so without this the next tick would deduplicate
   * and the new cap would not reach the device until the value happened to
   * change on its own.
   */
  invalidate(): void {
    this.lastRequested = undefined
  }

  snapshot(): EffectSnapshot | undefined {
    const envelope = this.envelope
    if (envelope === undefined || this.ticker === undefined) return undefined
    const elapsed = this.options.clock.now() - this.startedAt
    return {
      preset: envelope.preset,
      minPercent: envelope.minPercent,
      maxPercent: envelope.maxPercent,
      periodMs: envelope.periodMs,
      jitter: envelope.jitter,
      remainingMs: Math.max(0, this.durationMs - elapsed),
    }
  }

  private tick(generation: number): void {
    if (generation !== this.generation) return
    const elapsed = this.options.clock.now() - this.startedAt
    if (elapsed >= this.durationMs) {
      this.cancelTicker()
      this.envelope = undefined
      this.sampler = undefined
      this.request(0, true)
      void this.settled().then(() => {
        if (generation !== this.generation) return
        this.options.onFinished?.()
      })
      return
    }
    this.emitCurrent(generation)
  }

  private emitCurrent(generation: number): void {
    if (generation !== this.generation) return
    const sampler = this.sampler
    if (sampler === undefined) return
    const elapsed = this.options.clock.now() - this.startedAt
    this.request(sampler.valueAt(elapsed), false)
  }

  private cancelTicker(): void {
    this.ticker?.cancel()
    this.ticker = undefined
  }

  private request(percent: number, force: boolean): void {
    if (!force && percent === this.lastRequested) return
    this.lastRequested = percent
    this.queued = { percent, force }
    if (this.emitting) return
    this.emitting = true
    this.drainPromise = this.drain()
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const next = this.queued
        this.queued = undefined
        if (next === undefined) break
        try {
          await this.options.emit(next.percent)
        } catch (error) {
          // Forget the request so the next tick retries the same value rather
          // than deduplicating against a write that never landed.
          if (this.lastRequested === next.percent) this.lastRequested = undefined
          this.options.onError(error)
        }
      }
    } finally {
      this.emitting = false
    }
  }
}
