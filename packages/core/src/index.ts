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
  clampEnvelopeToRange,
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
  clampPercentToRange,
  DEFAULT_CHANNEL_POLICY,
  DEFAULT_SESSION_CEILING,
  mapPercentThroughRange,
  parsePolicySnapshot,
  POLICY_SNAPSHOT_VERSION,
  PolicyStore,
  serializePolicySnapshot,
} from './devices/policy.ts'
export type { ChannelPolicy, PercentRange, PolicyChange, PolicySnapshot } from './devices/policy.ts'

export { SerialQueue } from './devices/queue.ts'

export { RegionStore } from './devices/regions.ts'
export type { RegionChange, RegionStoreOptions } from './devices/regions.ts'

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
  clampFrameFrequency,
  clampFrameIntensity,
  clampWaveformFrequency,
  clampWaveformIntensity,
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
export type { CoyoteBackendOptions, CoyoteChannelId, CoyoteFrequencyRange } from './backends/coyote/backend.ts'
export {
  codeToHz,
  frequencyBandToHz,
  hzBandToCode,
  hzToCode,
  MAX_FREQ_CODE,
  MAX_FREQ_HZ,
  MIN_FREQ_CODE,
  MIN_FREQ_HZ,
} from './backends/coyote/frequency.ts'
export type { FrequencyBandCode, FrequencyBandHz } from './backends/coyote/frequency.ts'
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
export type { WaveformLookup } from './scenario/intents.ts'
export { DEFAULT_INTENTS, ENVELOPE_DEFAULTS, STRENGTH_RATIO } from './scenario/default-intents.ts'
// ── M2 · two-call pipeline (B2-T3) ──────────────────────────────────────
export { DEFAULT_SPLIT_DIRECTOR_TIMEOUT_MS, DEFAULT_SPLIT_WRITER_TIMEOUT_MS, TurnPipeline } from './agent/pipeline.ts'
export type {
  SplitTimeouts,
  TurnContextProvider,
  TurnContextSource,
  TurnInput,
  TurnPipelineMode,
  TurnPipelineOptions,
  TurnPipelineResult,
} from './agent/pipeline.ts'

// ── M2 · session archive and cross-session ledger (B2-T7/T8) ────────────
export {
  MAX_STATE_PATCH_BYTES,
  MAX_STATE_PATCH_DEPTH,
  SessionStore,
  STATE_PATCH_FIELDS,
  StateStoreError,
} from './state/store.ts'
export type {
  OpenSessionInput,
  PatchResult,
  RejectedPatchPath,
  SessionState,
  SessionStoreOptions,
  StatePatchField,
} from './state/store.ts'
export {
  CLEARED_MARKER_KEY,
  matchMetaReactions,
  OPEN_MARKER_KEY,
  SESSION_END_REASONS,
  SessionLedger,
} from './memory/ledger.ts'
export type {
  LedgerEntry,
  LedgerSnapshotFact,
  LedgerSnapshotSource,
  LedgerTextReader,
  OpeningBrief,
  SessionEndReason,
  SessionLedgerOptions,
} from './memory/ledger.ts'

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

// ── M2 · model tool surface and prompts (B1-T8..T9) ─────────────────────
export {
  BEAT_PLAN_ENGINE_FIELDS,
  isModelTool,
  M2_HUMAN_ONLY_TOOL_NAMES,
  M2_MODEL_TOOL_NAMES,
  M2_MODEL_TOOLS,
  M2_TOOL_SCHEMAS,
  M2_TOOL_SCHEMAS_BY_NAME,
} from './agent/tools.ts'
export type { M2HumanOnlyToolName, M2ModelToolName, M2ToolName } from './agent/tools.ts'
export {
  buildSystemPrompt,
  buildTurnMessages,
  DEFAULT_SYSTEM_PROMPT_BUDGET_CHARS,
  PROMPT_SACRIFICE_ORDER,
  PROMPT_SECTION_ORDER,
  PROMPT_TRUNCATION_MARK,
} from './agent/prompt.ts'
export type { PromptSectionKey, SystemPromptInput, TurnMessagesInput } from './agent/prompt.ts'

