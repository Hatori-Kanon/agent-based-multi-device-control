/**
 * Which part of the body each channel drives.
 *
 * Packs speak regions (`chest`, `inner-thigh`), never device ids, so the
 * resolver has to answer "which connected channel carries `chest` right now".
 * Since v6 a region key is also the **player's own part name** (`左胸`, `绑带 2`):
 * a pack's `regions[]` is a recommendation list, and the human's label is kept
 * verbatim (trimmed). The console maps a player label that exactly matches a
 * recommended label/id onto the pack id; anything else becomes a session part
 * key that the model can still target. The answer is hardware- and
 * session-dependent, which is why it lives in its own store rather than in the
 * safety policy:
 *
 * - **Layered**: a manifest label (the baseline, restored from
 *   `state/devices.json`) sits under a human edit, which sits over whatever the
 *   backend declared on `Channel.region`. Reading order is documented on
 *   `DeviceRegistry.snapshot()`.
 * - **Human-only mutation.** There is no `setByModel`: the model's tool face
 *   lists regions, it never labels a channel. A pack that could relabel a
 *   channel could silently redirect output, so this is a human action in the
 *   app, audited as `region_change` (`M2-实施计划.md` §4.6.3).
 * - **Not a safety bound.** A region only selects *where* an accepted command
 *   goes; policy still clamps what it may be. Persisting or losing a label can
 *   never widen a cap.
 *
 * The map is deliberately cheap to copy: {@link RegionStore.snapshot} returns
 * the explicit settings for persistence, and `restore` loads them once at
 * startup.
 */

import { SafetyError } from './errors.ts'

/**
 * Shape of a channel's region **key**.
 *
 * Since v6 this is the player's part name as well as a pack region id: the
 * human may name a physical part freely (`左胸`, `右大腿`, `绑带 2`), while a
 * content pack's `regions[].id` remains a lower-case slug. The two share one
 * namespace so an exact name/id match can map a player label onto the pack's
 * recommendation (the console does that mapping; this store only owns shape).
 *
 * Constraints are about safety of the key, not style: trimmed, non-empty, at
 * most {@link REGION_KEY_MAX_CODE_POINTS} code points, and no control
 * characters (the resolver and audit lines must stay readable). `Chest` and
 * `chest` are now allowed to be distinct player labels; the UI does the
 * case-insensitive suggestion match before submitting.
 */
const REGION_KEY_MAX_CODE_POINTS = 64
/** C0/C1 controls plus the Unicode line/paragraph separators. */
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u

/** The NUL separator used by `PolicyStore`; a channel id must not carry it. */
const NUL = '\u0000'

/** Baseline labels that a human edit and the persistence layer sit on top of. */
export interface RegionStoreOptions {
  /**
   * Starting labels from the device manifest, keyed `device:channel`.
   *
   * These are the values `state/devices.json` already held at startup. They are
   * the fallback layer under a human edit and are deliberately **not** part of
   * {@link RegionStore.snapshot}, which reports only what changed at runtime.
   */
  readonly defaults?: Readonly<Record<string, string>>
}

/** Before and after of a human label change, shaped for the audit trail. */
export interface RegionChange {
  readonly previous: string | undefined
  readonly next: string | undefined
}

/**
 * Per-channel region keys (pack recommendation id or player part name), with
 * human-only mutation.
 *
 * A channel with no label is reachable only through the resolver's
 * `whole-body` wildcard, so clearing a label is a real (and harmless) state,
 * not a missing value.
 */
export class RegionStore {
  /** Manifest baseline; never mutated after construction. */
  private readonly defaults = new Map<string, string>()
  /** Explicit human labels. */
  private readonly overrides = new Map<string, string>()
  /**
   * Channels a human explicitly cleared.
   *
   * Without this, clearing a channel that the manifest labelled would fall back
   * to the manifest label and the UI action would look like a no-op.
   */
  private readonly cleared = new Set<string>()

  /**
   * @param options - Optional manifest baseline.
   * @throws SafetyError with code `INVALID_POLICY` when a baseline entry is
   *   malformed: a hand-edited manifest must fail loudly at startup rather than
   *   silently put the label on the wrong channel.
   */
  constructor(options: RegionStoreOptions = {}) {
    for (const [encoded, region] of Object.entries(options.defaults ?? {})) {
      const key = decodeKey(encoded)
      this.defaults.set(key, assertRegionId(region, `default for '${encoded}'`))
    }
  }

  /**
   * Region a channel currently carries, or `undefined` when it has none.
   *
   * Read-only and total: `undefined` is a valid answer for an unlabelled
   * channel, an explicit clear, and an id shape this store cannot key (never
   * throws, so a snapshot cannot fail because one backend uses a colon in its
   * device id).
   */
  get(deviceId: string, channelId: string): string | undefined {
    const key = channelKey(deviceId, channelId)
    const override = this.overrides.get(key)
    if (override !== undefined) return override
    if (this.cleared.has(key)) return undefined
    return this.defaults.get(key)
  }

