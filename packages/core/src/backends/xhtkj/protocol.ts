/**
 * 谜姬 / XHTKJ direct-BLE wire protocol.
 *
 * Recovered from the XHTKJ and 醉清风 mini-programs; ported from
 * `_reference/xhtkj/protocol.py`. This is a **second, independent path to the
 * same device family** the MonsterParty relay reaches — direct BLE, so no share
 * link and no vendor server.
 *
 * Every packet is 20 bytes beginning `03 12 <command>`, optionally followed by a
 * one-byte parameter, with any further payload written as little-endian 16-bit
 * words from offset 3.
 *
 * ## What is understood, and what is not
 *
 * The 10-bit-value-shifted-left-6 shape of every strength word, and the `| 60`
 * / `| 63` low bits, read like a 10-bit DAC value packed above a 6-bit mode
 * field — that is an **inference**, not documented. The constants `0xFC00`,
 * `0xFE00`, `0x0140`, `0x0040`, `0xFA40`, `0x1900` are copied verbatim from the
 * mini-program and their meaning is genuinely unknown. They are reproduced
 * exactly rather than "cleaned up", because a guess here reaches hardware.
 */

import { bleUuid } from '../../ports/ble.ts'

/** Advertised by the toy; the only service usable for matching. */
export const XHTKJ_ADVERTISING_SERVICE = bleUuid(0xd34e)
/** Holds the control characteristics but is *not* advertised. */
export const XHTKJ_DEVICE_SERVICE = bleUuid(0xff10)
export const XHTKJ_WRITE_CHARACTERISTIC = bleUuid(0xff12)
export const XHTKJ_NOTIFY_CHARACTERISTIC = bleUuid(0xff11)
/** ANKNI-clone control layout (ZKRXB & friends): no 0xff10, no notify. */
export const XHTKJ_ALT_SERVICE = bleUuid(0xdddd)
export const XHTKJ_ALT_WRITE_CHARACTERISTIC = bleUuid(0xddd2)
export const XHTKJ_ALT_READ_CHARACTERISTIC = bleUuid(0xddd3)
/** Standard Device Information service, never advertised. */
export const DEVICE_INFORMATION_SERVICE = bleUuid(0x180a)
/** Standard PnP ID characteristic; bytes 3-4 carry the vendor product id. */
export const PNP_ID_CHARACTERISTIC = bleUuid(0x2a50)

export const PACKET_LENGTH = 20

const HEADER = [0x03, 0x12] as const

/** Command bytes used by this protocol. */
export const COMMAND = {
  /** Stop the active built-in mode. */
  stopMode: 0x00,
  /** Queue management; parameter 7 clears, parameter 3 prepares a waveform. */
  queue: 0xf0,
  /** Terminates a custom waveform upload. */
  waveEnd: 0xf1,
  /** Live strength. */
  strength: 0xf3,
  /** One custom waveform data packet. */
  waveData: 0xf5,
  /** Session initialisation, sent right after connect. */
  initialize: 0xf6,
} as const

/** Build a bare command packet. */
export function commandPacket(command: number, parameter?: number): Uint8Array {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new RangeError(`command must fit in one byte, received ${command}`)
  }
  if (parameter !== undefined && (!Number.isInteger(parameter) || parameter < 0 || parameter > 0xff)) {
    throw new RangeError(`parameter must fit in one byte, received ${parameter}`)
  }
  const packet = new Uint8Array(PACKET_LENGTH)
  packet[0] = HEADER[0]
  packet[1] = HEADER[1]
  packet[2] = command
  if (parameter !== undefined) packet[3] = parameter
  return packet
}

export const INITIALIZE_PACKET = commandPacket(COMMAND.initialize, 0)
export const CLEAR_PACKET = commandPacket(COMMAND.queue, 7)
export const PREPARE_WAVE_PACKET = commandPacket(COMMAND.queue, 3)
export const STOP_MODE_PACKET = commandPacket(COMMAND.stopMode)

function putU16(packet: Uint8Array, offset: number, value: number): void {
  const masked = Math.trunc(value) & 0xffff
  packet[offset] = masked & 0xff
  packet[offset + 1] = (masked >> 8) & 0xff
}

/** Read a little-endian 16-bit word; used by tests and diagnostics. */
export function readU16(packet: Uint8Array, offset: number): number {
  return (packet[offset] ?? 0) | ((packet[offset + 1] ?? 0) << 8)
}

/** Secondary output a product exposes alongside its main channel. */
export type XhtkjCapability = 'heat' | 'electric' | 'shock' | 'vibration' | 'generic'

function productType(productId: number | undefined): number {
  return productId === undefined ? -1 : productId >> 12
}

function supportsHeat(productId: number | undefined): boolean {
  return productType(productId) === 1 || (productId !== undefined && [1, 2, 29, 71].includes(productId))
}

function supportsShock(productId: number | undefined): boolean {
  return productType(productId) === 4 || (productId !== undefined && [3, 4, 94, 123, 16_489].includes(productId))
}

function supportsElectric(productId: number | undefined): boolean {
  return productType(productId) === 3 || (productId !== undefined && [87, 107].includes(productId))
}

/**
 * Classify a product.
 *
 * The high nibble of the product id is a family code, with explicit
 * allowlists for models that predate it. Order matters: a product matching
 * more than one rule is reported as the earlier one, exactly as the
 * mini-program does.
 */
export function capabilityOf(productId: number | undefined): XhtkjCapability {
  if (supportsHeat(productId)) return 'heat'
  if (supportsElectric(productId)) return 'electric'
  if (supportsShock(productId)) return 'shock'
  if (productType(productId) === 2 || productId === 2_153) return 'vibration'
  return 'generic'
}