// ── M2 · context projections (B2-T1/T2) ─────────────────────────────────
export {
  buildDirectorContext,
  DIRECTOR_CHARS_PER_TOKEN,
  DIRECTOR_CONTEXT_BUDGET_CHARS,
  DIRECTOR_CONTEXT_BUDGET_TOKENS,
  DIRECTOR_DEGRADED_INTENT_LIMIT,
  DIRECTOR_DIALOG_SUMMARY_LIMIT,
  DIRECTOR_PHASE_GOAL_HEADLINE_CHARS,
  DIRECTOR_PROBE_LIMIT,
  DIRECTOR_RECENT_BEAT_LIMIT,
  estimateDirectorTokens,
} from './agent/context/director.ts'
export type {
  DirectorContext,
  DirectorContextInput,
  DirectorDeviceView,
  DirectorIntentView,
  DirectorLevel,
  DirectorPhaseView,
  DirectorProbeDirection,
  DirectorProbeEntry,
  DirectorProbeFact,
  DirectorSessionFact,
  DirectorTimeView,
} from './agent/context/director.ts'
export {
  buildWriterContext,
  COMPRESSED_RECENT_LINES,
  DEFAULT_WRITER_CONTEXT_BUDGET_CHARS,
  humanizePlan,
  MAX_CORPUS_EXCERPTS,
  MAX_RECENT_LINES,
  WRITER_CONSTRAINTS,
  WRITER_TEMPLATE_LINE,
  writerContextChars,
} from './agent/context/writer.ts'
export type {
  HumanizePlanOptions,
  RegionLabelSource,
  WriterContext,
  WriterContextInput,
  WriterMustMention,
} from './agent/context/writer.ts'

export { APPLY_PLAN_TOOL, DEFAULT_TURN_TIMEOUT_MS, LOOK_TOOL, runTurn } from './agent/loop.ts'
export type { TurnExecutor, TurnLoopInput, TurnLoopOptions, TurnResult } from './agent/loop.ts'

// ── M2 · perception projections / look (A1-T7..T8) ───────────────────────
export { DEFAULT_SENSOR_BLOCK_BUDGET, sensorPromptBlock, sensorsListPayload } from './sensors/projection.ts'
export type { SensorsListPayload } from './sensors/projection.ts'
export { DEFAULT_PROBE_BLOCK_BUDGET, MAX_PROMPT_PROBES, probePromptBlock } from './sensors/projection.ts'
export type { ProbePromptAudience, ProbePromptBlockOptions } from './sensors/projection.ts'
export { DEFAULT_LOOK_MAX_AGE_MS, DEFAULT_LOOK_MAX_BYTES, readForLook } from './sensors/look.ts'
export type { ImageForModel, LookOptions } from './sensors/look.ts'

export { DEFAULT_PROBE_THRESHOLDS, ReactionProbeRecorder } from './sensors/probe.ts'

export { probeDirectorJson, probeWriterBrief } from './sensors/probe-projection.ts'
export type { ProbeDirection, ProbeDirectorEntry, ProbeMagnitude } from './sensors/probe-projection.ts'
export type {
  ProbeAction,
  ProbeAuditSink,
  ProbeDegradeReason,
  ProbeRecord,
  ProbeTarget,
  ProbeThresholds,
  ProbeTrigger,
  ProbeVerdict,
  ReactionProbeRecorderOptions,
} from './sensors/probe.ts'

// ── M2 · plan execution (B1-T7) ─────────────────────────────────────────
export { PlanExecutor } from './execution/executor.ts'
export type {
  DispatchDiagnostics,
  DispatchOptions,
  DispatchResult,
  DispatchStatus,
  PlanExecutorOptions,
  ProbeRegistrar,
} from './execution/executor.ts'

// ── M2 · pack import and registry (B2-T14 core half) ────────────────────
export { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, readZip, ZipError } from './scenario/zip.ts'
export type { RawInflate, ReadZipOptions, ZipErrorCode } from './scenario/zip.ts'
export {
  MemoryPackStore,
  PACKS_PREFIX,
  PackRegistry,
  PackRegistryError,
  REGISTRY_KEY,
} from './scenario/pack-registry.ts'
export type {
  InstallPackOptions,
  InstallResult,
  InstalledPackVersion,
  PackRegistryEntry,
  PackRegistryErrorCode,
  PackRegistryOptions,
  PackStore,
} from './scenario/pack-registry.ts'

// ── M2 · turn engine (B1-T11) ───────────────────────────────────────────
export {
  assertTransition,
  canTransition,
  isTerminalState,
  queuesWhenBusy,
  refusesNewTurns,
  startsTurn,
  TURN_PRIORITY_ORDER,
  TURN_STATES,
} from './engine/state-machine.ts'
export type {
  TurnOutcome,
  TurnPriority,
  TurnState,
  TurnTrigger,
  TurnTriggerKind,
} from './engine/state-machine.ts'
export { DEFAULT_ENGINE_CONFIG, TEMPLATE_LINE, TurnEngine } from './engine/turn-engine.ts'

// ── M2 · turn scheduler (B2-T4) ─────────────────────────────────────────
export { compareTriggers, planPreemption, priorityRank, PriorityQueue } from './engine/scheduler.ts'
export type {
  PreemptAuditAction,
  PreemptPlan,
  PreemptReason,
  PreemptStage,
  PriorityQueueDecision,
} from './engine/scheduler.ts'
export type {
  CheckpointUpdate,
  EndReason,
  EngineConfig,
  EngineEvent,
  EngineSnapshot,
  TurnEngineHooks,
  TurnEngineOptions,
  TurnRequest,
  TurnRunner,
  TurnRunnerResult,
} from './engine/turn-engine.ts'
export { checkpointReminder } from './engine/turn-engine.ts'
