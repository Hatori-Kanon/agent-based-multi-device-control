import { describe, expect, it } from 'vitest'
import { isValidVersion, satisfiesVersion } from '../src/scenario/semver.ts'

describe('content-pack semver subset', () => {
  it('supports >=, <, ^ and ~ ranges without a dependency', () => {
    // The frozen content-pack spec writes this canonical engine range with
    // partial operands; `>=0.2` means `>=0.2.0`, `<1.0` means `<1.0.0`.
    expect(satisfiesVersion('>=0.2 <1.0', '0.2.0')).toBe(true)
    expect(satisfiesVersion('>=0.2 <1.0', '0.9.9')).toBe(true)
    expect(satisfiesVersion('>=0.2 <1.0', '1.0.0')).toBe(false)
    expect(satisfiesVersion('>=0.2 <1.0', '0.1.9')).toBe(false)

    expect(satisfiesVersion('>=0.2.1 <0.3.0', '0.2.1')).toBe(true)
    expect(satisfiesVersion('>=0.2.1 <0.3.0', '0.3.0')).toBe(false)

    expect(satisfiesVersion('^0.2.0', '0.2.9')).toBe(true)
    expect(satisfiesVersion('^0.2.0', '0.3.0')).toBe(false)
    expect(satisfiesVersion('^1.2.3', '1.9.0')).toBe(true)
    expect(satisfiesVersion('^1.2.3', '2.0.0')).toBe(false)
    // The caret also has a lower bound: below 1.2.3 must not match.
    expect(satisfiesVersion('^1.2.3', '1.2.3')).toBe(true)
    expect(satisfiesVersion('^1.2.3', '1.0.0')).toBe(false)

    expect(satisfiesVersion('~0.2.1', '0.2.9')).toBe(true)
    expect(satisfiesVersion('~0.2.1', '0.3.0')).toBe(false)
    expect(satisfiesVersion('~1.2.3', '1.2.99')).toBe(true)
  })

  it('accepts an exact version', () => {
    expect(satisfiesVersion('0.2.0', '0.2.0')).toBe(true)
    expect(satisfiesVersion('0.2.0', '0.2.1')).toBe(false)
  })

  it('intersects repeated comparators with AND semantics', () => {
    // npm semantics: the strictest bound wins instead of the last token.
    expect(satisfiesVersion('>=2.0 >=1.0', '1.5.0')).toBe(false)
    expect(satisfiesVersion('>=2.0 >=1.0', '2.5.0')).toBe(true)
    expect(satisfiesVersion('>=1.0 >=2.0', '1.5.0')).toBe(false)

    expect(satisfiesVersion('<2.0 <1.5', '1.6.0')).toBe(false)
    expect(satisfiesVersion('<2.0 <1.5', '1.4.9')).toBe(true)
    expect(satisfiesVersion('<1.5 <2.0', '1.6.0')).toBe(false)

    expect(satisfiesVersion('>=1.5 <2.0 <1.8', '1.6.0')).toBe(true)
    expect(satisfiesVersion('>=1.5 <2.0 <1.8', '1.9.0')).toBe(false)

    // Contradictory bounds intersect to the empty set.
    expect(satisfiesVersion('>=2.0 <1.0', '1.5.0')).toBe(false)
  })

  it('treats a partial exact version as x.y.0, not a wildcard', () => {
    expect(satisfiesVersion('1.2', '1.2.0')).toBe(true)
    expect(satisfiesVersion('1.2', '1.2.9')).toBe(false)
    expect(satisfiesVersion('1.2', '1.0.0')).toBe(false)
  })

  it('treats zero-major caret ranges per npm semantics', () => {
    expect(satisfiesVersion('^0.0.3', '0.0.3')).toBe(true)
    expect(satisfiesVersion('^0.0.3', '0.0.4')).toBe(false)
    expect(satisfiesVersion('^0.2.0', '0.2.0')).toBe(true)
  })

  it('rejects syntax outside the supported subset instead of guessing', () => {
    for (const range of ['>0.2.0', '<=1.0.0', '*', '1.x', '||', '^1.0.0 <2.0.0', '~1.2.3 >=1.0.0', '1.2.3-rc.1']) {
      expect(() => satisfiesVersion(range, '1.0.0'), range).toThrow(/unsupported semver/u)
    }
    expect(() => satisfiesVersion('>=0.2 <1.0', '1.0')).toThrow(/unsupported semver/u)
    expect(() => satisfiesVersion('>=0.2 <1.0', '01.0.0')).toThrow(/unsupported semver/u)
  })

  it('validates plain version triples', () => {
    expect(isValidVersion('0.2.0')).toBe(true)
    expect(isValidVersion('1.10.300')).toBe(true)
    expect(isValidVersion('1.0')).toBe(false)
    expect(isValidVersion('v1.0.0')).toBe(false)
    expect(isValidVersion('1.0.0-beta')).toBe(false)
  })
})
