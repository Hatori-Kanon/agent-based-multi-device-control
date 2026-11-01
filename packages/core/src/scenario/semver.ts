/**
 * Semver subset for content-pack engine compatibility.
 *
 * Deliberately zero-dependency and deliberately small (`M2-实施计划.md` §4.6):
 * the engine only needs to answer "does this version fall inside this range".
 * Supported range forms are:
 *
 * - exact `1.2.3`
 * - `>=1.2.3` and/or `<2.0.0` comparators, space separated (`">=0.2 <1.0"`)
 * - caret `^1.2.3` (same-major up to the next major, or next minor when major is 0)
 * - tilde `~1.2.3` (same minor)
 *
 * Anything else — `>`, `<=`, wildcards, `||`, prerelease tags, build metadata —
 * throws instead of guessing: an authoring mistake in `pack.json#engine` must
 * fail loudly, not silently load an incompatible pack.
 *
 * Comparator operands may omit the minor and patch parts because the frozen
 * content-pack spec writes its own canonical example as `">=0.2 <1.0"`
 * (`内容包规范.md` §3). A missing part is zero: `>=0.2` is `>=0.2.0`, `<1.0`
 * is `<1.0.0`. Exact versions and caret/tilde operands keep the usual npm
 * semantics for partial input as well (`~1.2` is `>=1.2.0 <1.3.0`).
 */

export interface SemverVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

const FULL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PARTIAL_VERSION = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?)?$/

function unsupported(what: string): never {
  throw new Error(`unsupported semver ${what}; the content-pack loader accepts exact "x.y.z", ">=x.y.z <a.b.c", "^x.y.z" and "~x.y.z" only`)
}

/** Parse a complete `major.minor.patch` version. Throws on anything else. */
export function parseVersion(version: string): SemverVersion {
  const trimmed = version.trim()
  const match = FULL_VERSION.exec(trimmed)
  if (match === null) unsupported(`version "${version}"`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

/** True when `version` is a complete plain semver triple. */
export function isValidVersion(version: string): boolean {
  return FULL_VERSION.test(version.trim())
}

function compare(left: SemverVersion, right: SemverVersion): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  return left.patch - right.patch
}

interface PartialVersion extends SemverVersion {
  /** How many numeric parts the author wrote (1-3), needed for caret/tilde. */
  readonly parts: 1 | 2 | 3
}

function parsePartial(value: string): PartialVersion {
  const match = PARTIAL_VERSION.exec(value.trim())
  if (match === null) unsupported(`range operand "${value}"`)
  return {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    parts: match[3] !== undefined ? 3 : match[2] !== undefined ? 2 : 1,
  }
}

interface Bounds {
  readonly lowerInclusive: SemverVersion | undefined
  readonly upperExclusive: SemverVersion | undefined
  readonly exact: SemverVersion | undefined
}

function caretUpper(version: PartialVersion): SemverVersion {
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0 }
  if (version.parts >= 2 && version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0 }
  if (version.parts >= 3 && version.patch > 0) return { major: 0, minor: 0, patch: version.patch + 1 }
  // ^0, ^0.0, ^0.0.0: all release candidates below the next possible minor.
  if (version.parts === 1) return { major: 1, minor: 0, patch: 0 }
  if (version.parts === 2) return { major: 0, minor: 1, patch: 0 }
  return { major: 0, minor: 0, patch: 1 }
}

function tildeUpper(version: PartialVersion): SemverVersion {
  if (version.parts === 1) return { major: version.major + 1, minor: 0, patch: 0 }
  return { major: version.major, minor: version.minor + 1, patch: 0 }
}

function parseBounds(range: string): Bounds {
  const trimmed = range.trim()
  if (trimmed.length === 0) unsupported('range ""')
  const tokens = trimmed.split(/\s+/u)
  let lowerInclusive: SemverVersion | undefined
  let upperExclusive: SemverVersion | undefined
  let exact: SemverVersion | undefined

  for (const token of tokens) {
    if (token.startsWith('>=')) {
      const operand = parsePartial(token.slice(2))
      lowerInclusive = { major: operand.major, minor: operand.minor, patch: operand.patch }
      continue
    }
    if (token.startsWith('<')) {
      const operand = parsePartial(token.slice(1))
      upperExclusive = { major: operand.major, minor: operand.minor, patch: operand.patch }
      continue
    }
    if (token.startsWith('^') || token.startsWith('~')) {
      // Caret/tilde are whole-range forms; mixing them with comparators is not
      // part of the supported subset and would need precedence rules.
      if (tokens.length !== 1) unsupported(`combined range "${range}"`)
      const operand = parsePartial(token.slice(1))
      lowerInclusive = { major: operand.major, minor: operand.minor, patch: operand.patch }
      upperExclusive = token.startsWith('^') ? caretUpper(operand) : tildeUpper(operand)
      continue
    }
    if (PARTIAL_VERSION.test(token)) {
      if (tokens.length !== 1) unsupported(`combined range "${range}"`)
      const operand = parsePartial(token)
      exact = { major: operand.major, minor: operand.minor, patch: operand.patch }
      continue
    }
    unsupported(`range syntax "${token}"`)
  }

  return { lowerInclusive, upperExclusive, exact }
}

/**
 * Does `version` satisfy `range`?
 *
 * @throws Error when the range or the version is outside the supported subset.
 */
export function satisfiesVersion(range: string, version: string): boolean {
  const target = parseVersion(version)
  const bounds = parseBounds(range)
  if (bounds.exact !== undefined) return compare(target, bounds.exact) === 0
  if (bounds.lowerInclusive !== undefined && compare(target, bounds.lowerInclusive) < 0) return false
  if (bounds.upperExclusive !== undefined && compare(target, bounds.upperExclusive) >= 0) return false
  return true
}
