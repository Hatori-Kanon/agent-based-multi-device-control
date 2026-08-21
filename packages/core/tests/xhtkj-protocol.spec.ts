import { describe, expect, it } from 'vitest'
import {
  CLEAR_PACKET,
  COMMAND,
  DEVICE_INFORMATION_SERVICE,
  INITIALIZE_PACKET,
  PACKET_LENGTH,
  PNP_ID_CHARACTERISTIC,
  PREPARE_WAVE_PACKET,
  STOP_MODE_PACKET,
  XHTKJ_ADVERTISING_SERVICE,
  XHTKJ_DEVICE_SERVICE,
  XHTKJ_NOTIFY_CHARACTERISTIC,
  XHTKJ_WRITE_CHARACTERISTIC,
  capabilityOf,
  commandPacket,
  encodedStrength,
  outputFloorPercent,
  parseProductId,
  readU16,
  strengthPacket,
  toHex,
  waveDataPacket,
  wavePackets,
} from '../src/index.ts'

describe('XHTKJ addressing', () => {
  it('separates the advertised service from the ones only used for access', () => {
    expect(XHTKJ_ADVERTISING_SERVICE).toBe('0000d34e-0000-1000-8000-00805f9b34fb')
    expect(XHTKJ_DEVICE_SERVICE).toBe('0000ff10-0000-1000-8000-00805f9b34fb')
    expect(XHTKJ_WRITE_CHARACTERISTIC).toBe('0000ff12-0000-1000-8000-00805f9b34fb')
    expect(XHTKJ_NOTIFY_CHARACTERISTIC).toBe('0000ff11-0000-1000-8000-00805f9b34fb')
    // Standard Device Information / PnP ID, where the product id lives.
    expect(DEVICE_INFORMATION_SERVICE).toBe('0000180a-0000-1000-8000-00805f9b34fb')
    expect(PNP_ID_CHARACTERISTIC).toBe('00002a50-0000-1000-8000-00805f9b34fb')
  })
})

describe('XHTKJ packet framing', () => {
  it('always emits 20 bytes beginning 03 12 <command>', () => {
    const packet = commandPacket(0xf3)
    expect(packet).toHaveLength(PACKET_LENGTH)
    expect([...packet.slice(0, 3)]).toEqual([0x03, 0x12, 0xf3])
    expect([...packet.slice(3)].every(byte => byte === 0)).toBe(true)
  })

  it('places an optional parameter in byte 3', () => {
    expect(commandPacket(0xf0, 7)[3]).toBe(7)
  })

  it('refuses values that do not fit in a byte', () => {
    expect(() => commandPacket(0x100)).toThrow(RangeError)
    expect(() => commandPacket(0xf0, 256)).toThrow(RangeError)
    expect(() => commandPacket(-1)).toThrow(RangeError)
  })

  it('matches the documented fixed packets', () => {
    expect(toHex(INITIALIZE_PACKET)).toBe(`0312${COMMAND.initialize.toString(16).toUpperCase()}00`.toUpperCase() + '0'.repeat(32))
    expect(CLEAR_PACKET[2]).toBe(0xf0)
    expect(CLEAR_PACKET[3]).toBe(7)
    expect(PREPARE_WAVE_PACKET[2]).toBe(0xf0)
    expect(PREPARE_WAVE_PACKET[3]).toBe(3)
    expect(STOP_MODE_PACKET[2]).toBe(0x00)
  })
})

describe('XHTKJ capability detection', () => {
  it('reads the family from the high nibble of the product id', () => {
    expect(capabilityOf(0x1000)).toBe('heat')
    expect(capabilityOf(0x2000)).toBe('vibration')
    expect(capabilityOf(0x3000)).toBe('electric')
    expect(capabilityOf(0x4000)).toBe('shock')
  })

  it('honours the explicit allowlists for models predating the family code', () => {
    for (const id of [1, 2, 29, 71]) expect(capabilityOf(id)).toBe('heat')
    for (const id of [87, 107]) expect(capabilityOf(id)).toBe('electric')
    for (const id of [3, 94, 123, 16_489]) expect(capabilityOf(id)).toBe('shock')
    expect(capabilityOf(2_153)).toBe('vibration')
  })

  it('falls back to generic for an unknown or unreadable product id', () => {
    expect(capabilityOf(undefined)).toBe('generic')
    expect(capabilityOf(0x0999)).toBe('generic')
  })

  it('reproduces the vendor quirk where product 4 reports shock but is packed as electric', () => {
    // capabilityOf follows the mini-program's ordering, and strengthPacket
    // follows its branch ordering, which disagree for this one id. Both are
    // preserved verbatim: "fixing" it would change what reaches hardware.
    expect(capabilityOf(4)).toBe('shock')
    const packet = strengthPacket(0.5, 0.5, 4)
    // The electric branch signature: 0x0040 at offset 5, 0xFA40 at offset 11.
    expect(readU16(packet, 5)).toBe(0x0040)
    expect(readU16(packet, 11)).toBe(0xfa40)
  })

  it('reads the product id from PnP ID bytes 3 and 4, little endian', () => {
    expect(parseProductId(Uint8Array.from([0x02, 0x5e, 0x04, 0x1d, 0x00, 0x01, 0x00]))).toBe(29)
    expect(parseProductId(Uint8Array.from([0, 0, 0, 0x69, 0x40]))).toBe(16_489)
    expect(parseProductId(Uint8Array.from([1, 2, 3]))).toBeUndefined()
  })
})

