import { describe, expect, it } from 'vitest'
import {
  ABSOLUTE_MAX_DURATION_SEC,
  ABSOLUTE_MAX_PERCENT,
  ABSOLUTE_MAX_WAVE_INTENSITY,
  assertLevelWithinPolicy,
  assertValidPolicy,
  clampPercentToPolicy,
  DEFAULT_CHANNEL_POLICY,
  PolicyStore,
  SafetyError,
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
    const mutators = [...names].filter(name => /^set/i.test(name))
    expect(mutators).toEqual(['setByHuman'])
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
