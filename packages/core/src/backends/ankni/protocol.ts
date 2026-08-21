/**
 * ANKNI stream frame.
 *
 * The ANKNI-branded family (旋转棒 ZKRXB, JH1 and friends) streams an 8-byte
 * companion frame:
 *
 *   AA 08 04 [motor3] [motor4] [motor5] [motor6] [checksum]
 *
 * `checksum` = sum of the previous seven bytes, low 8 bits. The byte at offset
 * 3 is the main motor (a ZKRXB rotation wand confirmed: 0x28 = 40 spins it),
 * and offsets 4-6 carry the model's extra motors (vibration, extension,
 * suction, heat — the layout differs per model and is confirmed per unit).
 *
 * The frame is fire-and-forget and stream-hold: the toy keeps whatever the
 * last frame said little longer, and a host that stops feeding it lets the
 * output decay to nothing — which makes this device family self-limiting if
 * the host dies (the same class of property the Coyote has).
 */

export const ANKNI_FRAME_LENGTH = 8

/** One stream frame: main motor plus the three model-specific slots. */
export interface AnkniFrame {
  /** Main motor 0-100 (rotation on the ZKRXB). */
  readonly main: number
  readonly slot2: number
  readonly slot3: number
  readonly slot4: number
}

function clampByte(value: number): number {
  return Math.trunc(Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 100))
}

/** Encode one frame; offsets 4-6 default to zero when omitted. */
export function encodeAnkniFrame(frame: Partial<AnkniFrame> & { main: number }): Uint8Array {
  const body = [
    0xaa,
    0x08,
    0x04,
    clampByte(frame.main),
    clampByte(frame.slot2 ?? 0),
    clampByte(frame.slot3 ?? 0),
    clampByte(frame.slot4 ?? 0),
  ]
  const checksum = body.reduce((sum, byte) => (sum + byte) & 0xff, 0)
  return Uint8Array.from([...body, checksum])
}

/** The always-stop frame: every motor zero. */
export const ANKNI_STOP_FRAME = Uint8Array.from([0xaa, 0x08, 0x04, 0, 0, 0, 0, 0xb6])
