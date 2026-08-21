/**
 * Platform-free core for agent-hosted multi-device roleplay.
 *
 * M0 scope: the safety runtime only. Waveforms, real backends, sensors, the
 * agent loop, and the scenario system arrive in later milestones.
 *
 * @module @embodied/core
 */

export { systemClock } from './ports/clock.ts'
export type { Clock, Timer } from './ports/clock.ts'
export { bleUuid } from './ports/ble.ts'
export type { BleCharacteristicRef, BleFilter, BlePeripheral, BleTransport } from './ports/ble.ts'
export { MockBlePeripheral, MockBleTransport } from './ports/mock-ble.ts'
export type { MockBlePeripheralOptions, MockBleTransportOptions, MockBleWrite } from './ports/mock-ble.ts'
export { stubFetch } from './ports/http.ts'
export type { FetchLike, HttpRequestInit, HttpResponseLike } from './ports/http.ts'
export type {
  TextSocket,
  TextSocketCloseInfo,
  TextSocketOpenOptions,
  TextSocketTransport,
} from './ports/websocket.ts'
export { MockTextSocket, MockTextSocketTransport } from './ports/mock-websocket.ts'
export type { MockTextSocketTransportOptions } from './ports/mock-websocket.ts'
export { FakeClock } from './ports/fake-clock.ts'
export { MemoryAppendOnlyStore, MemoryDocumentStore } from './ports/storage.ts'
export type { AppendOnlyStore, DocumentStore } from './ports/storage.ts'

export { AuditLog } from './devices/audit.ts'
export type { AuditActor, AuditFailureHandler, AuditRecord, AuditResult } from './devices/audit.ts'

export {
  assertValidEnvelope,
  createEnvelopeSampler,
  DEFAULT_TICK_MS,
  EffectRunner,
  MIN_PERIOD_MS,
} from './devices/effect.ts'
export type {
  EffectRunnerOptions,
  EffectSnapshot,
  Envelope,
  EnvelopePreset,
  EnvelopeSampler,
} from './devices/effect.ts'

export { isSafetyError, SafetyError } from './devices/errors.ts'
export type { SafetyErrorCode } from './devices/errors.ts'

export {
  ABSOLUTE_MAX_DURATION_SEC,
  ABSOLUTE_MAX_PERCENT,
  ABSOLUTE_MAX_WAVE_INTENSITY,
  assertLevelWithinPolicy,
  assertValidPolicy,
  clampPercentToPolicy,
  DEFAULT_CHANNEL_POLICY,
  PolicyStore,
} from './devices/policy.ts'
export type { ChannelPolicy, PolicyChange } from './devices/policy.ts'

export { SerialQueue } from './devices/queue.ts'

export { DeviceRegistry } from './devices/registry.ts'
export type {
  ChannelSnapshot,
  DeviceRegistryOptions,
  DeviceSnapshot,
  LevelCommand,
  PatternCommand,
  RegistrySnapshot,
} from './devices/registry.ts'

export type { Channel, ChannelKind, DeviceBackend, DeviceLifecycle } from './devices/types.ts'

export { createBuiltinWaveforms } from './waveform/builtin.ts'
export {
  clampFrameIntensity,
  clampWaveformIntensity,
  DEFAULT_MAX_WAVE_INTENSITY,
  peakIntensity,
} from './waveform/clamp.ts'
export { compileWaveformScript } from './waveform/dsl.ts'
export type {
  CompiledWaveform,
  RampedValue,
  WaveformCurve,
  WaveformScript,
  WaveformSegment,
} from './waveform/dsl.ts'
export { formatHexFrame, parseHexFrame, parseHexFrames } from './waveform/hex.ts'
export {
  deserializeWaveform,
  MAX_SESSION_WAVEFORMS,
  serializeWaveform,
  WaveformLibrary,
} from './waveform/library.ts'
export type { SerializedWaveform, WaveformLibraryOptions } from './waveform/library.ts'
export {
  buildSlots,
  frameAt,
  FRAME_MS,
  MAX_FRAMES,
  MAX_FREQ,
  MAX_INTENSITY,
  MIN_FREQ,
  MIN_INTENSITY,
  SLOT_MS,
  SLOTS_PER_FRAME,
  summarizeWaveform,
  waveformDurationMs,
} from './waveform/types.ts'
export type {
  FrameSlots,
  PulseFrame,
  Waveform,
  WaveformScope,
  WaveformSource,
  WaveformSummary,
} from './waveform/types.ts'

export { MockBackend } from './backends/mock/index.ts'
export type { MockBackendOptions, MockWrite } from './backends/mock/index.ts'

export {
  B0_LENGTH,
  B1_LENGTH,
  BF_LENGTH,
  clampStrength,
  COYOTE_BATTERY_CHARACTERISTIC,
  COYOTE_BATTERY_SERVICE,
  COYOTE_BLE_NAME,
  COYOTE_NOTIFY_CHARACTERISTIC,
  COYOTE_SERVICE,
  COYOTE_WRITE_CHARACTERISTIC,
  decodeNotification,
  encodeB0,
  encodeBF,
  MAX_SEQ,
  MAX_STRENGTH,
  percentToStrength,
  SILENT_FREQ,
  SILENT_INTENSITY,
  strengthToPercent,
  toHex,
} from './backends/coyote/protocol.ts'
export type { B0Fields, B1Message, BFFields, StrengthMode } from './backends/coyote/protocol.ts'
export {
  COYOTE_PLAIN_FRAME,
  CoyoteBackend,
  DEFAULT_FREQUENCY_BALANCE,
  DEFAULT_INTENSITY_BALANCE,
} from './backends/coyote/backend.ts'
export type { CoyoteBackendOptions, CoyoteChannelId } from './backends/coyote/backend.ts'
export {
  MONSTERPARTY_API_URL,
  MONSTERPARTY_ORIGIN,
  MonsterPartyBackend,
} from './backends/monsterparty/backend.ts'
export type { MonsterPartyBackendOptions } from './backends/monsterparty/backend.ts'

export {
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
  waveDataPacket,
  wavePackets,
} from './backends/xhtkj/protocol.ts'
export type { XhtkjCapability } from './backends/xhtkj/protocol.ts'
export { XhtkjBackend } from './backends/xhtkj/backend.ts'
export type { XhtkjBackendOptions, XhtkjChannelId } from './backends/xhtkj/backend.ts'

export {
  channelIdFor,
  encodeMessage,
  featureValue,
  outputCommandBody,
  parseChannelId,
  parseDevice,
  parseDeviceList,
  parseFrames,
  protocolKind,
  scalarCommandBody,
  serverInfoRequest,
  stopAllBody,
} from './backends/buttplug/protocol.ts'
export type {
  ButtplugDevice,
  ButtplugFeature,
  ButtplugFeatureKind,
  ButtplugProtocolVersion,
  ParsedChannelId,
  ProtocolFrame,
} from './backends/buttplug/protocol.ts'
export { ButtplugBackend, INTIFACE_DEFAULT_URL } from './backends/buttplug/backend.ts'
export type { ButtplugBackendOptions } from './backends/buttplug/backend.ts'