describe('XHTKJ strength encoding', () => {
  it('encodes zero exactly', () => {
    expect(encodedStrength(0, undefined)).toBe(0)
    expect(encodedStrength(0, 4)).toBe(0)
  })

  it('lifts every non-zero command onto the product usable band', () => {
    // The whole point: 1% is not 1% of sensation.
    expect(encodedStrength(0.01, undefined)).toBe(((Math.trunc(1023 * 0.307) << 6) | 60) & 0xffff)
    expect(encodedStrength(1, undefined)).toBe(((1023 << 6) | 60) & 0xffff)
    expect(encodedStrength(0.5, undefined)).toBe(((Math.trunc(1023 * 0.65) << 6) | 60) & 0xffff)
  })

  it('uses a different band per product family', () => {
    expect(outputFloorPercent(4)).toBe(20)
    expect(outputFloorPercent(1)).toBe(40)
    expect(outputFloorPercent(3)).toBe(40)
    expect(outputFloorPercent(undefined)).toBe(30)
    expect(outputFloorPercent(0x2000)).toBe(30)
  })

  it('reaches full scale for every family', () => {
    for (const id of [undefined, 1, 3, 4, 0x2000]) {
      expect(encodedStrength(1, id)).toBe(((1023 << 6) | 60) & 0xffff)
    }
  })

  it('is monotonic and stays inside a 16-bit word', () => {
    let previous = -1
    for (let percent = 0; percent <= 100; percent += 1) {
      const value = encodedStrength(percent / 100, undefined)
      expect(value).toBeGreaterThanOrEqual(previous)
      expect(value).toBeLessThanOrEqual(0xffff)
      previous = value
    }
  })

  it('fails closed on nonsense input', () => {
    expect(encodedStrength(Number.NaN, undefined)).toBe(0)
    expect(encodedStrength(-1, undefined)).toBe(0)
    expect(encodedStrength(5, undefined)).toBe(encodedStrength(1, undefined))
  })
})

