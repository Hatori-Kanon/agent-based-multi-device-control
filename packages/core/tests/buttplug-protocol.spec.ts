import { describe, expect, it } from 'vitest'
import {
  SafetyError,
  channelIdFor,
  encodeMessage,
  featureValue,
  outputCommandBody,
  parseChannelId,
  parseDeviceList,
  parseFrames,
  protocolKind,
  scalarCommandBody,
  serverInfoRequest,
  stopAllBody,
  type ButtplugFeature,
} from '../src/index.ts'

/** A v3 device list as Intiface reports it: an array. */
const V3_DEVICES = [
  {
    DeviceIndex: 0,
    DeviceName: 'Lovense Lush 3',
    DeviceMessages: {
      ScalarCmd: [
        { ActuatorType: 'Vibrate', FeatureDescriptor: 'Vibrator' },
        { ActuatorType: 'Oscillate', FeatureDescriptor: 'Oscillator' },
        // Position is not a scalar level and must be dropped.
        { ActuatorType: 'Position', FeatureDescriptor: 'Slider' },
      ],
    },
  },
]

/** The same idea in v4: a map, with per-feature advertised ranges. */
const V4_DEVICES = {
  '0': {
    DeviceIndex: 0,
    DeviceName: 'RoomFun Cannon',
    DeviceDisplayName: 'Cannon',
    DeviceFeatures: {
      '0': {
        FeatureIndex: 0,
        FeatureDescription: 'Vibration',
        Output: { Vibrate: { Value: [1, 20] } },
      },
      '1': {
        FeatureIndex: 1,
        FeatureDescription: 'Broken',
        // max of 0 is unusable and must be skipped.
        Output: { Vibrate: { Value: [0, 0] } },
      },
    },
  },
}

function feature(overrides: Partial<ButtplugFeature> = {}): ButtplugFeature {
  return {
    deviceIndex: 0,
    featureIndex: 0,
    kind: 'vibrate',
    description: 'Vibrator',
    range: [0, 1],
    ...overrides,
  }
}

describe('Buttplug frame encoding', () => {
  it('wraps a message in the single-key array the protocol expects', () => {
    expect(encodeMessage('Ping', 7)).toBe('[{"Ping":{"Id":7}}]')
    expect(JSON.parse(encodeMessage('ScalarCmd', 2, { DeviceIndex: 1 }))).toEqual([
      { ScalarCmd: { Id: 2, DeviceIndex: 1 } },
    ])
  })

  it('splits a frame into messages and skips entries it cannot read', () => {
    const frames = parseFrames('[{"Ok":{"Id":1}},"junk",{"ServerInfo":{"Id":2,"ServerName":"x"}}]')
    expect(frames.map(frame => frame.type)).toEqual(['Ok', 'ServerInfo'])
    expect(frames[1]?.body.ServerName).toBe('x')
  })

  it('refuses input that is not this protocol', () => {
    expect(() => parseFrames('not json')).toThrow(SafetyError)
    expect(() => parseFrames('{"Ok":{}}')).toThrow(/not a JSON array/)
  })

  it('capitalises a kind for the wire', () => {
    expect(protocolKind('vibrate')).toBe('Vibrate')
    expect(protocolKind('constrict')).toBe('Constrict')
  })

  it('negotiates the version the server expects', () => {
    expect(serverInfoRequest('c', 3)).toEqual({ ClientName: 'c', MessageVersion: 3 })
    expect(serverInfoRequest('c', 4)).toEqual({
      ClientName: 'c',
      ProtocolVersionMajor: 4,
      ProtocolVersionMinor: 0,
    })
  })
})

