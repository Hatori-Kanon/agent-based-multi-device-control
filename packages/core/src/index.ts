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
  clampEnvelopeToCap,
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

export type { DispatchEvent, DispatchEventKind } from './devices/events.ts'

export {
  ABSOLUTE_MAX_DURATION_SEC,
  ABSOLUTE_MAX_PERCENT,
  ABSOLUTE_MAX_WAVE_INTENSITY,
  assertLevelWithinPolicy,
  assertValidPolicy,
  clampPercentToPolicy,
  DEFAULT_CHANNEL_POLICY,
  DEFAULT_SESSION_CEILING,
  parsePolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  PolicyStore,
  serializePolicySnapshot,
} from './devices/policy.ts'
export type { ChannelPolicy, PolicyChange, PolicySnapshot } from './devices/policy.ts'

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

export { AnkniBackend } from './backends/ankni/backend.ts'
export type { AnkniBackendOptions, AnkniChannelId } from './backends/ankni/backend.ts'
export { ANKNI_STOP_FRAME, ANKNI_FRAME_LENGTH, encodeAnkniFrame } from './backends/ankni/protocol.ts'
export type { AnkniFrame } from './backends/ankni/protocol.ts'
export { adoptControlLayout, ALT_LAYOUT, CLASSIC_LAYOUT } from './backends/xhtkj/layout.ts'
export type { AdoptedLayout, XhtkjLayout } from './backends/xhtkj/layout.ts'

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
  XHTKJ_ALT_SERVICE,
  XHTKJ_ALT_STREAM_CHARACTERISTIC,
  XHTKJ_ALT_WRITE_CHARACTERISTIC,
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

// ── M2 · perception (A1/A2) ───────────────────────────────────────────────
export { DEFAULT_RETAIN_MS, FeatureRing } from './sensors/ring-buffer.ts'
export type { FeatureRingOptions } from './sensors/ring-buffer.ts'
export { DEFAULT_STALE_AFTER_MS, SensorRegistry } from './sensors/registry.ts'
export type { SensorRegistryOptions } from './sensors/registry.ts'
export { analyzeFrame, downsampleGray } from './sensors/imaging.ts'
export type { AnalyzeResult, FrameFeatures, GrayFrame, MotionState } from './sensors/imaging.ts'
export { isSensorError, SensorError } from './sensors/types.ts'
export type {
  FeatureSample,
  FeatureWindowStats,
  SensorErrorCode,
  SensorKind,
  SensorQuality,
  SensorSource,
  SensorStatus,
  Snapshot,
} from './sensors/types.ts'

// ── M2 · control contracts (B1-T4..T6) ───────────────────────────────────
export { parseBeatPlan, WHOLE_BODY_REGION } from './scenario/beat-plan.ts'
export type {
  Beat,
  BeatChange,
  BeatPlan,
  BeatStrength,
  BeatTarget,
  IntentDistribution,
  PlanContext,
  PlanDrop,
  PlanPacing,
  PlanValidation,
  PlayerChoice,
  WaveformModulation,
} from './scenario/beat-plan.ts'
export { resolvePlan } from './scenario/intents.ts'
export type {
  FeedbackIntent,
  IntentSuggest,
  ResolvedCommand,
  ResolvedCommandBody,
  ResolvedPlan,
  ResolveChannelSnapshot,
  ResolveContext,
  ResolveDeviceSnapshot,
  ResolveRegistrySnapshot,
} from './scenario/intents.ts'
export { DEFAULT_INTENTS, ENVELOPE_DEFAULTS, STRENGTH_RATIO } from './scenario/default-intents.ts'

// ── M2 · content packs (B1-T12..T14) ─────────────────────────────────────
export { ENGINE_VERSION } from './version.ts'
export { MemoryContentSource } from './ports/content-source.ts'
export type { ContentSource } from './ports/content-source.ts'
export { isValidVersion, parseVersion, satisfiesVersion } from './scenario/semver.ts'
export type { SemverVersion } from './scenario/semver.ts'
export { MAX_PACK_BYTES, validatePack } from './scenario/validate.ts'
export type { ValidatePackInput, ValidationIssue, ValidationSeverity } from './scenario/validate.ts'
export {
  ContentPackError,
  loadPack,
  PACK_MANIFEST_FILE,
  PACK_PERSONA_FILE,
  PACK_SCENARIO_FILE,
} from './scenario/loader.ts'
export type {
  LoadedPack,
  LoadPackOptions,
  MetaReaction,
  MetaReactionOpening,
  MetaReactionWhen,
  PackAftercare,
  PackHistory,
  PackManifest,
  PackMode,
  PackRating,
  PackSessionEndReason,
  ScenarioDefinition,
  ScenarioPhase,
  ScenarioPhaseWindow,
  ScenarioRegion,
  ScenarioSession,
} from './scenario/loader.ts'
export { DEFAULT_CHECKPOINTS, MUST_RESOLVE_RATIO, PhaseMachine } from './scenario/phases.ts'
export type { PhaseCheckpoint, PhaseNode, PhasePlanView } from './scenario/phases.ts'

// ── M2 · model gateway (B1-T1..T2) ───────────────────────────────────────
export { apiKeyEnvOf, DEFAULT_API_KEY_ENV, isModelError, ModelError, resolveModel } from './agent/model.ts'
export type {
  LlmConfig,
  LlmMessage,
  ModelConfig,
  ModelErrorCode,
  ModelErrorOptions,
  ModelFinishReason,
  ModelRole,
  ModelRunner,
  ModelTurnRequest,
  ModelTurnResult,
  ModelUsage,
  ToolCall,
  ToolDefinition,
} from './agent/model.ts'
export { ChatCompletionAccumulator, readResponseText, streamChatCompletion } from './agent/transport.ts'
export type { ChatCompletionAccumulatorOptions, ChatStreamOptions } from './agent/transport.ts'
export {
  CapabilityCache,
  extractJsonObject,
  OpenAICompatibleRunner,
  PROVIDER_CHAT_BASE_URLS,
} from './agent/adapters/openai-compatible.ts'
export type { ModelCapabilities, OpenAICompatibleOptions } from './agent/adapters/openai-compatible.ts'
