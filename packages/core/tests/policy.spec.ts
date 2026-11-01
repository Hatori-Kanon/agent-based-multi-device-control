import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MAX_DURATION_SEC,
  ABSOLUTE_MAX_PERCENT,
  ABSOLUTE_MAX_WAVE_INTENSITY,
  assertLevelWithinPolicy,
  assertValidPolicy,
  clampPercentToRange,
  DEFAULT_CHANNEL_POLICY,
  mapPercentThroughRange,
  MAX_FREQ,
  MIN_FREQ,
  parsePolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  PolicyStore,
  SafetyError,
  serializePolicySnapshot,
} from '../src/index.ts'

/** A four-point channel interval used by mapping and clamping tests. */
const RANGE = { minPercent: 10, maxPercent: 60 }

describe('channel policy', () => {
  it('ships a conservative default with a full frequency band', () => {
    expect(DEFAULT_CHANNEL_POLICY.minPercent).toBe(0)
    expect(DEFAULT_CHANNEL_POLICY.maxPercent).toBeLessThan(ABSOLUTE_MAX_PERCENT)
    expect(DEFAULT_CHANNEL_POLICY.maxDurationSec).toBeLessThan(ABSOLUTE_MAX_DURATION_SEC)
    // Internal pulse-width safety cap: 80 by default, not a UI/API option.
    expect(DEFAULT_CHANNEL_POLICY.maxWaveIntensity).toBe(80)
    expect(DEFAULT_CHANNEL_POLICY.maxWaveIntensity).toBeLessThan(ABSOLUTE_MAX_WAVE_INTENSITY)
    // Identity mapping: a waveform plays as authored until a human narrows it.
    expect(DEFAULT_CHANNEL_POLICY.minFreq).toBe(MIN_FREQ)
    expect(DEFAULT_CHANNEL_POLICY.maxFreq).toBe(MAX_FREQ)
  })

  it('refuses caps outside the absolute bounds even from a human', () => {
    const store = new PolicyStore()
    expect(() => store.setByHuman('toy', 'main', { maxPercent: 101 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxDurationSec: ABSOLUTE_MAX_DURATION_SEC + 1 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxPercent: 0 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { minPercent: 100 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxDurationSec: 0 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxWaveIntensity: ABSOLUTE_MAX_WAVE_INTENSITY + 1 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxWaveIntensity: -1 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxWaveIntensity: 45.5 })).toThrow(SafetyError)
    // The rejected writes left the effective policy untouched.
    expect(store.get('toy', 'main')).toEqual(DEFAULT_CHANNEL_POLICY)
  })

  it('requires an ordered, protocol-legal interval', () => {
    const valid = { minPercent: 10, maxPercent: 60, maxWaveIntensity: 80, minFreq: 20, maxFreq: 200, maxDurationSec: 30 }
    expect(() => assertValidPolicy(valid)).not.toThrow()

    expect(() => assertValidPolicy({ ...valid, minPercent: 60 })).toThrow(/less than maxPercent/)
    expect(() => assertValidPolicy({ ...valid, maxPercent: 10 })).toThrow(/less than maxPercent/)
    expect(() => assertValidPolicy({ ...valid, minFreq: 200 })).toThrow(/less than maxFreq/)
    expect(() => assertValidPolicy({ ...valid, maxFreq: 20 })).toThrow(/less than maxFreq/)
    expect(() => assertValidPolicy({ ...valid, minFreq: MIN_FREQ - 1 })).toThrow(/minFreq/)
    expect(() => assertValidPolicy({ ...valid, maxFreq: MAX_FREQ + 1 })).toThrow(/maxFreq/)
    expect(() => assertValidPolicy({ ...valid, maxPercent: 40.5 })).toThrow(/whole number/)
    expect(() => assertValidPolicy({ ...valid, minFreq: 20.5 })).toThrow(/whole number/)
    expect(() => assertValidPolicy({ ...valid, maxWaveIntensity: 101 })).toThrow(/maxWaveIntensity/)
    expect(() => assertValidPolicy({ ...valid, maxWaveIntensity: -1 })).toThrow(/maxWaveIntensity/)
    expect(() => assertValidPolicy({ ...valid, maxWaveIntensity: 45.5 })).toThrow(/whole number/)
  })

  it('reports the before and after values so a change can be audited', () => {
    const store = new PolicyStore()
    const change = store.setByHuman('toy', 'main', { minPercent: 5, maxPercent: 25 })
    expect(change.previous.maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
    expect(change.next.minPercent).toBe(5)
    expect(change.next.maxPercent).toBe(25)
    expect(store.get('toy', 'main').maxPercent).toBe(25)
    // Other channels keep the default.
    expect(store.get('toy', 'other').maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
  })

  it('supports frequency, duration and internal pulse-width patches independently', () => {
    const store = new PolicyStore()
    const change = store.setByHuman('coyote', 'a', {
      minFreq: 20,
      maxFreq: 120,
      maxDurationSec: 30,
      maxWaveIntensity: 45,
    })
    expect(change.next.minFreq).toBe(20)
    expect(change.next.maxFreq).toBe(120)
    expect(change.next.maxDurationSec).toBe(30)
    // The pulse-width cap is human-writable internally but never a model knob.
    expect(change.next.maxWaveIntensity).toBe(45)
    // Changing one field leaves the rest of the interval alone.
    expect(change.next.minPercent).toBe(DEFAULT_CHANNEL_POLICY.minPercent)
    expect(change.next.maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
  })

  it('exposes no way for a non-human caller to raise a cap', () => {
    const store = new PolicyStore()
    const names = new Set<string>()
    for (let proto: object | null = store; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
    }
    const mutators = [...names].filter(name => /^set/i.test(name)).sort()
    // Exactly two human-only setters: a per-channel interval and the session
    // ceiling. Neither has a model/engine counterpart (D4).
    expect(mutators).toEqual(['setByHuman', 'setSessionCeilingByHuman'])
  })
})

describe('level validation', () => {
  const policy = { minPercent: 10, maxPercent: 40, maxWaveIntensity: 80, minFreq: MIN_FREQ, maxFreq: MAX_FREQ, maxDurationSec: 60 }

  it('accepts the interval endpoints and rejects values outside it', () => {
    expect(() => { assertLevelWithinPolicy(policy, 10, 5) }).not.toThrow()
    expect(() => { assertLevelWithinPolicy(policy, 40, 5) }).not.toThrow()
    expect(() => { assertLevelWithinPolicy(policy, 9, 5) }).toThrow(/from 10 to 40/)
    try {
      assertLevelWithinPolicy(policy, 41, 5)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyError)
      expect((error as SafetyError).code).toBe('POLICY_PERCENT')
      // The message must state the actual bounds so the caller can correct itself.
      expect((error as SafetyError).message).toContain('40')
    }
  })

  it('rejects indefinite output', () => {
    try {
      assertLevelWithinPolicy(policy, 20, 0)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as SafetyError).code).toBe('POLICY_DURATION')
      expect((error as SafetyError).message).toMatch(/indefinite/)
    }
  })

  it('rejects a duration above the cap', () => {
    expect(() => { assertLevelWithinPolicy(policy, 20, 61) }).toThrow(/at most 60/)
  })

  it('treats percent 0 as an immediate stop even with a positive floor', () => {
    expect(() => { assertLevelWithinPolicy(policy, 0, 0) }).not.toThrow()
    expect(() => { assertLevelWithinPolicy(policy, 0, 5) }).toThrow(/stops immediately/)
  })

  it('rejects a non-integer percentage', () => {
    expect(() => { assertLevelWithinPolicy(policy, 20.5, 60) }).toThrow(/whole number/)
  })
})

describe('percent mapping through the channel interval', () => {
  it('maps 0, 1, 50 and 100 through [10, 60]', () => {
    expect(mapPercentThroughRange(RANGE, 0)).toBe(0)
    expect(mapPercentThroughRange(RANGE, 1)).toBe(11)
    expect(mapPercentThroughRange(RANGE, 50)).toBe(35)
    expect(mapPercentThroughRange(RANGE, 100)).toBe(60)
  })

  it('keeps 100 at the ceiling and lifts a positive request off zero on the default interval', () => {
    expect(mapPercentThroughRange({ minPercent: 0, maxPercent: 20 }, 0)).toBe(0)
    // Review S-3: 1% of [0, 20] rounds to 0, but 0 means "stop". A positive
    // request must produce the lightest non-zero output instead.
    expect(mapPercentThroughRange({ minPercent: 0, maxPercent: 20 }, 1)).toBe(1)
    expect(mapPercentThroughRange({ minPercent: 0, maxPercent: 20 }, 50)).toBe(10)
    expect(mapPercentThroughRange({ minPercent: 0, maxPercent: 20 }, 100)).toBe(20)
  })

  it('floors a tiny positive request at the interval minimum when one exists', () => {
    expect(mapPercentThroughRange(RANGE, 0.1)).toBe(RANGE.minPercent)
    expect(mapPercentThroughRange({ minPercent: 1, maxPercent: 20 }, 1)).toBe(1)
  })

  it('clamps relative input and fails closed on non-finite values', () => {
    expect(mapPercentThroughRange(RANGE, 150)).toBe(60)
    expect(mapPercentThroughRange(RANGE, Number.NaN)).toBe(0)
    expect(mapPercentThroughRange(RANGE, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('emit-path clamp', () => {
  it('clamps an absolute value into the interval', () => {
    expect(clampPercentToRange(RANGE, 80)).toBe(60)
    expect(clampPercentToRange(RANGE, 30)).toBe(30)
    expect(clampPercentToRange(RANGE, 10)).toBe(10)
    // Below the floor is lifted to it: direct control is absolute.
    expect(clampPercentToRange(RANGE, 1)).toBe(10)
  })

  it('fails closed on negative, zero, and non-finite input', () => {
    expect(clampPercentToRange(RANGE, 0)).toBe(0)
    expect(clampPercentToRange(RANGE, -5)).toBe(0)
    // NaN or Infinity here means an upstream calculation broke. Jumping to the
    // cap would be the worst possible response to a bug, so it fails to zero.
    expect(clampPercentToRange(RANGE, Number.NaN)).toBe(0)
    expect(clampPercentToRange(RANGE, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('lets a narrower session ceiling win over an impossible floor', () => {
    expect(clampPercentToRange({ minPercent: 50, maxPercent: 20 }, 80)).toBe(20)
  })
})

describe('session ceiling', () => {
  it('bounds every channel without touching the stored caps', () => {
    const store = new PolicyStore()
    store.setByHuman('coyote', 'a', { maxPercent: 40 })
    store.setSessionCeilingByHuman(25)

    expect(store.effective('coyote', 'a').maxPercent).toBe(25)
    // Other bounds are untouched; only the strength high end is bounded.
    expect(store.effective('coyote', 'a').minPercent).toBe(DEFAULT_CHANNEL_POLICY.minPercent)
    expect(store.effective('coyote', 'a').maxFreq).toBe(DEFAULT_CHANNEL_POLICY.maxFreq)
    // An unoverridden channel is bounded by the lower of default and ceiling.
    expect(store.effective('coyote', 'b').maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)

    // The stored cap is untouched, so releasing the ceiling restores it.
    expect(store.get('coyote', 'a').maxPercent).toBe(40)
    store.setSessionCeilingByHuman(100)
    expect(store.effective('coyote', 'a').maxPercent).toBe(40)
  })

  it('refuses a ceiling outside 0-100 and leaves the previous value in force', () => {
    const store = new PolicyStore()
    expect(() => store.setSessionCeilingByHuman(101)).toThrow(SafetyError)
    expect(() => store.setSessionCeilingByHuman(-1)).toThrow(SafetyError)
    expect(() => store.setSessionCeilingByHuman(12.5)).toThrow(SafetyError)
    expect(store.ceiling()).toBe(100)
  })

  it('keeps the effective interval ordered when the ceiling drops below the floor', () => {
    // Review S-1: [40, 60] narrowed by a legacy ceiling of 20 used to become
    // [40, 20], which is not a legal interval and rejects every positive level.
    const store = new PolicyStore()
    store.setByHuman('coyote', 'a', { minPercent: 40, maxPercent: 60 })
    store.setSessionCeilingByHuman(20)

    const effective = store.effective('coyote', 'a')
    expect(effective).toMatchObject({ minPercent: 19, maxPercent: 20 })
    expect(effective.minPercent).toBeLessThan(effective.maxPercent)
    // The ceiling is never raised to make the interval fit.
    expect(effective.maxPercent).toBe(20)
    // The stored base interval is untouched.
    expect(store.get('coyote', 'a')).toMatchObject({ minPercent: 40, maxPercent: 60 })
  })

  it('reports previous and next so a ceiling change can be audited', () => {
    const store = new PolicyStore()
    expect(store.setSessionCeilingByHuman(35)).toEqual({ previous: 100, next: 35 })
    expect(store.setSessionCeilingByHuman(100)).toEqual({ previous: 35, next: 100 })
  })
})

describe('policy persistence', () => {
  it('round-trips the explicit intervals and the ceiling', () => {
    const first = new PolicyStore()
    first.setByHuman('coyote', 'a', { minPercent: 5, maxPercent: 25, maxWaveIntensity: 45, minFreq: 20, maxFreq: 120 })
    // Hub channel ids contain colons; only the first one separates device id.
    first.setByHuman('buttplug', '0:1:vibrate', { maxPercent: 15 })
    first.setSessionCeilingByHuman(30)

    const text = serializePolicySnapshot(first.snapshot())
    const second = new PolicyStore()
    second.restore(parsePolicySnapshot(JSON.parse(text) as unknown))

    expect(second.get('coyote', 'a')).toEqual({
      minPercent: 5,
      maxPercent: 25,
      maxWaveIntensity: 45,
      minFreq: 20,
      maxFreq: 120,
      maxDurationSec: 60,
    })
    expect(second.get('buttplug', '0:1:vibrate').maxPercent).toBe(15)
    expect(second.ceiling()).toBe(30)
    // A channel that was never overridden keeps the conservative default.
    expect(second.get('coyote', 'b')).toEqual(DEFAULT_CHANNEL_POLICY)
  })

  it('round-trips an empty store with the default ceiling', () => {
    const text = serializePolicySnapshot(new PolicyStore().snapshot())
    const parsed = parsePolicySnapshot(JSON.parse(text) as unknown)
    expect(parsed.channels).toEqual({})
    expect(parsed.sessionCeiling).toBe(100)
  })

  it('writes version 2 files', () => {
    const text = serializePolicySnapshot(new PolicyStore().snapshot())
    expect(POLICY_SNAPSHOT_VERSION).toBe(2)
    expect(JSON.parse(text) as Record<string, unknown>).toMatchObject({ version: 2 })
  })

  it('migrates a version 1 file into version 2 semantics, preserving the pulse cap', () => {
    const parsed = parsePolicySnapshot({
      version: 1,
      sessionCeiling: 30,
      channels: {
        'coyote:a': { maxPercent: 25, maxWaveIntensity: 45, maxDurationSec: 45 },
      },
    })

    expect(parsed.migrated).toBe(true)
    expect(parsed.sessionCeiling).toBe(30)
    expect(parsed.channels['coyote:a']).toEqual({
      minPercent: 0,
      maxPercent: 25,
      maxWaveIntensity: 45,
      minFreq: MIN_FREQ,
      maxFreq: MAX_FREQ,
      maxDurationSec: 45,
    })

    // A migrated snapshot restores cleanly into a live store.
    const store = new PolicyStore()
    store.restore(parsed)
    expect(store.get('coyote', 'a')).toEqual(parsed.channels['coyote:a'])
    expect(store.ceiling()).toBe(30)

    // Writing it back produces a version 2 file that keeps the human's 45.
    const rewritten = serializePolicySnapshot(parsed)
    const stored = JSON.parse(rewritten) as Record<string, unknown>
    expect(stored['version']).toBe(2)
    expect(stored['channels']).toMatchObject({ 'coyote:a': { maxWaveIntensity: 45 } })
    expect(rewritten).not.toContain('"migrated"')
    const reread = parsePolicySnapshot(JSON.parse(rewritten) as unknown)
    expect(reread.migrated).toBeUndefined()
    expect(reread.channels['coyote:a']).toEqual(parsed.channels['coyote:a'])
  })

  it('defaults or clamps the version 1 pulse cap during migration', () => {
    const missing = parsePolicySnapshot({
      version: 1,
      sessionCeiling: 100,
      channels: { 'coyote:a': { maxPercent: 25, maxDurationSec: 45 } },
    })
    expect(missing.channels['coyote:a']?.maxWaveIntensity).toBe(80)

    const outOfRange = parsePolicySnapshot({
      version: 1,
      sessionCeiling: 100,
      channels: {
        'coyote:a': { maxPercent: 25, maxWaveIntensity: 140, maxDurationSec: 45 },
        'coyote:b': { maxPercent: 25, maxWaveIntensity: -3, maxDurationSec: 45 },
      },
    })
    expect(outOfRange.channels['coyote:a']?.maxWaveIntensity).toBe(100)
    expect(outOfRange.channels['coyote:b']?.maxWaveIntensity).toBe(0)
  })

  it('fails closed on an unsafe or unknown persisted file', () => {
    expect(() =>
      parsePolicySnapshot({
        version: 1,
        sessionCeiling: 100,
        channels: { 'coyote:a': { maxPercent: 101, maxWaveIntensity: 80, maxDurationSec: 60 } },
      })).toThrow(SafetyError)
    expect(() => parsePolicySnapshot({ version: 3, sessionCeiling: 100, channels: {} })).toThrow(/version/)
    expect(() => parsePolicySnapshot({ version: 1, sessionCeiling: 101, channels: {} })).toThrow(SafetyError)
    // A key without the device:channel shape is rejected, not silently dropped.
    expect(() =>
      parsePolicySnapshot({
        version: 1,
        sessionCeiling: 100,
        channels: { coyote: { maxPercent: 10, maxWaveIntensity: 80, maxDurationSec: 60 } },
      })).toThrow(/device:channel/)
    // A version 2 entry missing the new required fields is rejected.
    expect(() =>
      parsePolicySnapshot({
        version: 2,
        sessionCeiling: 100,
        channels: { 'coyote:a': { maxPercent: 10, maxDurationSec: 60 } },
      })).toThrow(SafetyError)
  })

  it('restores atomically: one bad entry leaves the store untouched', () => {
    const store = new PolicyStore()
    store.setByHuman('coyote', 'a', { maxPercent: 30 })

    expect(() =>
      store.restore({
        channels: {
          'coyote:a': { minPercent: 0, maxPercent: 10, maxWaveIntensity: 80, minFreq: MIN_FREQ, maxFreq: MAX_FREQ, maxDurationSec: 60 },
          nope: { minPercent: 0, maxPercent: 10, maxWaveIntensity: 80, minFreq: MIN_FREQ, maxFreq: MAX_FREQ, maxDurationSec: 60 },
        },
        sessionCeiling: 50,
      })).toThrow(SafetyError)

    expect(store.get('coyote', 'a').maxPercent).toBe(30)
    expect(store.ceiling()).toBe(100)
  })

  it('allows restore once, at startup, and never over in-process caps', () => {
    // Review blocker A-2: `restore` must not become a third raise path.
    const store = new PolicyStore()
    store.restore({ channels: {}, sessionCeiling: 100 })
    expect(() => store.restore({ channels: {}, sessionCeiling: 100 })).toThrow(/only be called once/)

    const other = new PolicyStore()
    other.setByHuman('coyote', 'a', { maxPercent: 10 })
    expect(() =>
      other.restore({
        channels: {
          'coyote:a': { minPercent: 0, maxPercent: 90, maxWaveIntensity: 80, minFreq: MIN_FREQ, maxFreq: MAX_FREQ, maxDurationSec: 60 },
        },
        sessionCeiling: 100,
      }),
    ).toThrow(/cannot overwrite/)
    expect(other.get('coyote', 'a').maxPercent).toBe(10)
  })

  it('refuses a device id that would make the persisted key non-injective', () => {
    const store = new PolicyStore()
    // `a:b` + `c` and `a` + `b:c` would both serialize to "a:b:c".
    expect(() => store.setByHuman('a:b', 'c', { maxPercent: 10 })).toThrow(SafetyError)
    expect(() => store.setByHuman('a', 'b\u0000c', { maxPercent: 10 })).toThrow(SafetyError)
    // Hub channel ids legitimately contain colons.
    expect(() => store.setByHuman('buttplug', '0:1:vibrate', { maxPercent: 10 })).not.toThrow()
  })
})
