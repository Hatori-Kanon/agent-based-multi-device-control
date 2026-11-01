import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MAX_DURATION_SEC,
  ABSOLUTE_MAX_PERCENT,
  ABSOLUTE_MAX_WAVE_INTENSITY,
  assertLevelWithinPolicy,
  assertValidPolicy,
  clampPercentToPolicy,
  DEFAULT_CHANNEL_POLICY,
  parsePolicySnapshot,
  PolicyStore,
  SafetyError,
  serializePolicySnapshot,
} from '../src/index.ts'

describe('channel policy', () => {
  it('ships a conservative default', () => {
    expect(DEFAULT_CHANNEL_POLICY.maxPercent).toBeLessThan(ABSOLUTE_MAX_PERCENT)
    expect(DEFAULT_CHANNEL_POLICY.maxDurationSec).toBeLessThan(ABSOLUTE_MAX_DURATION_SEC)
  })

  it('refuses caps outside the absolute bounds even from a human', () => {
    const store = new PolicyStore()
    expect(() => store.setByHuman('toy', 'main', { maxPercent: 101 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxDurationSec: ABSOLUTE_MAX_DURATION_SEC + 1 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxPercent: -1 })).toThrow(SafetyError)
    expect(() => store.setByHuman('toy', 'main', { maxDurationSec: 0 })).toThrow(SafetyError)
    // The rejected writes left the effective policy untouched.
    expect(store.get('toy', 'main')).toEqual(DEFAULT_CHANNEL_POLICY)
  })

  it('reports the before and after values so a change can be audited', () => {
    const store = new PolicyStore()
    const change = store.setByHuman('toy', 'main', { maxPercent: 25 })
    expect(change.previous.maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
    expect(change.next.maxPercent).toBe(25)
    expect(store.get('toy', 'main').maxPercent).toBe(25)
    // Other channels keep the default.
    expect(store.get('toy', 'other').maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
  })

  it('exposes no way for a non-human caller to raise a cap', () => {
    const store = new PolicyStore()
    const names = new Set<string>()
    for (let proto: object | null = store; proto !== null; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name)
    }
    const mutators = [...names].filter(name => /^set/i.test(name)).sort()
    // Exactly two human-only setters: a per-channel cap and the session
    // ceiling. Neither has a model/engine counterpart (D4).
    expect(mutators).toEqual(['setByHuman', 'setSessionCeilingByHuman'])
  })

  it('validates a policy object directly', () => {
    expect(() => { assertValidPolicy({ maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }) }).not.toThrow()
    expect(() => { assertValidPolicy({ maxPercent: 40.5, maxWaveIntensity: 80, maxDurationSec: 60 }) }).toThrow(/whole number/)
  })

  it('bounds waveform intensity separately from amplitude', () => {
    const store = new PolicyStore()
    // Pulse width and amplitude are orthogonal: one bounds how wide each pulse
    // is, the other how much voltage is behind it.
    expect(DEFAULT_CHANNEL_POLICY.maxWaveIntensity).toBeLessThan(ABSOLUTE_MAX_WAVE_INTENSITY)
    expect(() => store.setByHuman('coyote', 'a', { maxWaveIntensity: 101 })).toThrow(/maxWaveIntensity/)
    expect(() => store.setByHuman('coyote', 'a', { maxWaveIntensity: -1 })).toThrow(/maxWaveIntensity/)

    const change = store.setByHuman('coyote', 'a', { maxWaveIntensity: 55 })
    expect(change.next.maxWaveIntensity).toBe(55)
    // Changing one bound leaves the others alone.
    expect(change.next.maxPercent).toBe(DEFAULT_CHANNEL_POLICY.maxPercent)
    expect(change.next.maxDurationSec).toBe(DEFAULT_CHANNEL_POLICY.maxDurationSec)
  })
})

describe('level validation', () => {
  const policy = { maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }

  it('rejects a percentage above the cap', () => {
    try {
      assertLevelWithinPolicy(policy, 41, 5)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(SafetyError)
      expect((error as SafetyError).code).toBe('POLICY_PERCENT')
      // The message must state the actual bound so the model can correct itself.
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

  it('treats percent 0 as an immediate stop', () => {
    expect(() => { assertLevelWithinPolicy(policy, 0, 0) }).not.toThrow()
    expect(() => { assertLevelWithinPolicy(policy, 0, 5) }).toThrow(/stops immediately/)
  })

  it('accepts a valid command', () => {
    expect(() => { assertLevelWithinPolicy(policy, 40, 60) }).not.toThrow()
  })
})

describe('emit-path clamp', () => {
  const policy = { maxPercent: 40, maxWaveIntensity: 80, maxDurationSec: 60 }

  it('never raises a value', () => {
    expect(clampPercentToPolicy(policy, 80)).toBe(40)
    expect(clampPercentToPolicy(policy, 10)).toBe(10)
  })

  it('fails closed on negative, zero, and non-finite input', () => {
    expect(clampPercentToPolicy(policy, 0)).toBe(0)
    expect(clampPercentToPolicy(policy, -5)).toBe(0)
    // NaN or Infinity here means an upstream calculation broke. Jumping to the
    // cap would be the worst possible response to a bug, so it fails to zero.
    expect(clampPercentToPolicy(policy, Number.NaN)).toBe(0)
    expect(clampPercentToPolicy(policy, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('session ceiling', () => {
  it('bounds every channel without touching the stored caps', () => {
    const store = new PolicyStore()
    store.setByHuman('coyote', 'a', { maxPercent: 40 })
    store.setSessionCeilingByHuman(25)

    expect(store.effective('coyote', 'a').maxPercent).toBe(25)
    // Other bounds are untouched; only amplitude is bounded by the ceiling.
    expect(store.effective('coyote', 'a').maxWaveIntensity).toBe(DEFAULT_CHANNEL_POLICY.maxWaveIntensity)
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

  it('reports previous and next so a ceiling change can be audited', () => {
    const store = new PolicyStore()
    expect(store.setSessionCeilingByHuman(35)).toEqual({ previous: 100, next: 35 })
    expect(store.setSessionCeilingByHuman(100)).toEqual({ previous: 35, next: 100 })
  })
})

describe('policy persistence', () => {
  it('round-trips the explicit overrides and the ceiling', () => {
    const first = new PolicyStore()
    first.setByHuman('coyote', 'a', { maxPercent: 25 })
    // Hub channel ids contain colons; only the first one separates device id.
    first.setByHuman('buttplug', '0:1:vibrate', { maxPercent: 15 })
    first.setSessionCeilingByHuman(30)

    const text = serializePolicySnapshot(first.snapshot())
    const second = new PolicyStore()
    second.restore(parsePolicySnapshot(JSON.parse(text) as unknown))

    expect(second.get('coyote', 'a').maxPercent).toBe(25)
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

  it('fails closed on an unsafe or unknown persisted file', () => {
    expect(() =>
      parsePolicySnapshot({
        version: 1,
        sessionCeiling: 100,
        channels: { 'coyote:a': { maxPercent: 101, maxWaveIntensity: 80, maxDurationSec: 60 } },
      })).toThrow(SafetyError)
    expect(() => parsePolicySnapshot({ version: 2, sessionCeiling: 100, channels: {} })).toThrow(/version/)
    expect(() => parsePolicySnapshot({ version: 1, sessionCeiling: 101, channels: {} })).toThrow(SafetyError)
    // A key without the device:channel shape is rejected, not silently dropped.
    expect(() =>
      parsePolicySnapshot({
        version: 1,
        sessionCeiling: 100,
        channels: { coyote: { maxPercent: 10, maxWaveIntensity: 80, maxDurationSec: 60 } },
      })).toThrow(/device:channel/)
  })

  it('restores atomically: one bad entry leaves the store untouched', () => {
    const store = new PolicyStore()
    store.setByHuman('coyote', 'a', { maxPercent: 30 })

    expect(() =>
      store.restore({
        channels: {
          'coyote:a': { maxPercent: 10, maxWaveIntensity: 80, maxDurationSec: 60 },
          nope: { maxPercent: 10, maxWaveIntensity: 80, maxDurationSec: 60 },
        },
        sessionCeiling: 50,
      })).toThrow(SafetyError)

    expect(store.get('coyote', 'a').maxPercent).toBe(30)
    expect(store.ceiling()).toBe(100)
  })
})