  /**
   * Whether this store has an opinion about the channel — a human label, an
   * explicit clear, or a manifest default.
   *
   * `get()` alone cannot separate "no label anywhere" from "a human cleared
   * this label": both return `undefined`, but the first should fall back to the
   * backend's `Channel.region` and the second must not. The registry asks this
   * before consulting the backend's declared label.
   */
  has(deviceId: string, channelId: string): boolean {
    const key = channelKey(deviceId, channelId)
    return this.overrides.has(key) || this.cleared.has(key) || this.defaults.has(key)
  }

  /**
   * Apply a human label change; `undefined` clears the label.
   *
   * @returns Before and after values so the caller can audit the change.
   * @throws SafetyError with code `INVALID_POLICY` when the region key or the
   *   key does not have the documented shape.
   */
  setByHuman(deviceId: string, channelId: string, region: string | undefined): RegionChange {
    assertDeviceKey(deviceId)
    assertChannelKey(channelId)
    const key = channelKey(deviceId, channelId)
    // Read before mutating: `previous` is the value in force, which may come
    // from the manifest baseline rather than from an earlier override.
    const previous = this.get(deviceId, channelId)
    if (region === undefined) {
      this.overrides.delete(key)
      this.cleared.add(key)
      return { previous, next: undefined }
    }
    const next = assertRegionId(region, `channel ${key}`)
    this.overrides.set(key, next)
    this.cleared.delete(key)
    return { previous, next }
  }

  /**
   * Explicit labels for persistence, keyed `device:channel` and sorted.
   *
   * Only human-set values appear: the manifest baseline is written by whoever
   * owns the manifest, and re-persisting it here would duplicate the source of
   * truth. A cleared channel therefore disappears from this map.
   */
  snapshot(): Readonly<Record<string, string>> {
    const entries: Record<string, string> = {}
    for (const key of [...this.overrides.keys()].sort()) entries[key] = this.overrides.get(key)!
    return entries
  }

  /**
   * Load a previously persisted map — **once, at startup**.
   *
   * Validates every entry before touching the store and then commits, so one
   * corrupt line cannot half-apply. This is the load half of persistence, not a
   * mutation path: only the host calls it, and callers audit what was restored.
   *
   * @throws SafetyError with code `INVALID_POLICY` when a key is not
   *   `device:channel` or a value is not a valid region key.
   */
  restore(entries: Readonly<Record<string, string>>): void {
    const next = new Map<string, string>()
    for (const [encoded, region] of Object.entries(entries)) {
      const key = decodeKey(encoded)
      next.set(key, assertRegionId(region, `restored value for '${encoded}'`))
    }
    for (const [key, region] of next) {
      this.overrides.set(key, region)
      this.cleared.delete(key)
    }
  }
}

function channelKey(deviceId: string, channelId: string): string {
  return `${deviceId}:${channelId}`
}

/**
 * Persisted keys are `device:channel`, split at the first colon.
 *
 * Hub channel ids contain colons themselves (`0:1:vibrate`), and a device id
 * may not, so the split is unambiguous. Anything else would be a mapping that
 * could silently move a label onto the wrong device.
 */
function decodeKey(encoded: string): string {
  const at = encoded.indexOf(':')
  if (at <= 0 || at === encoded.length - 1) {
    throw new SafetyError('INVALID_POLICY', `region map key '${encoded}' must look like device:channel`)
  }
  const deviceId = encoded.slice(0, at)
  const channelId = encoded.slice(at + 1)
  assertDeviceKey(deviceId)
  assertChannelKey(channelId)
  return encoded
}

function assertDeviceKey(deviceId: string): void {
  if (deviceId.length === 0 || deviceId.includes(':') || deviceId.includes(NUL)) {
    throw new SafetyError('INVALID_POLICY', "deviceId must be non-empty and must not contain ':' or NUL")
  }
}

function assertChannelKey(channelId: string): void {
  if (channelId.length === 0 || channelId.includes(NUL)) {
    throw new SafetyError('INVALID_POLICY', 'channelId must be non-empty and must not contain NUL')
  }
}

/**
 * Validate and normalize a region key.
 *
 * `whole-body` is a reserved id: it is the resolver's wildcard region, not an
 * alias for "every channel", so labelling one channel with it is pointless but
 * not dangerous and is accepted here. The pack loader owns rejecting
 * *undeclared* pack regions at validation time; this store only owns shape.
 *
 * A player-authored part name is trimmed and returned; the same trimmed value
 * is what {@link RegionStore.setByHuman} persists and audits, so two spellings
 * that differ only in surrounding whitespace collapse to one part.
 */
function assertRegionId(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new SafetyError('INVALID_POLICY', `region key (${where}) must be a non-empty string`)
  }
  const trimmed = value.trim()
  const codePoints = Array.from(trimmed).length
  if (trimmed === '' || codePoints > REGION_KEY_MAX_CODE_POINTS || CONTROL_CHARS.test(trimmed)) {
    throw new SafetyError(
      'INVALID_POLICY',
      `region key '${trimmed}' (${where}) must be 1-${REGION_KEY_MAX_CODE_POINTS} printable characters`,
    )
  }
  return trimmed
}
