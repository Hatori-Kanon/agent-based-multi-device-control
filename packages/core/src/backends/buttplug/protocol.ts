/**
 * Buttplug JSON protocol, versions 3 and 4.
 *
 * Ported from `_reference/dsh-toy/src/buttplug.ts` (BSD-3-Clause); see NOTICE.
 * Pure encoding and parsing so both wire versions can be checked against
 * fixtures without a server.
 *
 * A frame is a JSON **array** of single-key objects, each key naming the message
 * type and each value carrying an `Id` for correlation:
 *
 *     [{"RequestServerInfo":{"Id":1,"ClientName":"x","MessageVersion":3}}]
 *
 * The two versions differ in shape more than in spirit:
 *
 * - v3 lists devices as an **array** and drives them with `ScalarCmd`, whose
 *   values are 0-1 floats.
 * - v4 lists devices as a **map** and drives them with `OutputCmd`, whose values
 *   are integers inside a range the device advertises per feature.
 */

import { SafetyError } from '../../devices/errors.ts'

export type ButtplugProtocolVersion = 3 | 4

/**
 * Actuator kinds exposed as levels.
 *
 * Position, direction, sensors, and raw access are out of scope: a scalar is
 * the only thing that maps onto a `level` channel.
 */
export type ButtplugFeatureKind = 'vibrate' | 'oscillate' | 'constrict' | 'inflate'

const KINDS: Readonly<Record<string, ButtplugFeatureKind>> = {
  vibrate: 'vibrate',
  oscillate: 'oscillate',
  constrict: 'constrict',
  inflate: 'inflate',
}