describe('XHTKJ strength packets', () => {
  it('repeats the main value in both groups when there is no secondary output', () => {
    const packet = strengthPacket(0.5, undefined, undefined)
    const value = encodedStrength(0.5, undefined)
    expect(packet[2]).toBe(COMMAND.strength)
    for (const base of [3, 11]) {
      expect(readU16(packet, base)).toBe(0xfc00)
      expect(readU16(packet, base + 2)).toBe(0xfe00)
      expect(readU16(packet, base + 4)).toBe(0x0140)
      expect(readU16(packet, base + 6)).toBe(value)
    }
  })

  it('encodes a heat product with the raw secondary scale in the first word', () => {
    const packet = strengthPacket(0.5, 0.25, 29)
    expect(readU16(packet, 3)).toBe(((Math.trunc(1023 * 0.25) << 6) | 60) & 0xffff)
    // The main channel keeps the generic group in the second half.
    expect(readU16(packet, 11)).toBe(0xfc00)
    expect(readU16(packet, 17)).toBe(encodedStrength(0.5, 29))
  })

  it('encodes an electric product with its own multiplier and offset', () => {
    const packet = strengthPacket(0.5, 0.5, 87)
    expect(readU16(packet, 3)).toBe(0xfc00)
    expect(readU16(packet, 5)).toBe(0x0040)
    expect(readU16(packet, 7)).toBe(encodedStrength(0.5, 87))
    expect(readU16(packet, 11)).toBe(0xfa40)
    expect(readU16(packet, 13)).toBe(0xfe00)
    expect(readU16(packet, 15)).toBe((Math.trunc(10 * (90 * 0.5 + 10)) << 6) & 0xffff)
    expect(readU16(packet, 17)).toBe(((Math.trunc(1023 * (0.1 * 0.5 + 0.4)) << 6) | 63) & 0xffff)
  })

  it('uses the documented idle words when an electric secondary is zero', () => {
    const packet = strengthPacket(0.5, 0, 87)
    expect(readU16(packet, 15)).toBe(0x1900)
    expect(readU16(packet, 17)).toBe(63)
  })

  it('encodes a shock product with its own secondary curve', () => {
    const packet = strengthPacket(0.5, 0.5, 94)
    expect(readU16(packet, 3)).toBe(0xfc00)
    expect(readU16(packet, 5)).toBe(0x0040)
    expect(readU16(packet, 7)).toBe(encodedStrength(0.5, 94))
    expect(readU16(packet, 11)).toBe(0xfc00)
    expect(readU16(packet, 13)).toBe(0x0040)
    expect(readU16(packet, 15)).toBe(((Math.trunc(1023 * (0.4 * 0.5 + 0.3)) << 6) | 63) & 0xffff)

    const idle = strengthPacket(0.5, 0, 94)
    expect(readU16(idle, 15)).toBe(63)
  })

  it('encodes a generic dual output as two independent strength groups', () => {
    const packet = strengthPacket(0.8, 0.2, 0x2000)
    expect(readU16(packet, 9)).toBe(encodedStrength(0.8, 0x2000))
    expect(readU16(packet, 17)).toBe(encodedStrength(0.2, 0x2000))
  })

  it('never exceeds the packet length', () => {
    for (const id of [undefined, 1, 4, 87, 94, 0x2000]) {
      expect(strengthPacket(1, 1, id)).toHaveLength(PACKET_LENGTH)
      expect(strengthPacket(1, undefined, id)).toHaveLength(PACKET_LENGTH)
    }
  })
})

describe('XHTKJ custom waveform upload', () => {
  it('brackets the data packets with prepare and end markers', () => {
    const packets = wavePackets([0.1], undefined)
    expect(packets).toHaveLength(3)
    expect(packets[0]).toBe(PREPARE_WAVE_PACKET)
    expect(packets[1]?.[2]).toBe(COMMAND.waveData)
    const end = packets.at(-1)!
    expect(end[2]).toBe(COMMAND.waveEnd)
    expect([...end.slice(3, 11)].every(byte => byte === 0xff)).toBe(true)
    expect([...end.slice(11)].every(byte => byte === 0)).toBe(true)
  })

  it('prefixes the parameter stream with the two fixed words', () => {
    const packets = wavePackets([0.5, 0.75], undefined)
    const first = packets[1]!
    expect(readU16(first, 3)).toBe(0xfc00)
    expect(readU16(first, 5)).toBe(0xfe00)
    expect(readU16(first, 7)).toBe(encodedStrength(0.5, undefined))
    expect(readU16(first, 9)).toBe(encodedStrength(0.75, undefined))
  })

  it('repeats each group of four words to fill all eight slots', () => {
    const packets = wavePackets([0.5, 0.75], undefined)
    const first = packets[1]!
    for (let slot = 0; slot < 4; slot += 1) {
      expect(readU16(first, 3 + 2 * slot)).toBe(readU16(first, 11 + 2 * slot))
    }
  })

  it('splits a longer waveform across data packets and zero-pads the tail', () => {
    // Two fixed words plus six values is eight parameters: two groups of four.
    const packets = wavePackets([0.1, 0.2, 0.3, 0.4, 0.5, 0.6], undefined)
    expect(packets).toHaveLength(4)

    const odd = wavePackets([0.1], undefined)
    const only = odd[1]!
    // Group is [0xFC00, 0xFE00, value, 0].
    expect(readU16(only, 9)).toBe(0)
  })

  it('emits only 20-byte packets', () => {
    for (const packet of wavePackets([0.1, 0.2, 0.3, 0.4, 0.5], 87)) {
      expect(packet).toHaveLength(PACKET_LENGTH)
    }
  })
})

describe('XHTKJ wave data packet', () => {
  it('writes up to eight little-endian words from offset 3', () => {
    const packet = waveDataPacket([0x0102, 0x0304])
    expect(readU16(packet, 3)).toBe(0x0102)
    expect(readU16(packet, 5)).toBe(0x0304)
    expect(readU16(packet, 7)).toBe(0)
  })

  it('ignores anything past the eighth word', () => {
    const packet = waveDataPacket([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(readU16(packet, 17)).toBe(8)
    expect(packet).toHaveLength(PACKET_LENGTH)
  })
})
