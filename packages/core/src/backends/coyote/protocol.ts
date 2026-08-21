/**
 * Coyote V3 wire protocol.
 *
 * Pure encoding and decoding, no transport and no state, so it can be checked
 * against the vendor's own worked hex examples byte for byte.
 *
 * Source: `_reference/dglab/coyote/v3/README.md`.
 *
 * Two commands matter:
 *
 * - `B0` (20 bytes, written every 100 ms) carries **both** channels' strength
 *   and waveform in one frame. Stopping this stream stops output, which is the
 *   hardware dead-man switch the whole safety model leans on.
 * - `BF` (7 bytes) sets the per-channel strength soft cap. It **persists across
 *   power cycles and returns no acknowledgement**, so it must be rewritten on
 *   every connect or a previous session's ceiling silently applies.
 */

import { bleUuid } from '../../ports/ble.ts'
import type { FrameSlots } from '../../waveform/types.ts'

/** Advertised name of the 3.0 pulse box. */
export const COYOTE_BLE_NAME = '47L121000'

export const COYOTE_SERVICE = bleUuid(0x180c)
/** Every command is written here. */
export const COYOTE_WRITE_CHARACTERISTIC = bleUuid(0x150a)
/** Every response arrives here. */
export const COYOTE_NOTIFY_CHARACTERISTIC = bleUuid(0x150b)
export const COYOTE_BATTERY_SERVICE = bleUuid(0x180a)
export const COYOTE_BATTERY_CHARACTERISTIC = bleUuid(0x1500)

/** Absolute per-channel strength range. */
export const MAX_STRENGTH = 200
/** Highest sequence number the 4-bit field holds. */
export const MAX_SEQ = 0x0f

export const B0_LENGTH = 20
export const BF_LENGTH = 7
export const B1_LENGTH = 4

const B0_HEAD = 0xb0
const B1_HEAD = 0xb1
const BF_HEAD = 0xbf

/**
 * Vendor-documented silence for an unused channel.
 *
 * One intensity value above 100 is illegal, and the box responds by discarding
 * that channel's whole frame. The vendor's tip recommends exactly this rather
 * than sending valid zeros, so it is what we send; frequency stays legal so it
 * is obvious which field is the deliberate sentinel.
 */
export const SILENT_FREQ: FrameSlots = [10, 10, 10, 10]
export const SILENT_INTENSITY: FrameSlots = [0, 0, 0, 101]

/** How the box should interpret a channel's strength byte. */
export type StrengthMode = 'none' | 'increase' | 'decrease' | 'absolute'

const MODE_BITS: Readonly<Record<StrengthMode, number>> = {
  none: 0b00,
  increase: 0b01,
  decrease: 0b10,
  absolute: 0b11,
}

export interface B0Fields {
  /** 0 means "do not report back"; 1-15 asks for a matching `B1`. */
  readonly seq: number
  readonly modeA: StrengthMode
  readonly modeB: StrengthMode
  readonly strengthA: number
  readonly strengthB: number
  readonly freqA: FrameSlots
  readonly intensityA: FrameSlots
  readonly freqB: FrameSlots
  readonly intensityB: FrameSlots
}

function byte(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(255, Math.max(0, Math.round(value)))
}

/** Clamp to the legal strength range. Out-of-range input is read as 0 by the box. */
export function clampStrength(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(MAX_STRENGTH, Math.round(value))
}

function writeSlots(out: Uint8Array, offset: number, slots: FrameSlots): void {
  for (let slot = 0; slot < 4; slot += 1) out[offset + slot] = byte(slots[slot] ?? 0)
}

/**
 * Encode one `B0` frame.
 *
 * Layout: head, `seq<<4 | modeA<<2 | modeB`, strength A, strength B, then four
 * groups of four bytes — A frequency, A intensity, B frequency, B intensity.
 */
export function encodeB0(fields: B0Fields): Uint8Array {
  if (!Number.isInteger(fields.seq) || fields.seq < 0 || fields.seq > MAX_SEQ) {
    throw new RangeError(`Coyote seq must be an integer 0-${MAX_SEQ}, received ${fields.seq}`)
  }
  const out = new Uint8Array(B0_LENGTH)
  out[0] = B0_HEAD
  out[1] = ((fields.seq & 0x0f) << 4) | (MODE_BITS[fields.modeA] << 2) | MODE_BITS[fields.modeB]
  out[2] = clampStrength(fields.strengthA)
  out[3] = clampStrength(fields.strengthB)
  writeSlots(out, 4, fields.freqA)
  writeSlots(out, 8, fields.intensityA)
  writeSlots(out, 12, fields.freqB)
  writeSlots(out, 16, fields.intensityB)
  return out
}

export interface BFFields {
  /** Hardware ceiling for channel A, 0-200. */
  readonly softCapA: number
  readonly softCapB: number
  /** 0-255; higher makes low-frequency waveforms hit harder. */
  readonly freqBalanceA: number
  readonly freqBalanceB: number
  /** 0-255; higher makes low-frequency waveforms sting more. */
  readonly intensityBalanceA: number
  readonly intensityBalanceB: number
}

/**
 * Encode the `BF` bounds command.
 *
 * The box ignores a soft cap outside 0-200, so an out-of-range value would
 * silently leave the previous ceiling in place. Clamping here makes that
 * impossible.
 */
export function encodeBF(fields: BFFields): Uint8Array {
  const out = new Uint8Array(BF_LENGTH)
  out[0] = BF_HEAD
  out[1] = clampStrength(fields.softCapA)
  out[2] = clampStrength(fields.softCapB)
  out[3] = byte(fields.freqBalanceA)
  out[4] = byte(fields.freqBalanceB)
  out[5] = byte(fields.intensityBalanceA)
  out[6] = byte(fields.intensityBalanceB)
  return out
}

/** Strength report from the box. */
export interface B1Message {
  /** Echoes the `B0` sequence that caused the change, or 0 for a wheel turn. */
  readonly seq: number
  readonly strengthA: number
  readonly strengthB: number
}

/**
 * Decode a notification.
 *
 * @returns The strength report, or `undefined` for anything else — the
 *   deprecated `BE` message and future additions must be ignored, not treated
 *   as an error.
 */
export function decodeNotification(data: Uint8Array): B1Message | undefined {
  if (data.length < B1_LENGTH || data[0] !== B1_HEAD) return undefined
  return { seq: data[1] ?? 0, strengthA: data[2] ?? 0, strengthB: data[3] ?? 0 }
}

/** Map a 0-100 command percentage onto the 0-200 strength scale. */
export function percentToStrength(percent: number): number {
  if (!Number.isFinite(percent) || percent <= 0) return 0
  return Math.min(MAX_STRENGTH, Math.round(percent * 2))
}

/** Inverse of {@link percentToStrength}, for reporting what the box says. */
export function strengthToPercent(strength: number): number {
  if (!Number.isFinite(strength) || strength <= 0) return 0
  return Math.min(100, Math.round(strength / 2))
}

/** Render bytes as uppercase hex, for audit records and test failures. */
export function toHex(data: Uint8Array): string {
  return [...data].map(value => value.toString(16).padStart(2, '0').toUpperCase()).join('')
}