/** Wire spelling of a kind, which is capitalised. */
export function protocolKind(kind: ButtplugFeatureKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function normalizeKind(value: string): ButtplugFeatureKind | undefined {
  return KINDS[value.toLowerCase()]
}

export interface ButtplugFeature {
  readonly deviceIndex: number
  readonly featureIndex: number
  readonly kind: ButtplugFeatureKind
  readonly description: string
  /** Inclusive value range the device advertises. v3 scalars are always 0-1. */
  readonly range: readonly [number, number]
}

export interface ButtplugDevice {
  readonly index: number
  readonly name: string
  readonly displayName?: string
  readonly features: readonly ButtplugFeature[]
}

export interface ProtocolFrame {
  readonly type: string
  readonly body: Readonly<Record<string, unknown>>
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string, fallback = ''): string {
  const field = value[key]
  return typeof field === 'string' ? field : fallback
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

/** Encode one outbound message. */
export function encodeMessage(type: string, id: number, fields: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify([{ [type]: { Id: id, ...fields } }])
}

/**
 * Split an inbound frame into messages.
 *
 * @throws SafetyError when the frame is not a JSON array of single-key objects,
 *   which means the peer is not speaking this protocol.
 */
export function parseFrames(text: string): ProtocolFrame[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SafetyError('NOT_CONNECTED', 'Buttplug server sent invalid JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new SafetyError('NOT_CONNECTED', 'Buttplug frame is not a JSON array')
  }
  const frames: ProtocolFrame[] = []
  for (const item of parsed) {
    if (!isObject(item)) continue
    const entry = Object.entries(item)[0]
    if (entry === undefined || !isObject(entry[1])) continue
    frames.push({ type: entry[0], body: entry[1] })
  }
  return frames
}

/** Handshake body for the negotiated version. */
export function serverInfoRequest(clientName: string, version: ButtplugProtocolVersion): Record<string, unknown> {
  return version === 4
    ? { ClientName: clientName, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 }
    : { ClientName: clientName, MessageVersion: 3 }
}

function v3Features(device: Record<string, unknown>, deviceIndex: number): ButtplugFeature[] {
  const messages = device.DeviceMessages
  if (!isObject(messages) || !Array.isArray(messages.ScalarCmd)) return []
  const features: ButtplugFeature[] = []
  for (const [index, raw] of messages.ScalarCmd.entries()) {
    if (!isObject(raw)) continue
    const rawKind = stringField(raw, 'ActuatorType')
    const kind = normalizeKind(rawKind)
    if (kind === undefined) continue
    features.push({
      deviceIndex,
      featureIndex: index,
      kind,
      description: stringField(raw, 'FeatureDescriptor', `${rawKind} ${index}`),
      range: [0, 1],
    })
  }
  return features
}

function v4Features(device: Record<string, unknown>, deviceIndex: number): ButtplugFeature[] {
  if (!isObject(device.DeviceFeatures)) return []
  const features: ButtplugFeature[] = []
  for (const [mapIndex, raw] of Object.entries(device.DeviceFeatures)) {
    if (!isObject(raw) || !isObject(raw.Output)) continue
    const featureIndex = numberField(raw, 'FeatureIndex') ?? Number(mapIndex)
    if (!Number.isInteger(featureIndex) || featureIndex < 0) continue
    for (const [outputType, rawOutput] of Object.entries(raw.Output)) {
      const kind = normalizeKind(outputType)
      if (kind === undefined || !isObject(rawOutput) || !Array.isArray(rawOutput.Value)) continue
      const min = rawOutput.Value[0]
      const max = rawOutput.Value[1]
      if (
        typeof min !== 'number' || typeof max !== 'number'
        || !Number.isFinite(min) || !Number.isFinite(max) || max <= 0
      ) continue
      features.push({
        deviceIndex,
        featureIndex,
        kind,
        description: stringField(raw, 'FeatureDescription', `${outputType} ${featureIndex}`),
        range: [min, max],
      })
    }
  }
  return features
}

/** Parse one device entry. `fallbackIndex` supplies the v4 map key. */
export function parseDevice(
  raw: unknown,
  version: ButtplugProtocolVersion,
  fallbackIndex?: number,
): ButtplugDevice | undefined {
  if (!isObject(raw)) return undefined
  const index = numberField(raw, 'DeviceIndex') ?? fallbackIndex
  if (index === undefined || !Number.isInteger(index) || index < 0) return undefined
  const displayName = raw.DeviceDisplayName
  return {
    index,
    name: stringField(raw, 'DeviceName', `Buttplug device ${index}`),
    ...(typeof displayName === 'string' ? { displayName } : {}),
    features: version === 4 ? v4Features(raw, index) : v3Features(raw, index),
  }
}

/**
 * Parse a `DeviceList` body.
 *
 * @throws SafetyError when `Devices` has the wrong shape for the negotiated
 *   version, which indicates a version mismatch rather than an empty server.
 */
export function parseDeviceList(body: unknown, version: ButtplugProtocolVersion): ButtplugDevice[] {
  if (!isObject(body)) throw new SafetyError('NOT_CONNECTED', 'Buttplug DeviceList body is not an object')
  const devices: ButtplugDevice[] = []
  if (version === 3) {
    if (!Array.isArray(body.Devices)) {
      throw new SafetyError('NOT_CONNECTED', 'Buttplug v3 DeviceList.Devices is not an array')
    }
    for (const raw of body.Devices) {
      const parsed = parseDevice(raw, version)
      if (parsed !== undefined) devices.push(parsed)
    }
    return devices
  }
  if (!isObject(body.Devices)) {
    throw new SafetyError('NOT_CONNECTED', 'Buttplug v4 DeviceList.Devices is not a map')
  }
  for (const [key, raw] of Object.entries(body.Devices)) {
    const parsed = parseDevice(raw, version, Number(key))
    if (parsed !== undefined) devices.push(parsed)
  }
  return devices
}

/** Stable channel id for one feature. */
export function channelIdFor(feature: ButtplugFeature): string {
  return `${feature.deviceIndex}:${feature.featureIndex}:${feature.kind}`
}

export interface ParsedChannelId {
  readonly deviceIndex: number
  readonly featureIndex: number
  readonly kind: ButtplugFeatureKind
}

export function parseChannelId(channelId: string): ParsedChannelId | undefined {
  const match = /^(\d+):(\d+):([a-z]+)$/.exec(channelId)
  if (match === null) return undefined
  const kind = normalizeKind(match[3]!)
  if (kind === undefined) return undefined
  return { deviceIndex: Number(match[1]), featureIndex: Number(match[2]), kind }
}

/**
 * Map a percentage onto the value the feature expects.
 *
 * v3 scalars are 0-1 floats. v4 features advertise an integer range, and a
 * non-zero percentage is lifted to at least the advertised minimum — a value
 * below it would be rejected or silently ignored.
 */
export function featureValue(feature: ButtplugFeature, percent: number, version: ButtplugProtocolVersion): number {
  const bounded = Number.isFinite(percent) ? Math.min(Math.max(percent, 0), 100) : 0
  if (version === 3) return bounded / 100
  if (bounded === 0) return 0
  return Math.max(feature.range[0], Math.round((feature.range[1] * bounded) / 100))
}

/** Body of a v3 `ScalarCmd` driving one or more features of one device. */
export function scalarCommandBody(
  deviceIndex: number,
  entries: readonly { feature: ButtplugFeature; percent: number }[],
): Record<string, unknown> {
  return {
    DeviceIndex: deviceIndex,
    Scalars: entries.map(entry => ({
      Index: entry.feature.featureIndex,
      Scalar: featureValue(entry.feature, entry.percent, 3),
      ActuatorType: protocolKind(entry.feature.kind),
    })),
  }
}

/** Body of a v4 `OutputCmd` driving exactly one feature. */
export function outputCommandBody(feature: ButtplugFeature, percent: number): Record<string, unknown> {
  return {
    DeviceIndex: feature.deviceIndex,
    FeatureIndex: feature.featureIndex,
    Command: { [protocolKind(feature.kind)]: { Value: featureValue(feature, percent, 4) } },
  }
}

/** Body of the version-appropriate stop-everything message. */
export function stopAllBody(version: ButtplugProtocolVersion): { type: string; body: Record<string, unknown> } {
  return version === 4
    ? { type: 'StopCmd', body: { Inputs: false, Outputs: true } }
    : { type: 'StopAllDevices', body: {} }
}
