/**
 * The freeform intent table and the only place narrative intensity becomes a
 * number.
 *
 * A freeform pack carries no `scenario.json`, so the engine supplies these
 * five intents and the resolver converts `strength`/`preset` through the
 * constants below (`内容包规范.md` §5, `M2-实施计划.md` §4.4). Keeping every
 * number here is deliberate: retuning the feel of the device is a one-file
 * change, and no other module is allowed to invent a percentage.
 *
 * D8 freeze (2026-11-01): `low=40% / med=70% / high=100%` of the channel cap.
 * The earlier draft's 50/80/100 is retired.
 */

import type { EnvelopePreset } from '../devices/effect.ts'
import type { FeedbackIntent } from './intents.ts'

/**
 * Percentage of a channel's cap that each narrative strength requests.
 *
 * Everything downstream (`resolvePlan`, the executor, the audit) reads this
 * table; no other module may hard-code an intensity number.
 */
export const STRENGTH_RATIO = { low: 0.4, med: 0.7, high: 1 } as const

/** Default envelope shape per preset: `min = round(max × minRatio)`. */
export const ENVELOPE_DEFAULTS: Record<EnvelopePreset, { minRatio: number; periodMs: number; jitter: number }> = {
  steady: { minRatio: 1, periodMs: 1_000, jitter: 0 },
  pulse: { minRatio: 0.35, periodMs: 1_200, jitter: 0 },
  wave: { minRatio: 0.35, periodMs: 4_000, jitter: 0 },
  random: { minRatio: 0.35, periodMs: 2_000, jitter: 10 },
  ramp: { minRatio: 0.35, periodMs: 8_000, jitter: 0 },
}

/**
 * The five freeform intents (`内容包规范.md` §5, "默认意图表").
 *
 * Every default intent uses the wildcard `whole-body` region because that is
 * all a freeform pack declares (§5 S13); distribution is what turns
 * `whole-body` into "one part" for a probe and "every part" for ambience.
 *
 * `stop` resolves specially in `resolvePlan`: it emits a zero level, which
 * `DeviceRegistry.setLevel(..., 0, ...)` routes to `stop`.
 */
export const DEFAULT_INTENTS: readonly FeedbackIntent[] = [
  {
    id: 'probe-touch',
    meaning: '短促试探',
    regions: ['whole-body'],
    distribution: 'primary',
    suggest: { preset: 'pulse', durationSec: 2, strength: 'low' },
  },
  {
    id: 'ambient-field',
    meaning: '持续环境',
    regions: ['whole-body'],
    distribution: 'synced',
    suggest: { preset: 'wave', waveform: 'tide', durationSec: 30, strength: 'med' },
  },
  {
    id: 'escalate-step',
    meaning: '加一档',
    regions: ['whole-body'],
    distribution: 'primary',
    // No preset: a plain level holds the current texture instead of
    // restarting it, which is what "one step up" should feel like.
    suggest: { durationSec: 8, strength: 'med' },
  },
  {
    id: 'soothe',
    meaning: '安抚/降档',
    regions: ['whole-body'],
    distribution: 'synced',
    suggest: { preset: 'wave', waveform: 'breathing', durationSec: 20, strength: 'low' },
  },
  {
    id: 'stop',
    meaning: '停下',
    regions: ['whole-body'],
    distribution: 'synced',
    suggest: { durationSec: 1, strength: 'low' },
  },
]