/** Fraction of the encoded range that the smallest non-zero command reaches. */
function strengthBase(productId: number | undefined): number {
  if (productId === 4) return 0.2
  if (productId === 1 || productId === 3) return 0.4
  return 0.3
}

/**
 * Percentage of full output the smallest non-zero command already produces.
 *
 * The vendor maps the user-visible range onto the motor's *usable* band, so a
 * 1% command is not 1% of sensation — on most products it is about 31%. This is
 * published on the channel so the model can see it instead of probing 1, 2, 3
 * percent to no effect, and so nobody assumes a percentage means the same thing
 * on two different backends.
 */
export function outputFloorPercent(productId: number | undefined): number {
  return Math.round(strengthBase(productId) * 100)
}

/**
 * Encode a 0-1 scale into the vendor's strength word.
 *
 * Zero is exact; everything else is lifted onto the product's usable band.
 */
export function encodedStrength(scale: number, productId: number | undefined): number {
  const bounded = Number.isFinite(scale) ? Math.min(Math.max(scale, 0), 1) : 0
  if (bounded === 0) return 0
  const base = strengthBase(productId)
  const adjusted = (1 - base) * bounded + base
  return ((Math.trunc(1023 * adjusted) << 6) | 60) & 0xffff
}

/** Write the four-word group the generic layout repeats for each channel. */
function putGenericGroup(packet: Uint8Array, base: number, value: number): void {
  putU16(packet, base, 0xfc00)
  putU16(packet, base + 2, 0xfe00)
  putU16(packet, base + 4, 0x0140)
  putU16(packet, base + 6, value)
}

/**
 * Build a live-strength packet.
 *
 * @param primary - Main output, 0-1.
 * @param secondary - Product-specific second output, 0-1, or `undefined` to
 *   drive only the main one. Its encoding differs per capability, which is why
 *   {@link capabilityOf} has to run before this.
 */
export function strengthPacket(
  primary: number,
  secondary: number | undefined,
  productId: number | undefined,
): Uint8Array {
  const packet = commandPacket(COMMAND.strength)
  const primaryValue = encodedStrength(primary, productId)

  if (secondary === undefined) {
    // Both groups carry the main value when there is no secondary output.
    putGenericGroup(packet, 3, primaryValue)
    putGenericGroup(packet, 11, primaryValue)
    return packet
  }

  const second = Number.isFinite(secondary) ? Math.min(Math.max(secondary, 0), 1) : 0

  if (supportsHeat(productId)) {
    putU16(packet, 3, ((Math.trunc(1023 * second) << 6) | 60) & 0xffff)
    putGenericGroup(packet, 11, primaryValue)
    return packet
  }

  if (productId === 4 || supportsElectric(productId)) {
    putU16(packet, 3, 0xfc00)
    putU16(packet, 5, 0x0040)
    putU16(packet, 7, primaryValue)
    putU16(packet, 11, 0xfa40)
    putU16(packet, 13, 0xfe00)
    if (second === 0) {
      putU16(packet, 15, 0x1900)
      putU16(packet, 17, 63)
    } else {
      const multiplier = productId === 4 ? 4 : 90
      const offset = productId === 4 ? 9 : 10
      putU16(packet, 15, Math.trunc(10 * (multiplier * second + offset)) << 6)
      putU16(packet, 17, ((Math.trunc(1023 * (0.1 * (1 - second) + 0.4)) << 6) | 63) & 0xffff)
    }
    return packet
  }

  if (supportsShock(productId)) {
    putU16(packet, 3, 0xfc00)
    putU16(packet, 5, 0x0040)
    putU16(packet, 7, primaryValue)
    putU16(packet, 11, 0xfc00)
    putU16(packet, 13, 0x0040)
    putU16(packet, 15, second === 0 ? 63 : ((Math.trunc(1023 * (0.4 * second + 0.3)) << 6) | 63) & 0xffff)
    return packet
  }

  putGenericGroup(packet, 3, primaryValue)
  putGenericGroup(packet, 11, encodedStrength(second, productId))
  return packet
}

/** One custom-waveform data packet carrying up to eight words. */
export function waveDataPacket(values: readonly number[]): Uint8Array {
  const packet = commandPacket(COMMAND.waveData)
  for (const [index, value] of values.slice(0, 8).entries()) {
    putU16(packet, 3 + 2 * index, value)
  }
  return packet
}

/**
 * Build the packet sequence that uploads a custom waveform.
 *
 * The device plays the waveform itself once uploaded, so unlike a Coyote there
 * is **no ongoing stream and therefore no hardware dead-man switch**. The host
 * timer is the only thing that stops it.
 */
export function wavePackets(scales: readonly number[], productId: number | undefined): Uint8Array[] {
  const parameters = [0xfc00, 0xfe00, ...scales.map(scale => encodedStrength(scale, productId))]
  const packets: Uint8Array[] = [PREPARE_WAVE_PACKET]
  for (let offset = 0; offset < parameters.length; offset += 4) {
    const group = parameters.slice(offset, offset + 4)
    while (group.length < 4) group.push(0)
    // Each data packet repeats its group of four, filling all eight words.
    packets.push(waveDataPacket([...group, ...group]))
  }
  const end = commandPacket(COMMAND.waveEnd)
  end.fill(0xff, 3, 11)
  packets.push(end)
  return packets
}

/** Extract the vendor product id from a PnP ID characteristic value. */
export function parseProductId(pnpId: Uint8Array): number | undefined {
  if (pnpId.length < 5) return undefined
  return (pnpId[3] ?? 0) | ((pnpId[4] ?? 0) << 8)
}