describe('Buttplug device list parsing', () => {
  it('reads a v3 array and keeps only scalar actuators', () => {
    const devices = parseDeviceList({ Devices: V3_DEVICES }, 3)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.name).toBe('Lovense Lush 3')
    expect(devices[0]?.features.map(entry => entry.kind)).toEqual(['vibrate', 'oscillate'])
    // v3 scalars are always a 0-1 float, so no advertised range.
    expect(devices[0]?.features[0]?.range).toEqual([0, 1])
  })

  it('reads a v4 map, honours the display name, and drops an unusable feature', () => {
    const devices = parseDeviceList({ Devices: V4_DEVICES }, 4)
    expect(devices).toHaveLength(1)
    expect(devices[0]?.displayName).toBe('Cannon')
    expect(devices[0]?.features).toHaveLength(1)
    expect(devices[0]?.features[0]?.range).toEqual([1, 20])
  })

  it('reports a version mismatch instead of quietly finding nothing', () => {
    // An empty server and a wrong-shaped list must not look the same.
    expect(() => parseDeviceList({ Devices: V4_DEVICES }, 3)).toThrow(/not an array/)
    expect(() => parseDeviceList({ Devices: V3_DEVICES }, 4)).toThrow(/not a map/)
    expect(() => parseDeviceList('nope', 4)).toThrow(/not an object/)
  })

  it('accepts an empty list', () => {
    expect(parseDeviceList({ Devices: [] }, 3)).toEqual([])
    expect(parseDeviceList({ Devices: {} }, 4)).toEqual([])
  })

  it('falls back to the map key when a v4 entry omits its index', () => {
    const devices = parseDeviceList({
      Devices: { '3': { DeviceName: 'x', DeviceFeatures: { '0': { Output: { Vibrate: { Value: [0, 10] } } } } } },
    }, 4)
    expect(devices[0]?.index).toBe(3)
  })
})

describe('Buttplug channel ids', () => {
  it('round-trips', () => {
    const id = channelIdFor(feature({ deviceIndex: 2, featureIndex: 5, kind: 'inflate' }))
    expect(id).toBe('2:5:inflate')
    expect(parseChannelId(id)).toEqual({ deviceIndex: 2, featureIndex: 5, kind: 'inflate' })
  })

  it('rejects anything that is not one', () => {
    expect(parseChannelId('nope')).toBeUndefined()
    expect(parseChannelId('0:0:position')).toBeUndefined()
    expect(parseChannelId('0:0')).toBeUndefined()
  })
})

describe('Buttplug value mapping', () => {
  it('sends a 0-1 float on v3', () => {
    expect(featureValue(feature(), 0, 3)).toBe(0)
    expect(featureValue(feature(), 50, 3)).toBe(0.5)
    expect(featureValue(feature(), 100, 3)).toBe(1)
  })

  it('scales into the advertised integer range on v4', () => {
    const target = feature({ range: [1, 20] })
    expect(featureValue(target, 0, 4)).toBe(0)
    expect(featureValue(target, 50, 4)).toBe(10)
    expect(featureValue(target, 100, 4)).toBe(20)
  })

  it('lifts a small non-zero percentage to the advertised minimum', () => {
    // Below the minimum the device would ignore the command outright.
    const target = feature({ range: [5, 20] })
    expect(featureValue(target, 1, 4)).toBe(5)
    // Zero still means off.
    expect(featureValue(target, 0, 4)).toBe(0)
  })

  it('fails closed on nonsense input', () => {
    expect(featureValue(feature(), Number.NaN, 3)).toBe(0)
    expect(featureValue(feature(), -10, 3)).toBe(0)
    expect(featureValue(feature(), 500, 3)).toBe(1)
  })
})

describe('Buttplug command bodies', () => {
  it('builds a v3 ScalarCmd carrying every targeted feature', () => {
    const body = scalarCommandBody(1, [
      { feature: feature({ deviceIndex: 1, featureIndex: 0 }), percent: 40 },
      { feature: feature({ deviceIndex: 1, featureIndex: 1, kind: 'oscillate' }), percent: 100 },
    ])
    expect(body).toEqual({
      DeviceIndex: 1,
      Scalars: [
        { Index: 0, Scalar: 0.4, ActuatorType: 'Vibrate' },
        { Index: 1, Scalar: 1, ActuatorType: 'Oscillate' },
      ],
    })
  })

  it('builds a v4 OutputCmd for exactly one feature', () => {
    expect(outputCommandBody(feature({ featureIndex: 2, range: [1, 20] }), 50)).toEqual({
      DeviceIndex: 0,
      FeatureIndex: 2,
      Command: { Vibrate: { Value: 10 } },
    })
  })

  it('uses the version-appropriate stop message', () => {
    expect(stopAllBody(3)).toEqual({ type: 'StopAllDevices', body: {} })
    expect(stopAllBody(4)).toEqual({ type: 'StopCmd', body: { Inputs: false, Outputs: true } })
  })
})
