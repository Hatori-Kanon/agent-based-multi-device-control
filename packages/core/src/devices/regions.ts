/**
 * Which part of the body each channel drives.
 *
 * Packs speak regions (`chest`, `inner-thigh`), never device ids, so the
 * resolver has to answer "which connected channel carries `chest` right now".
 * The answer is hardware- and session-dependent, which is why it lives in its
 * own store rather than in the safety policy:
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
 * Shape of a region id (`M2-实施计划.md` §4.6.3 rule 3).
 *
 * Lower-case slugs only: the ids are written by hand in manifests and packs,
 * and an unvalidated id would let `Chest` and `chest` become two regions that
 * look identical in the UI.
 */
const REGION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/

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
 * Per-channel narrative region ids, with human-only mutation.
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
   * @throws SafetyError with code `INVALID_POLICY` when the region id or the
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
    } else {
      assertRegionId(region, `channel ${key}`)
      this.overrides.set(key, region)
      this.cleared.delete(key)
    }
    return { previous, next: region }
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
   *   `device:channel` or a value is not a region id.
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
 * Validate a region id.
 *
 * `whole-body` is a reserved id: it is the resolver's wildcard region, not an
 * alias for "every channel", so labelling one channel with it is pointless but
 * not dangerous and is accepted here. The pack loader owns rejecting
 * *undeclared* regions at validation time; this store only owns the shape.
 */
function assertRegionId(value: unknown, where: string): string {
  if (typeof value !== 'string' || !REGION_ID.test(value)) {
    throw new SafetyError(
      'INVALID_POLICY',
      `region id '${String(value)}' (${where}) must match ${REGION_ID.source}`,
    )
  }
  return value
}
