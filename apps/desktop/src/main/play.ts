/**
 * Host session service (B1-T16): one session that can answer a turn.
 *
 * This is the seam where the already-finished M2 contracts meet the desktop
 * host:
 *
 * - `loadPack` (B1-T12/T13) turns a directory into a validated {@link LoadedPack};
 * - a freeform pack has no `scenario.json`, so this module synthesises the
 *   documented single-phase scenario from `DEFAULT_INTENTS` (D-11 / S15);
 * - `PhaseMachine` (B1-T14) owns the current phase;
 * - `TurnEngine` (B1-T11) owns scheduling, preemption and the LOCKED latch;
 * - `runTurn` (B1-T10) is the single model call; the adapter below bridges the
 *   engine's {@link TurnRequest} to the loop's {@link TurnLoopOptions};
 * - `PlanExecutor` (B1-T7) is the only dispatch path to the `DeviceRegistry`.
 *
 * ## Session archive and cross-session memory (B2-T7/T8)
 *
 * When the host injects a {@link PlayArchive}, `start` first settles anything
 * the previous process left behind — the archive relabels a still-`active`
 * snapshot `recovered`, the ledger turns a stale open marker into
 * `unexpected_exit` — and then opens this session. `TurnEngine.onSettle`
 * writes one snapshot per settled turn (no replay of an interrupted turn),
 * `end`/`panic` write the final snapshot and **one** ledger line, and a pack
 * that declares `history.read` gets its `metaReactions` opening brief folded
 * into the opening turn's system prompt. The archive/ledger are injected, not
 * constructed here, so `bootstrap.ts` decides where the files live; absent
 * ports mean the session runs exactly as B1-T16 did and writes nothing.
 *
 * ## One active session
 *
 * {@link PlayHost} holds at most one {@link PlaySession} at a time. `start` is
 * refused while a session is running; an `ended` session is disposed and
 * replaced by the next `start` (the play view returns to the lobby after 结束,
 * so the next 开局 must be able to open a fresh session in the same process).
 * `message` and `end` are refused when no session was ever opened. Every
 * refusal is a typed {@link SessionError}; the HTTP layer maps it to `400`,
 * never `500`.
 *
 * ## The ceiling is human-only (D4)
 *
 * `ceilingPercent` arrives with `start` — the human's opening gesture — and is
 * written through `PolicyStore.setSessionCeilingByHuman`, persisted via the
 * host's `savePolicy`, and audited as the existing `policy_change` action with
 * `detail.scope = 'session'` (§4.11). No engine path, plan field or content-pack
 * value can raise it; this module has no other ceiling write.
 *
 * ## Pack lookup is temporary
 *
 * B1-T16 predates the pack registry (B2-T14). {@link DirectoryPackSource} reads
 * the documented layout (`<dataDir>/content/packs/<id>/<version>/`) and picks
 * the highest semver; B2-T14's registry replaces it without changing this
 * service's interface.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  buildTurnMessages,
  buildWorldFacts,
  ContentPackError,
  DEFAULT_INTENTS,
  loadPack,
  M2_MODEL_TOOLS,
  parseVersion,
  PhaseMachine,
  PlanExecutor,
  resolvePlan,
  runTurn,
  sensorPromptBlock,
  TurnEngine,
  WHOLE_BODY_REGION,
  withPlayableEnums,
  WRITER_TEMPLATE_LINE,
  type AuditLog,
  type AppendOnlyStore,
  type Clock,
  type DeviceRegistry,
  type DocumentStore,
  type EndReason,
  type EngineConfig,
  type EngineEvent,
  type EngineSnapshot,
  type FeedbackIntent,
  type LlmMessage,
  type LoadedPack,
  type ModelRunner,
  type PolicyStore,
  type RegistrySnapshot,
  type ResolveContext,
  type ScenarioDefinition,
  type SemverVersion,
  type SensorRegistry,
  type TurnExecutor,
  type TurnRequest,
  type TurnResult,
  type TurnRunner,
  type TurnRunnerResult,
  type WaveformLibrary,
  type DispatchEvent,
  type DispatchResult,
  type ResolvedCommandBody,
  type ResolvedPlan,
} from '@embodied/core'
import type { ContentSource } from '@embodied/core'
import {
  matchMetaReactions,
  ReactionProbeRecorder,
  SessionLedger,
  SessionStore,
  type LedgerEntry,
  type OpeningBrief,
  type ProbeRecord,
  type ProbeRegistrar,
  type SessionEndReason,
  type SessionState,
  type PlayerChoice,
  type WaveformLookup,
} from '@embodied/core'

/** Phase id of the synthetic freeform scene. */
export const FREEFORM_PHASE_ID = 'scene'

/** Default aftercare duration for a freeform pack (no `scenario.json`, S12). */
export const FREEFORM_AFTERCARE_MIN = 5

/** The opening turn is a session-level P2 trigger, not a player message. */
const OPENING_TRIGGER_KIND = 'resume' as const

/** Recent assistant lines kept in the conversation (the writer's memory). */
const RECENT_LINE_LIMIT = 8

/**
 * If the previous plan command's own duration still covers this much of the
 * model's think time, the effect is still running and must not be restarted
 * (a restart would also bump a finite effect back to a full hold window).
 * This is the *only* gate: user semantics are "unmentioned channels continue
 * last turn's behaviour until an explicit stop", so there is no TTL — a body
 * stays a continuation candidate for the whole session.
 */
const HOLD_REMAINING_THRESHOLD_MS = 6_000

/**
 * Seconds a `loop: true` waveform keeps playing on its own (user idea 2: a
 * loop texture should keep running through the model's thinking time instead
 * of being restarted by the continuity hold).
 *
 * The resolver raises a loop-waveform pattern's duration to
 * `min(this, channel.maxDurationSec)`; stop/level actions are untouched and a
 * non-loop asset (e.g. a stinger) keeps its short authored duration.
 */
const SUSTAIN_LOOP_SEC = 60

/** Pack ids follow `内容包规范.md` §3: lowercase slug. */
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

/**
 * Single-call model discipline, appended outside the prompt budget.
 *
 * DeepSeek tool-calling answers with an empty `content` (the prose can only
 * travel in the tool arguments), and a model that first calls read-only tools
 * gets no follow-up request in this single-call MVP — the turn would settle
 * with no line and no plan. So the protocol is explicit: no query tools, one
 * `apply_plan`, and the player-visible prose in its `narration` field.
 */
const TURN_PROTOCOL = [
  '本回合是单轮调用：devices_list、state_get、look、sensors_list、waveform_list 不会返回结果，不要调用它们。',
  '必须调用 apply_plan 恰好一次；intentId 和 regions 只能取自「本回合可用」，不要发明 id。',
  'regions 只能取「已就位部位」里列出的名字（whole-body 例外）；不要使用没有出现在「已就位部位」里的内容包 id。',
  '设备/通道 id 对模型不可见：不要使用 beats[].targets，只用 regions 指定部位；写错设备 id 的 beat 会回退到 regions。',
  '有已就位部位时，beats 里至少有一个动作带 regions；只写正文、不调用 apply_plan 的回合不会有任何设备输出。',
  '本回合未提及的通道默认延续上一回合输出；不再刺激某个部位时必须用 stop 意图（可带 regions）显式停止。',
  '同一通道一回合最多一个 beat；需要连续动作请拆到下一回合（重复 beat 会被合并，后一条生效并记 superseded 审计）。',
  '同一通道有多个 beat 时，loop 输出只能放在最后一拍；前面必须是固定时长输出。',
  '本端点工具调用不携带正文 content：给玩家看的完整正文必须写进 apply_plan 的 narration 字段（非空，篇幅遵循人设），不能只写在 reasoning 里，也不能只调用工具。',
  'narration 是玩家会看到的正文，不是计划摘要；环境/动作/身体反应用（）包裹，台词不加括号，不出现设备硬件词。',
  'narration 必须写清本回合 beats 实际作用的玩家部位（用这些名字）和动作，不能写没有下发动作的部位，也不能写成与部位无关的泛泛台词。',
  '正文只输出给玩家看的叙事；不要输出 <|...|>、DSML、工具调用语法、parameter/invoke 或任何特殊 token。',
  'strength 是粗档位：low/med/high = 玩家软区间的 25/50/80%（100% = 玩家设定的通道上限；具体数值不向模型暴露）；未提供 targetPercent/deltaPercent 时使用，波形动作的幅度也由它决定。',
  'targetPercent 是 0–100 的连续区间百分比（100 = 玩家设定的通道上限，0 = 停止）：需要具体强度时优先用它精确表达（可用任意值，按当前情境自行选择）；deltaPercent 只用于在当前位置微调。',
  '非 stop 动作的 durationSec 建议 30–60s，避免设备在下一回合开始前停掉；短促/瞬间动作用 ramp/pulse 且 duration 设短。',
  '玩家选项会作为下一回合用户消息（含选项文字和 tag）回传；必须据此改变动作与叙事，不要无视选项或复读上一回合。',
] as const

/** Additional protocol lines for turn 1: the opening must establish the scene. */
const OPENING_PROTOCOL = [
  '这是开场回合：narration 第一段先交代场景/背景（环境、玩家姿态、角色如何出现），再进入互动；不能只写一句空泛台词。',
] as const

/** Auto mode still offers the human choices; it never picks for them. */
const AUTOPILOT_PROTOCOL = [
  '当前会话处于自动运行：本回合必须给玩家 1–3 条 choices 供其随时接管（只有急停/收束等确实不适合选择的回合才可省略）。',
] as const

/**
 * A synthetic user turn for auto/checkpoint turns.
 *
 * DeepSeek's thinking mode rejects a request whose history ends with an
 * assistant message without `reasoning_content` (exactly the autopilot shape:
 * system + previous assistant line). A short system continuation keeps the
 * wire protocol valid and tells the model not to wait for input. It is not a
 * player message: it never reaches the transcript or the audit line.
 */
const AUTO_CONTINUE_MESSAGE = '（系统：自动运行继续。直接推进本回合，不要等待玩家输入。）'


/** Stable failure vocabulary for the HTTP layer (all map to 400). */
export type SessionErrorCode =
  | 'NO_SESSION'
  | 'SESSION_OPEN'
  | 'SESSION_ENDING'
  | 'SESSION_ENDED'
  | 'LOCKED'
  | 'INVALID_INPUT'
  | 'PACK_NOT_FOUND'
  | 'PACK_INVALID'

/**
 * A session request a caller can fix.
 *
 * The dashboard deliberately maps *these* to `400`: a missing session, a
 * second start, a locked runtime and bad input are conditions the caller can
 * see and act on. Programmer errors keep bubbling up as `500`.
 */
export class SessionError extends Error {
  readonly code: SessionErrorCode

  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

/** Narrow an unknown rejection to a {@link SessionError}. */
export function isSessionError(value: unknown): value is SessionError {
  return value instanceof SessionError
}

/**
 * Persistence seams for B2-T7 (session archive) and B2-T8 (ledger).
 *
 * The host owns the ports; `play.ts` only composes the two core modules around
 * one session. `memory` defaults to `state` when the host keeps both under one
 * document namespace (in-memory tests do that); production wiring passes
 * `<dataDir>/memory` so the marker lands at `memory/open.json`.
 *
 * `ledgerText` is the read side of the append-only ledger. `AppendOnlyStore`
 * has no read method by design, so the host supplies a closure over
 * `memory/ledger.jsonl`; without it the ledger remembers only sessions closed
 * by this very process.
 */
export interface PlayArchive {
  /** Session snapshots, `<dataDir>/state` (B2-T7). */
  readonly state: DocumentStore
  /** `memory/ledger.jsonl` (B2-T8). */
  readonly ledger: AppendOnlyStore
  /** Open/cut markers, `<dataDir>/memory`; defaults to `state`. */
  readonly memory?: DocumentStore
  /** Whole ledger text for `read()`; omit only in tests/short-lived hosts. */
  readonly ledgerText?: () => Promise<string | undefined>
}

/** Everything a session needs from the host; all injected, nothing global. */
export interface PlaySessionEnvironment {
  readonly clock: Clock
  readonly audit: AuditLog
  readonly registry: DeviceRegistry
  readonly policy: PolicyStore
  readonly waveforms: WaveformLibrary
  readonly sensors: SensorRegistry
  /**
   * Model gateway for the next turn.
   *
   * A function is resolved **at turn time**, so the settings view can rebuild
   * the runner (new provider/model/key) and have the next turn use it without
   * restarting the host. A bare `ModelRunner` keeps every pre-settings test
   * double and embedded host working unchanged.
   */
  readonly runner: ModelRunner | (() => ModelRunner)
  /** Persist `state/policy.json` after a human ceiling change (D4/A1-T10). */
  readonly savePolicy: () => Promise<void>
  /**
   * Archive + ledger seams. Absent = no persistence: the session behaves
   * exactly like B1-T16 and nothing is written. The Electron shell passes the
   * file-backed ports; unit tests pass the in-memory ones.
   */
  readonly archive?: PlayArchive
  /** Live line deltas for the play UI / transcript (B2-T11 consumes it later). */
  readonly onLine?: (delta: string) => void
  /** Engine observability, forwarded to the debug panel when present. */
  readonly onEvent?: (event: EngineEvent) => void
  /** Engine tuning; defaults match {@link TurnEngine}'s own defaults. */
  readonly engineConfig?: Partial<EngineConfig>
}

/** Human-facing autopilot request: enable flag plus an optional pacing window. */
export interface PlayAutopilotInput {
  readonly enabled: boolean
  /**
   * Fixed interval, kept for compatibility. When no window is given the engine
   * treats it as the fixed `[intervalSec, intervalSec]` window.
   */
  readonly intervalSec?: number
  /**
   * Pacing window: the engine picks each auto-turn delay inside it (an AI
   * suggestion may narrow it for one turn, otherwise it is random). Both
   * bounds are required together and clamped by the engine into its absolute
   * `autopilot.minSec`/`maxSec` bounds.
   */
  readonly windowMinSec?: number
  readonly windowMaxSec?: number
}

/** `start` input: the human's pack, time budget and optional ceiling. */
export interface PlayStartInput {
  readonly pack: LoadedPack
  readonly plannedMinutes: number
  /**
   * Human consent ceiling for this session, 0-100.
   *
   * Absent means "leave the stored ceiling alone" — a human restores it
   * explicitly, and a missing field is never an implicit raise.
   */
  readonly ceilingPercent?: number
  /** Human autopilot choice made in the lobby; applied after the opening turn. */
  readonly autopilot?: PlayAutopilotInput
}

/** What `GET /api/session` returns: the engine snapshot plus the pack identity. */
export interface PlaySnapshot extends EngineSnapshot {
  /** Package-declared hard boundaries; empty means "global boundaries apply". */
  readonly boundaries: readonly string[]
  /** Stable id of this session; also the ledger/archive key (B2-T7/T8). */
  readonly sessionId: string
  readonly packId: string
  readonly packVersion: string
}

/**
 * One resolved action summarized for the transcript's small effect box.
 *
 * The transcript is still the narrative line; this is the human-facing
 * "what did this turn target" row (part / actual percent / selected waveform).
 * It is derived from the executor's dispatch result, never from model JSON.
 */
export interface PlayTurnEffect {
  readonly deviceId: string
  readonly channelId: string
  readonly channelLabel?: string
  readonly region?: string
  readonly regionLabel?: string
  /**
   * The model's *requested* band percentage (0–100 before the soft range
   * mapping), when the executor reported it. The transcript shows
   * "requested → actual" so a narrow human cap is visible, not guessed.
   */
  readonly requestedPercent?: number
  /** The beat's strength bucket, when the executor reported it. */
  readonly strength?: 'low' | 'med' | 'high'
  /** Actual output percentage handed to the registry (already mapped/clamped). */
  readonly percent?: number
  readonly waveformId?: string
  readonly waveformName?: string
  readonly intentId?: string
  readonly status: string
  readonly reason?: string
}

/**
 * One settled line of the play transcript (`GET /api/session/transcript`).
 *
 * Derived from the same line record the writer's prompt uses — no separate
 * persistence, no player messages, no streamed deltas. `at` is injected-clock
 * epoch milliseconds, matching `TurnTrigger.at` and the audit `ts`; the UI
 * passes the newest `at` back as `?since=` and the host filters in memory.
 */
export interface PlayTranscriptEntry {
  readonly turnId: number
  readonly at: number
  readonly text: string
  /** Resolved effects for this turn, in dispatch order. */
  readonly effects: readonly PlayTurnEffect[]
}

/** One loaded pack, as seen by the session service. */
export interface PlayPackSource {
  load(packId: string): Promise<LoadedPack>
}

/** HTTP-shaped start request (the route resolves `packId`, not a pack object). */
export interface PlayHostStartRequest {
  readonly packId: string
  readonly plannedMinutes: number
  readonly ceilingPercent?: number
  readonly autopilot?: PlayAutopilotInput
}

/**
 * One playable session.
 *
 * Constructed empty; `start` attaches the pack and creates the engine. A
 * session never reopens: after `end` the snapshot stays readable and
 * `message` is rejected.
 */
export class PlaySession {
  private readonly env: PlaySessionEnvironment
  private readonly executor: PlanExecutor
  private engine: TurnEngine | undefined
  private pack: LoadedPack | undefined
  /**
   * Waveform ids the model may reference: packed assets (`builtin:x`,
   * `<packId>:x`, bare `x`) first, then the host library. Without this adapter
   * a plan that validated against the pack would still degrade to
   * `unknown-waveform` at dispatch time (wave-3 review Y-1).
   */
  private readonly waveformLookup: WaveformLookup = {
    get: id => this.pack?.resolveWaveform(id) ?? this.env.waveforms.get(id),
  }
  /** Passive probe recorder; absent until a session starts (A2-T1). */
  private probeRecorder: ReactionProbeRecorder | undefined
  /** Stable registrar handed to the executor before the recorder exists. */
  private readonly probeRegistrar: ProbeRegistrar = {
    register: action => this.probeRecorder?.register(action),
  }
  private scenario: ScenarioDefinition | undefined
  private phases: PhaseMachine | undefined
  private sessionId: string | undefined
  private plannedMinutes = 0
  /** Minimum aftercare hold from the scenario (0 = none declared). */
  private aftercareMin = 0
  private started = false
  /**
   * True from the first synchronous step of `start` until it settles.
   *
   * `start` awaits pack recovery and the opening turn, so `started` alone
   * cannot close the race: two callers in the same tick would both pass the
   * check and build two engines. The latch makes "at most one engine ever"
   * true for every interleaving; a failed start releases it for a retry.
   */
  private starting = false
  /** Settled assistant lines, newest last; the transcript and prompt memory. */
  private readonly recentEntries: PlayTranscriptEntry[] = []
  /** Full session transcript (the UI scrollback); `recentEntries` stays capped for prompts. */
  private readonly transcriptEntries: PlayTranscriptEntry[] = []
  /** B2-T7 archive; undefined when the host injected no `archive` seam. */
  private store: SessionStore | undefined
  /** B2-T8 ledger; undefined when the host injected no `archive` seam. */
  private ledger: SessionLedger | undefined
  /** Last snapshot written to {@link store}, so each turn patches the same base. */
  private archived: SessionState | undefined
  /** Exactly one ledger line per session, even if `end`/`panic` race. */
  private ledgerClosed = false
  /** Highest percent dispatched this session (ledger `maxCapUsed`, §4.7.2). */
  private maxCapUsed = 0
  /** Intent ids of the last two settled turns (`SessionState.recentBeats`). */
  private readonly turnBeats: string[][] = []
  /**
   * Pack waveform ids registered by this session's `start`.
   *
   * `dispose` removes exactly these from the session scratch: the human may
   * import or author waveforms on the device page, and a full `clearSession`
   * at a session boundary would silently delete them (review P1-4R). The host
   * shutdown still clears the whole scratch, which is where human scratch is
   * discarded by design.
   */
  private readonly packWaveformIds: string[] = []
  /**
   * Round-robin rotation seed handed to the resolver for the next turn.
   *
   * The resolver is a pure function that sees one cursor per turn, so every
   * round-robin beat in the *same* plan picks the same channel (per-turn, not
   * per-beat rotation — a documented limitation). Advancing the counter once
   * per settled turn is what makes successive turns hit different channels.
   * Process-local by design: a scheduling hint does not need persistence.
   */
  private roundRobinCursor = 0
  /**
   * The last *plan-resolved body* per `device:channel`: the continuation
   * source. A channel the next plan does not mention keeps doing exactly what
   * its last plan command did — including a loop waveform's own envelope and
   * texture — until an explicit stop.
   *
   * Recorded from the plan's final resolved commands (after the per-channel
   * merge) inside the model dispatch window, so human direct control and the
   * host's own holds can never become continuation candidates. `at` and
   * `durationSec` feed the one remaining gate: an effect that is still running
   * is not restarted. There is deliberately no TTL — "unmentioned channels
   * continue" is the product rule, and only a stop removes an entry.
   */
  private readonly lastBodies = new Map<string, {
    readonly body: ResolvedCommandBody
    readonly at: number
    readonly durationSec?: number
  }>()
  /**
   * Registry subscription: a `stop` event (per-channel or the `all` sentinel)
   * always drops the continuation state, and a level/pattern/waveform command
   * accepted *outside* the host's trusted windows (i.e. human direct control on
   * the device page) drops that channel's body so the next turn does not
   * overwrite what the human just did.
   */
  private unsubscribeDispatch: (() => void) | undefined
  /**
   * True while the host itself is issuing registry commands: the model plan's
   * dispatch (bodies are committed from the executor result, not from events)
   * and the continuity hold. Events seen outside this window are human direct
   * control and invalidate the stored body for their channel.
   */
  private dispatchWindowActive = false
  /**
   * Latest *model-requested* band percent per `device:channel` (0–100 before
   * the soft-range mapping). The UI shows this instead of the mapped output:
   * the player asked for "what the model chose", not the hidden cap math.
   * Written only when a plan command is committed, deleted by an explicit
   * stop/percent-0 command, a stop event or human direct control; an
   * unmentioned channel keeps its value (continuation).
   */
  private readonly lastRequested = new Map<string, number>()
  /** `metaReactions` opening brief, consumed by the opening turn only. */
  private openingBrief: OpeningBrief | undefined
  /**
   * The exact choice the human picked, consumed by the next turn's prompt.
   *
   * `TurnRequest` only carries the choice id; without the label/tag the model
   * receives `（选择：c1）` and cannot know what the player meant. The host
   * resolves the label from the engine's offered menu before submitting.
   */
  private pendingChoice: PlayerChoice | undefined

  constructor(env: PlaySessionEnvironment) {
    this.env = env
    // The executor is the only dispatch path, and it enforces the registry's
    // safety contract (locked ⇒ blocked, no direct backend access).
    this.executor = new PlanExecutor({
      registry: env.registry,
      audit: env.audit,
      waveforms: this.waveformLookup,
      probes: this.probeRegistrar,
      clock: env.clock,
    })
  }

  /** True once `start` succeeded (even after `end`). */
  get open(): boolean {
    return this.started
  }

  /** The engine's current state, for diagnostics/tests; undefined before start. */
  get state(): string | undefined {
    return this.engine?.state
  }

  /**
   * Open the session and run its opening turn.
   *
   * Resolves after that first turn has settled, with the engine snapshot — the
   * acceptance test's "answers the first turn". The ceiling write (and its
   * audit/persist) happens before the model is called, so a turn can never
   * observe a widened ceiling.
   *
   * The `starting` latch is held across the pack-recovery awaits, so a second
   * start in the same tick sees an open session instead of building a second
   * engine (B-5). A rejection releases the latch: a caller may retry.
   */
  async start(input: PlayStartInput): Promise<PlaySnapshot> {
    if (this.started || this.starting) {
      throw new SessionError('SESSION_OPEN', 'a session is already open in this process')
    }
    this.starting = true
    try {
      return await this.openSession(input)
    } finally {
      this.starting = false
    }
  }

  /** Body of {@link start}; the latch is held by the caller. */
  private async openSession(input: PlayStartInput): Promise<PlaySnapshot> {
    const plannedMinutes = normalizePlannedMinutes(input.plannedMinutes)
    const autopilot = normalizeAutopilot(input.autopilot)
    if (this.env.registry.isLocked) {
      throw new SessionError('LOCKED', 'the device registry is locked; unlock it before starting a session')
    }
    const ceilingPercent = input.ceilingPercent
    if (ceilingPercent !== undefined) {
      assertCeiling(ceilingPercent)
      if (this.env.registry.isLocked) {
        throw new SessionError('LOCKED', 'the device registry is locked; unlock it before changing the ceiling')
      }
      const change = this.env.policy.setSessionCeilingByHuman(ceilingPercent)
      await this.env.audit.record({
        actor: 'human',
        action: 'policy_change',
        result: 'ok',
        detail: { scope: 'session', previous: change.previous, next: change.next },
      })
      await this.env.savePolicy()
    }

    const scenario = scenarioFor(input.pack, plannedMinutes)
    // B2-T5's aftercare runtime: only an explicit author opt-in makes `end()`
    // hold in `ending` for the wind-down. The freeform default (5 min) is a
    // content default, not a host stall every caller has to clock past.
    // Only a `scenario` pack has a real aftercare phase to hold for; a freeform
    // pack keeps the documented content default without stalling its end().
    const aftercareMin = input.pack.manifest.mode === 'scenario'
      ? scenario.session?.aftercareMin ?? 0
      : 0
    // Every new session starts at the pack's first declared phase. A recovered
    // snapshot (crashed/unfinished session) deliberately does NOT restore its
    // phase: unfinished-session handling is a content-pack concern, so the host
    // keeps the snapshot/ledger facts but starts the new session clean.
    const initialPhase = scenario.phases[0]?.id ?? 'scene'

    // ── B2-T7/T8: recover the previous session, then open this one ───────
    // Recovery happens before the new snapshot is written: a still-active
    // snapshot from an earlier process is relabelled `recovered`, and a stale
    // ledger marker becomes exactly one `unexpected_exit` line. Neither path
    // replays the unfinished turn (its effects may already be on hardware).
    const sessionId = randomUUID()
    const archive = this.env.archive
    let store: SessionStore | undefined
    let ledger: SessionLedger | undefined
    let archived: SessionState | undefined
    let openingBrief: OpeningBrief | undefined
    if (archive !== undefined) {
      store = new SessionStore({ documents: archive.state, clock: this.env.clock })
      const recovered = await store.recover()
      ledger = new SessionLedger({
        store: archive.ledger,
        documents: archive.memory ?? archive.state,
        clock: this.env.clock,
        ...(archive.ledgerText === undefined ? {} : { reader: archive.ledgerText }),
        // The ledger dates a crash from the last settled snapshot (§4.7.2);
        // `elapsedMin` is the only time fact the archive stores, so this is
        // the snapshot time rounded down to the minute.
        ...(recovered === undefined
          ? {}
          : {
              snapshot: async (): Promise<{ at: number; phase: string } | undefined> => ({
                at: Date.parse(recovered.startedAt) + recovered.elapsedMin * 60_000,
                phase: recovered.currentPhase,
              }),
            }),
      })
      await ledger.recover()
      openingBrief = matchMetaReactions(
        input.pack.manifest,
        await ledger.read(),
        this.env.clock.now(),
      )
      archived = await store.open({
        sessionId,
        packId: input.pack.manifest.id,
        phase: initialPhase,
      })
      await ledger.open(sessionId, { pack: input.pack.manifest.id, plannedMin: plannedMinutes })
    }

    const phases = new PhaseMachine(scenario.phases, initialPhase)

    const engine = new TurnEngine({
      clock: this.env.clock,
      audit: this.env.audit,
      runner: this.runnerFor(),
      plannedMinutes,
      phase: () => phases.current,
      onSettle: async (snapshot): Promise<void> => {
        // Every settled turn refreshes the archive (B2-T7). The engine has
        // already left `locked`/terminal states alone, so no snapshot is
        // written for a panicked or ended session.
        await this.persistSnapshot(snapshot)
      },
      onPause: async (): Promise<void> => {
        // Pause is B2-T11's surface, but the safety hook lands here already:
        // entering `paused` must never leave a device running.
        await this.env.registry.stop('system')
      },
      onPanic: async (source: string): Promise<void> => {
        await this.env.registry.emergencyStop(source)
      },
      onEnd: async (): Promise<void> => {
        await this.env.registry.stop('system')
      },
      ...(this.env.onEvent === undefined ? {} : { onEvent: this.env.onEvent }),
      config: {
        ...(this.env.engineConfig ?? {}),
        ...(aftercareMin > 0 ? { aftercareMin } : {}),
      },
    })
    this.pack = input.pack
    // Pack waveforms live under `<packId>:<localId>` and the executor's lookup
    // learns them through `pack.resolveWaveform`; the registry's own
    // `WaveformLibrary` is what `runPattern` actually requires, and it knows
    // nothing about the pack. Registering the pack assets in the session
    // scratch is what stops every packed waveform from being rejected with
    // `UNKNOWN_WAVEFORM` (the audit's turn 1/2/4).
    //
    // Deliberately *no* `clearSession()` here: the human may have imported or
    // authored waveforms on the device page before 开局 (a human-only path that
    // lands in the same scratch), and start must not throw them away. Only the
    // end of the session removes what this start added (`dispose`), and host
    // shutdown clears the whole scratch. Re-registering a pack's ids is
    // overwrite-by-id, so a retried start cannot duplicate anything.
    for (const waveform of input.pack.waveforms) {
      this.env.waveforms.addSessionWaveform(waveform)
      // Remembered per id so `dispose` removes exactly the pack assets this
      // session owns — never a human import that shares the scratch map.
      if (!this.packWaveformIds.includes(waveform.id)) this.packWaveformIds.push(waveform.id)
    }
    this.scenario = scenario
    this.phases = phases
    this.store = store
    this.ledger = ledger
    this.archived = archived
    this.openingBrief = openingBrief
    this.turnBeats.length = 0
    this.roundRobinCursor = 0
    this.maxCapUsed = 0
    this.ledgerClosed = false
    this.engine = engine
    this.plannedMinutes = plannedMinutes
    this.aftercareMin = aftercareMin
    this.sessionId = sessionId
    this.started = true
    // Passive probes only exist while a session does; the recorder settles on
    // the injected clock and writes one reaction_probe line per action.
    this.probeRecorder?.dispose()
    this.probeRecorder = new ReactionProbeRecorder({
      clock: this.env.clock,
      sensors: this.env.sensors,
      audit: this.env.audit,
    })
    // The continuity hold observes accepted dispatch events for the lifetime of
    // the session (subscribed before the opening turn, released in `dispose`).
    this.subscribeDispatch()

    await this.env.audit.record({
      actor: 'human',
      action: 'session_start',
      result: 'ok',
      detail: {
        sessionId: this.sessionId,
        packId: input.pack.manifest.id,
        mode: input.pack.manifest.mode,
        plannedMinutes,
        ceilingPercent: this.env.policy.ceiling(),
      },
    })

    // Apply the lobby's autopilot choice before the opening turn: the prompt
    // builder reads `engine.autopilotEnabled` to suppress player choices in
    // auto mode, and the opening turn is the first place that matters. A tick
    // that fires while the opening turn runs is dropped by the engine.
    if (autopilot !== undefined) {
      // A pacing window wins; a bare interval is the legacy fixed-window form
      // (`setAutopilotInterval` collapses the window to `[x, x]`).
      if (autopilot.windowMinSec !== undefined && autopilot.windowMaxSec !== undefined) {
        engine.setAutopilotRange(autopilot.windowMinSec, autopilot.windowMaxSec)
      } else if (autopilot.intervalSec !== undefined) {
        engine.setAutopilotInterval(autopilot.intervalSec)
      }
      engine.setAutopilot(autopilot.enabled)
    }
    // The scheduler's P2 vocabulary has no `opening` kind (B2-T4 owns it);
    // `resume` is the session-level "begin/continue" trigger and starts
    // immediately because the engine is idle.
    engine.startSession()
    engine.submit({ priority: 'session', kind: OPENING_TRIGGER_KIND, at: this.env.clock.now() })
    await engine.whenIdle()
    return this.requireSnapshot()
  }

  /**
   * Send a player line (P1: always preempts).
   *
   * Rejects when there is no session, after `end`, while the session is
   * ending, or while the runtime is locked — the engine would silently ignore
   * the last two cases, which an HTTP caller must not read as success (S-5).
   */
  async message(text: string): Promise<PlaySnapshot> {
    const engine = this.engine
    if (engine === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    if (engine.state === 'ending') {
      throw new SessionError('SESSION_ENDING', 'the session is ending; no new turn can start')
    }
    if (engine.state === 'ended') throw new SessionError('SESSION_ENDED', 'the session has ended')
    if (text.trim() === '') throw new SessionError('INVALID_INPUT', 'message text is required')
    if (engine.state === 'locked' || this.env.registry.isLocked) {
      await this.env.audit.record({
        actor: 'human',
        action: 'preempted',
        result: 'rejected',
        reason: 'locked',
      })
      throw new SessionError('LOCKED', 'the session is locked; unlock before sending a message')
    }
    await engine.submitPlayerMessage(text)
    return this.requireSnapshot()
  }

  /**
   * Pause the session (B2-T11 / §5).
   *
   * The engine queues the pause behind the in-flight turn, then enters
   * `paused`, runs the host's full-stop hook (`registry.stop`) and audits
   * `session_paused`. Effects are **not** replayed on resume; the next turn
   * re-issues whatever is still wanted from the state it sees then.
   */
  async pause(): Promise<PlaySnapshot> {
    const engine = this.liveEngine()
    await engine.pause()
    return this.requireSnapshot()
  }

  /** Resume from `paused`; no effect is re-issued (B2-T11 / §5). */
  async resume(): Promise<PlaySnapshot> {
    const engine = this.liveEngine()
    await engine.resume()
    return this.requireSnapshot()
  }

  /**
   * Human autopilot change while playing: toggle and/or set the pacing window.
   *
   * A window (`windowMinSec`/`windowMaxSec`) lets the engine pick each delay in
   * the range (an AI suggestion may narrow it for one turn, otherwise random);
   * a legacy `intervalSec` behaves as the fixed `[x, x]` window. The engine
   * clamps both into its absolute bounds and the next snapshot carries the
   * adopted values so the UI can re-render its controls.
   */
  setAutopilot(input: PlayAutopilotInput): PlaySnapshot {
    const engine = this.liveEngine()
    const next = normalizeAutopilot(input)
    if (next === undefined) throw new SessionError('INVALID_INPUT', 'autopilot input is required')
    if (next.windowMinSec !== undefined && next.windowMaxSec !== undefined) {
      engine.setAutopilotRange(next.windowMinSec, next.windowMaxSec)
    } else if (next.intervalSec !== undefined) {
      engine.setAutopilotInterval(next.intervalSec)
    }
    engine.setAutopilot(next.enabled)
    return this.requireSnapshot()
  }

  /**
   * Pick one of the currently offered options (P1: opens a new turn).
   *
   * The engine itself tolerates a missing menu (a stray id would become a
   * phantom player message), so the host validates first: an empty id, a
   * missing menu and an id that was never offered are all caller errors
   * (`INVALID_INPUT`, HTTP 400), not silent 200s.
   */
  async submitChoice(choiceId: string): Promise<PlaySnapshot> {
    const engine = this.liveEngine()
    const id = choiceId.trim()
    if (id === '') throw new SessionError('INVALID_INPUT', 'choiceId is required')
    const offered = engine.snapshot().choices ?? []
    if (offered.length === 0) {
      throw new SessionError('INVALID_INPUT', 'no choice menu is open')
    }
    const selected = offered.find(choice => choice.id === id)
    if (selected === undefined) {
      throw new SessionError('INVALID_INPUT', `choice "${id}" was not offered in this turn`)
    }
    this.pendingChoice = selected
    try {
      await engine.submitChoice(id)
    } catch (error) {
      this.pendingChoice = undefined
      throw error
    }
    return this.requireSnapshot()
  }

  /**
   * Settled assistant lines, newest last (B2-T11).
   *
   * Served from the same in-memory entries the writer's prompt is built from;
   * no extra persistence. Before `start` it is empty, and after `end` the last
   * lines remain readable for the UI.
   */
  transcript(): readonly PlayTranscriptEntry[] {
    return [...this.transcriptEntries]
  }

  /**
   * Recent ledger lines, newest last (B2-T11).
   *
   * Without an injected archive there is nothing to read and the answer is an
   * empty list; `limit` bounds the tail for the UI. The ledger is append-only,
   * so this is a read of the archive seam, never a mutation.
   */
  async ledgerEntries(limit?: number): Promise<readonly LedgerEntry[]> {
    const ledger = this.ledger
    if (ledger === undefined) return []
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new SessionError('INVALID_INPUT', 'limit must be a positive integer')
    }
    return await ledger.read(limit === undefined ? {} : { lastN: limit })
  }

  /** End the session and stop every effect (idempotent once ended). */
  async end(reason: EndReason): Promise<PlaySnapshot> {
    const engine = this.engine
    if (engine === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    await engine.end(reason)
    // The engine may refuse (already ended, or stopped in `locked`); the
    // archive/ledger guard is what makes this idempotent end-to-end.
    await this.settleArchive(reason)
    this.probeRecorder?.dispose()
    this.probeRecorder = undefined
    return this.requireSnapshot()
  }

  /**
   * Move the session ceiling as a human (B2-T9 / D4).
   *
   * The store write is human-only; the hardware ceiling has to follow it, so
   * every connected device re-asserts its bounds (`Coyote BF`). No engine or
   * content-pack path reaches this method.
   */
  async setSessionCeiling(percent: number): Promise<PlaySnapshot> {
    if (this.env.registry.isLocked) {
      throw new SessionError('LOCKED', 'the device registry is locked; unlock it before changing the ceiling')
    }
    assertCeiling(percent)
    const change = this.env.policy.setSessionCeilingByHuman(percent)
    await this.env.audit.record({
      actor: 'human',
      action: 'policy_change',
      result: 'ok',
      detail: { scope: 'session', previous: change.previous, next: change.next },
    })
    await this.env.savePolicy()
    // Rule 4 of the D4 decision: the hardware ceiling must not outlive a
    // narrowed session ceiling.
    await this.env.registry.reapplyBounds()
    return this.requireSnapshot()
  }

  /** Move one channel's narrative region; the next plan sees it (B2-T10). */
  async setRegion(deviceId: string, channelId: string, region: string | undefined): Promise<PlaySnapshot> {
    await this.env.registry.setRegionByHuman(deviceId, channelId, region)
    return this.requireSnapshot()
  }

  /** Region labels in force, keyed `device:channel`. */
  regions(): Readonly<Record<string, string>> {
    const labels: Record<string, string> = {}
    for (const device of this.env.registry.snapshot().devices) {
      for (const channel of device.channels) {
        if (channel.region !== undefined) labels[`${device.id}:${channel.id}`] = channel.region
      }
    }
    return labels
  }

  /** Recent settled probes for the debug panel; empty without a session. */
  probes(): readonly ProbeRecord[] {
    return this.probeRecorder?.recent(20) ?? []
  }

  /**
   * Latest model-requested band percent per `device:channel` (0–100).
   *
   * The UI shows *this* instead of the mapped output so a narrow human cap is
   * not mistaken for a weak model request. Values survive until an explicit
   * stop, a stop event/pause/panic/end, or human direct control on the channel.
   */
  requestedPercents(): Readonly<Record<string, number>> {
    const percents: Record<string, number> = {}
    for (const [key, value] of this.lastRequested) {
      const [deviceId, channelId] = key.split('\u0000')
      if (deviceId === undefined || channelId === undefined) continue
      percents[`${deviceId}:${channelId}`] = value
    }
    return percents
  }

  /** The current engine snapshot plus the pack identity, or undefined. */
  snapshot(): PlaySnapshot | undefined {
    const engine = this.engine
    const pack = this.pack
    const sessionId = this.sessionId
    if (engine === undefined || pack === undefined || sessionId === undefined) return undefined
    return {
      ...engine.snapshot(),
      boundaries: pack.manifest.boundaries ?? [],
      sessionId,
      packId: pack.manifest.id,
      packVersion: pack.manifest.version,
    }
  }

  /** P0: out-of-band stop. Locks the engine and cuts the devices. */
  async panic(source: string): Promise<void> {
    const engine = this.engine
    if (engine !== undefined && engine.state !== 'ended') {
      await engine.panic(source)
      // A panic is a session end as far as cross-session memory goes (§1).
      await this.settleArchive('panic')
      this.probeRecorder?.dispose()
      this.probeRecorder = undefined
      return
    }
    // No engine yet (or a finished session): the registry is still the stop.
    await this.env.registry.emergencyStop(source)
  }

  /** Human unlock; the only way out of the LOCKED latch. */
  unlock(note?: string): void {
    this.engine?.unlock(note)
  }

  /**
   * Cancel timers/queued turns; safe to call at host shutdown.
   *
   * Deliberately leaves the archive and the open marker in place: quitting
   * mid-session must become `unexpected_exit` on the next start (§4.7.2).
   * A paused exit is B2-T11's explicit call, not shutdown's.
   */
  dispose(): void {
    this.engine?.dispose()
    // Stop observing dispatch events: the continuation state belongs to this
    // session.
    this.unsubscribeDispatch?.()
    this.unsubscribeDispatch = undefined
    this.lastBodies.clear()
    this.lastRequested.clear()
    // Remove only the pack waveforms this session registered. The same scratch
    // map holds human imports/authors from the device page, and a session
    // boundary must not delete those (review P1-4R: this was the cleanup
    // regression a full `clearSession` caused). The remaining scratch is
    // discarded at host shutdown, which is the human-scratch end of life.
    for (const id of this.packWaveformIds) this.env.waveforms.removeSessionWaveform(id)
    this.packWaveformIds.length = 0
  }

  private requireSnapshot(): PlaySnapshot {
    const snapshot = this.snapshot()
    if (snapshot === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return snapshot
  }

  /**
   * The engine for a control request that must not be silently ignored.
   *
   * `TurnEngine.pause()`/`resume()`/`submitChoice()` are host-facing no-ops in
   * `ending`/`ended`/`locked`; an HTTP caller needs the typed refusal instead
   * of a 200 with an unchanged snapshot.
   */
  private liveEngine(): TurnEngine {
    const engine = this.engine
    if (engine === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    if (engine.state === 'ending') {
      throw new SessionError('SESSION_ENDING', 'the session is ending; wait for it to settle')
    }
    if (engine.state === 'ended') throw new SessionError('SESSION_ENDED', 'the session has ended')
    if (engine.state === 'locked' || this.env.registry.isLocked) {
      throw new SessionError('LOCKED', 'the session is locked; unlock before continuing')
    }
    return engine
  }

  /** The adapter that makes `runTurn` satisfy the engine's {@link TurnRunner}. */
  private runnerFor(): TurnRunner {
    return { run: async (request: TurnRequest): Promise<TurnRunnerResult> => this.runOneTurn(request) }
  }

  /**
   * The model runner in force for this turn.
   *
   * A provider is read here rather than at session start: the settings view
   * swaps the runner after a model change, and the *next* turn must use it.
   */
  private modelRunnerFor(): ModelRunner {
    const source = this.env.runner
    return typeof source === 'function' ? source() : source
  }

  /**
   * One single-call turn.
   *
   * Stage forwarding is guarded by the engine's own state so a stream that
   * emits text before its `apply_plan` call cannot ask for an illegal
   * `writing -> executing` transition. Dispatch is still immediate: the loop
   * calls it from the tool-call callback, before the text stream ends.
   */
  private async runOneTurn(request: TurnRequest): Promise<TurnRunnerResult> {
    const scenario = this.scenario
    const phases = this.phases
    const pack = this.pack
    if (scenario === undefined || phases === undefined || pack === undefined) {
      throw new SessionError('NO_SESSION', 'no session is open')
    }

    const executor: TurnExecutor = {
      dispatch: async (plan, ctx, diagnostics, options) => {
        if (this.engine?.state === 'planning') request.onStage?.('executing')
        // Resolve first, commit only after the executor says what actually ran:
        // a blocked/LOCKED plan, a preempted tail or a rejected command must
        // never become the next turn's continuation state. The fourth argument
        // carries the turn's abort signal, so preempt/timeout can drop the
        // remaining beats instead of driving a cancelled plan.
        const resolved = resolvePlan(plan, ctx)
        this.dispatchWindowActive = true
        try {
          const result = await this.executor.dispatch(plan, ctx, diagnostics, options)
          this.commitResolvedBodies(resolved, result)
          return result
        } finally {
          this.dispatchWindowActive = false
        }
      },
    }

    // Bridge the model's thinking time before the snapshot/prompt is frozen:
    // re-assert the last accepted output so a finished effect does not leave
    // the hardware silent while the next plan is generated. The new plan (if
    // any) overwrites it; a failure here never blocks the turn.
    await this.holdContinuity()

    let wrote = false
    // Freeze the registry facts once per turn: the prompt's device/region
    // projection and the resolver must see the same snapshot, or the model
    // could be told a region is ready and be resolved against one that is not.
    const snapshot = this.env.registry.snapshot()
    // The menu the model is offered and the parts the resolver can reach are
    // the same list: a pack recommendation without a ready channel behind it
    // would only produce a fallback everywhere (the audit's "导演只在写作文本").
    const playableRegions = targetableRegions(scenario, snapshot).map(region => region.id)
    const resolveContext = resolveContextOf(
      snapshot,
      scenario,
      this.waveformLookup,
      regionAliasesOf(scenario, snapshot),
      // Per-turn rotation seed: same-plan round-robin beats share it, the next
      // turn gets the advanced value (see `advanceRoundRobinCursor`).
      this.roundRobinCursor,
      // Content-pack default waveform: the resolver falls back to it when the
      // model references a waveform that does not exist (core's default-wave
      // fallback, `内容包规范.md` §4.5), instead of dropping to a plain pattern.
      pack.waveforms[0]?.id,
      // Loop textures keep playing on their own until the next plan/stop
      // replaces them (clamped by the channel's own `maxDurationSec`), so the
      // thinking window does not need a continuity hold for them.
      SUSTAIN_LOOP_SEC,
    )
    // Build the prompt (the opening brief, when present, is part of it), then
    // consume the brief: it belongs to the opening turn only, even if that
    // request ends in a fallback.
    const opening = request.turnId === 1
      && request.playerText === undefined
      && request.choiceId === undefined
    const choice = this.pendingChoice
    this.pendingChoice = undefined
    const messages = this.messagesFor(request, phases, pack, snapshot, opening, choice)
    this.openingBrief = undefined
    const result = await runTurn({
      runner: this.modelRunnerFor(),
      // The pack's intent menu and the reachable region vocabulary are the only
      // legal values for `apply_plan`; injecting them keeps the static tool
      // schema free of content while stopping the model from inventing ids
      // (§4.9.2).
      tools: withPlayableEnums(
        M2_MODEL_TOOLS,
        [...resolveContext.intents.keys()],
        playableRegions,
        pack.waveforms.map(waveform => waveform.id),
        phases.allowedNext,
      ),
      executor,
      input: {
        turnId: request.turnId,
        phase: phases.current,
        messages,
        resolveContext,
      },
      clock: this.env.clock,
      signal: request.signal,
      ...(this.env.engineConfig?.turnTimeoutMs === undefined
        ? {}
        : { timeoutMs: this.env.engineConfig.turnTimeoutMs }),
      onTextDelta: delta => {
        if (!wrote && (this.engine?.state === 'planning' || this.engine?.state === 'executing')) {
          request.onStage?.('writing')
        }
        wrote = true
        this.env.onLine?.(delta)
      },
    })

    // Phase advancement is a model request validated by the engine: only an
    // edge declared by the pack may be taken. Advancing before this turn
    // settles makes both the persisted snapshot and the next prompt see the
    // new phase.
    await this.applyPhaseAdvance(phases, result.plan?.advanceTo)

    // A plan can drive hardware with no prose at all: tool-call providers may
    // put the whole reply in `apply_plan` and omit both `content` and
    // `narration`. Per §3 of 导演与写作上下文契约.md a failed write settles with
    // the template line while the actions still run, so a turn that planned or
    // dispatched still owns a transcript entry — otherwise the player loses the
    // effect box exactly when the devices were touched.
    const dispatched = (result.dispatch?.actions ?? [])
      .some(action => action.status !== 'rejected')
    const needsPlaceholder = result.plan !== undefined || dispatched
    const line = result.line.trim() !== ''
      ? result.line
      : needsPlaceholder
        ? WRITER_TEMPLATE_LINE
        : ''
    if (line !== '') {
      // One entry serves both the writer's recent memory and the transcript:
      // no second write path, and `at` is the injected-clock settlement time.
      // The placeholder is only a line, never an audit record or a plan value.
      this.recentEntries.push({
        turnId: request.turnId,
        at: this.env.clock.now(),
        text: line,
        effects: this.effectSummary(result),
      })
      this.transcriptEntries.push({ ...this.recentEntries[this.recentEntries.length - 1]! })
      if (this.recentEntries.length > RECENT_LINE_LIMIT) this.recentEntries.shift()
    }
    // Ledger/archive facts for this turn: dispatched percentages (B2-T8
    // `maxCapUsed`, never a cap) and the intent ids of the last two turns.
    this.recordTurnFacts(result)
    this.advanceRoundRobinCursor(result)
    const choices = result.plan?.choices
    // The director may suggest the next auto-turn delay inside the pacing
    // window; the engine clamps it and falls back to its own random pick.
    const nextTurnAfterSec = result.plan?.nextTurnAfterSec
    return {
      line,
      ...(choices === undefined ? {} : { choices }),
      ...(nextTurnAfterSec === undefined ? {} : { nextTurnAfterSec }),
    }
  }

  /**
   * Apply a model-requested phase transition.
   *
   * The phase graph is the engine's authority: only a declared edge is taken.
   * A refused request leaves the phase untouched and is audited so a bad
   * model proposal is visible without failing the turn.
   */
  private async applyPhaseAdvance(phases: PhaseMachine, requested: string | undefined): Promise<void> {
    if (requested === undefined) return
    const from = phases.current
    if (!phases.allowedNext.includes(requested)) {
      await this.env.audit.record({
        actor: 'model',
        action: 'phase_advance',
        result: 'rejected',
        reason: 'requested phase is not an allowed next phase',
        detail: { from, requested, allowed: [...phases.allowedNext] },
      })
      return
    }
    phases.advanceTo(requested)
    await this.env.audit.record({
      actor: 'model',
      action: 'phase_advance',
      result: 'ok',
      detail: { from, to: requested },
    })
  }

  /** Persist the snapshot that `TurnEngine.onSettle` hands us (B2-T7). */
  private async persistSnapshot(engine: EngineSnapshot): Promise<void> {    const store = this.store
    const base = this.archived
    if (store === undefined || base === undefined) return
    const next: SessionState = {
      ...base,
      currentPhase: engine.phase,
      turn: engine.turnId,
      elapsedMin: engine.elapsedMin,
      ...(engine.lastLine === undefined ? {} : { lastLine: engine.lastLine }),
      recentBeats: this.recentBeats(),
      status: 'active',
    }
    this.archived = next
    await store.save(next)
  }

  /**
   * Final snapshot + exactly one ledger line.
   *
   * `aftercare` reports whether the scenario's minimum wind-down actually ran:
   * `end()` waits for it inside the engine, so reaching this point with a
   * completed session means it did.
   */
  private async settleArchive(reason: SessionEndReason): Promise<void> {
    if (this.ledgerClosed) return
    this.ledgerClosed = true
    const store = this.store
    const ledger = this.ledger
    const base = this.archived
    const pack = this.pack
    if (store === undefined || ledger === undefined || base === undefined || pack === undefined) return
    const engine = this.engine
    const engineSnapshot = engine?.snapshot()
    const finalState: SessionState = {
      ...base,
      ...(engineSnapshot === undefined
        ? {}
        : {
            currentPhase: engineSnapshot.phase,
            turn: engineSnapshot.turnId,
            elapsedMin: engineSnapshot.elapsedMin,
            ...(engineSnapshot.lastLine === undefined ? {} : { lastLine: engineSnapshot.lastLine }),
          }),
      recentBeats: this.recentBeats(),
      status: 'ended',
    }
    this.archived = finalState
    await store.save(finalState)
    const entry: LedgerEntry = {
      sessionId: finalState.sessionId,
      pack: pack.manifest.id,
      startedAt: finalState.startedAt,
      endedAt: new Date(this.env.clock.now()).toISOString(),
      endReason: reason,
      plannedMin: this.plannedMinutes,
      actualMin: finalState.elapsedMin,
      phaseReached: finalState.currentPhase,
      aftercare: this.aftercareMin > 0 && reason === 'completed',
      maxCapUsed: this.maxCapUsed,
    }
    await ledger.close(entry)
  }

  /** Intent ids of the last two settled turns, in settlement order. */
  private recentBeats(): string[] {
    return this.turnBeats.flat()
  }

  /** Capture the per-turn ledger/archive facts from one model turn. */
  private recordTurnFacts(result: TurnResult): void {
    for (const action of result.dispatch?.actions ?? []) {
      if (action.percent === undefined) continue
      this.maxCapUsed = Math.max(this.maxCapUsed, action.percent)
    }
    const intents = result.plan?.beats.map(beat => beat.intentId) ?? []
    if (intents.length === 0) return
    this.turnBeats.push([...new Set(intents)])
    if (this.turnBeats.length > 2) this.turnBeats.shift()
  }

  /**
   * Advance the session's round-robin rotation seed after one settled turn.
   *
   * At most one step per turn (review P2-R1): several round-robin beats in the
   * same plan share the turn's cursor (the resolver is a pure function), so
   * advancing per beat made an even-sized pool repeat the same channel forever
   * (cursor 0→2→4 ≡ 0 mod 2). Only a *real* dispatch consumes a rotation slot:
   * a turn with no plan, a rejected/narrative-only round-robin beat or a
   * non-round-robin plan leaves the cursor alone, so the next round-robin turn
   * still alternates instead of skipping a channel or replaying the previous
   * one.
   */
  private advanceRoundRobinCursor(result: TurnResult): void {
    const plan = result.plan
    if (plan === undefined) return
    const roundRobinIntents = new Set(
      (this.scenario?.feedbackIntents ?? [])
        .filter(intent => intent.distribution === 'round-robin')
        .map(intent => intent.id),
    )
    const dispatchedBeats = new Set(
      (result.dispatch?.actions ?? [])
        .filter(action => action.status !== 'rejected')
        .map(action => action.beatId),
    )
    const rotated = plan.beats.some(beat =>
      roundRobinIntents.has(beat.intentId) && dispatchedBeats.has(beat.id))
    if (rotated) this.roundRobinCursor += 1
  }

  /**
   * Subscribe to registry dispatch events for the session's lifetime.
   *
   * Stop events drop both continuation state and requested percentages so
   * pause/panic/end and human stops are never revived. Events accepted outside
   * the host's trusted windows are human direct control and invalidate the
   * channel's stored request/body too.
   */
  private subscribeDispatch(): void {
    this.unsubscribeDispatch?.()
    this.lastBodies.clear()
    this.lastRequested.clear()
    this.unsubscribeDispatch = this.env.registry.subscribe(event => this.noteDispatch(event))
  }

  /**
   * Drop continuation/request state on a stop; invalidate on human control.
   *
   * Any `stop` (per-channel or the `all` sentinel) clears unconditionally —
   * pause/panic/end and human stops must never be revived. A level/pattern/
   * waveform command accepted outside the host's trusted dispatch window is a
   * human device-page action: it becomes the channel's truth, so the stored
   * plan body and requested percent are dropped and the next turn will not
   * overwrite or mislabel it.
   */
  private noteDispatch(event: DispatchEvent): void {
    if (event.kind === 'stop') {
      if (event.deviceId === 'all' || event.channelId === 'all') {
        this.lastBodies.clear()
        this.lastRequested.clear()
      } else {
        const key = dispatchKey(event.deviceId, event.channelId)
        this.lastBodies.delete(key)
        this.lastRequested.delete(key)
      }
      return
    }
    if (this.dispatchWindowActive) return
    if (event.deviceId === 'all' || event.channelId === 'all') return
    const key = dispatchKey(event.deviceId, event.channelId)
    this.lastBodies.delete(key)
    this.lastRequested.delete(key)
  }

  /**
   * Commit the plan's final bodies *after* the executor reports what it ran.
   *
   * Transactional by design (review ui-v13 P1-1): the body map is only touched
   * once the dispatch result is consistent with the resolved command list.
   * A blocked/LOCKED plan (`result.blocked`), a preempted/aborted tail (fewer
   * actions than commands) or any index/identity mismatch leaves the previous
   * continuation state untouched — the next turn must continue what really ran,
   * never a command the safety runtime refused or never attempted.
   *
   * Rejected commands only skip their own channel; a final stop / `percent 0`
   * deletes the channel, everything else stores the original body so a loop
   * pattern's envelope/texture survives the next turn. The model's requested
   * band percent (`action.request.requestedPercent`) is committed alongside:
   * it is what the UI shows ("区间 50%"), independent of the mapped output.
   */
  private commitResolvedBodies(resolved: ResolvedPlan, result: DispatchResult): void {
    if (result.blocked) return
    if (result.actions.length !== resolved.commands.length) return
    // Guard against index drift: executor order is command order, but trust the
    // action identity only when it matches the resolved command.
    for (const [index, action] of result.actions.entries()) {
      const command = resolved.commands[index]
      if (command === undefined
        || action.beatId !== command.beatId
        || action.deviceId !== command.deviceId
        || action.channelId !== command.channelId) {
        return
      }
    }
    const at = this.env.clock.now()
    for (const [index, action] of result.actions.entries()) {
      if (action.status === 'rejected') continue
      const body = resolved.commands[index]!.body
      const key = dispatchKey(resolved.commands[index]!.deviceId, resolved.commands[index]!.channelId)
      if (body.kind === 'level' && body.percent <= 0) {
        this.lastBodies.delete(key)
        this.lastRequested.delete(key)
        continue
      }
      if (body.kind === 'level' || body.kind === 'pattern') {
        this.lastBodies.set(key, { body, at, durationSec: body.durationSec })
        const requested = action.request?.requestedPercent
        if (requested !== undefined) this.lastRequested.set(key, requested)
      }
    }
  }

  /**
   * Continue the last plan body on every channel the new turn does not cover.
   *
   * Product rule (user round 4): a channel the model does not mention keeps
   * doing what it did last turn; only an explicit `stop` ends it. The host
   * therefore replays the *original* resolved body before the model call:
   * a level at its absolute percent, or a pattern with the same envelope and
   * waveform (a loop texture keeps its own rhythm instead of being flattened
   * to a steady hold). The replay is bounded by
   * `min(30, channel.maxDurationSec)` and re-issued each turn, which is what
   * makes "unmentioned channels continue" true across turns.
   *
   * The only gate left is "it is still running"
   * (`HOLD_REMAINING_THRESHOLD_MS`): if the previous command's own duration
   * still covers the think time, restarting would duplicate/lengthen it. There
   * is no TTL — an old body remains a continuation candidate until the model
   * stops the channel (or pause/panic/end clears it via the stop event).
   *
   * This is host maintenance, not a plan command: it registers no probe, its
   * registry audit lines carry `actor: 'system'`, and every per-channel failure
   * (locked, policy, device error) is swallowed so a hold never fails a turn.
   */
  private async holdContinuity(): Promise<void> {
    if (this.env.registry.isLocked || this.lastBodies.size === 0) return
    const now = this.env.clock.now()
    const snapshot = this.env.registry.snapshot()
    // Holds are host-issued commands: mark their events as trusted so the
    // human-control watcher does not treat them as a device-page action.
    this.dispatchWindowActive = true
    try {
      for (const device of snapshot.devices) {
        if (device.lifecycle !== 'ready') continue
        for (const channel of device.channels) {
          if (channel.kind !== 'level') continue
          const key = dispatchKey(device.id, channel.id)
          const held = this.lastBodies.get(key)
          if (held === undefined) continue
          // The old effect still covers the thinking window: no gap to bridge,
          // and restarting would duplicate/lengthen it.
          const remainingMs = held.at + (held.durationSec ?? 0) * 1_000 - now
          if (remainingMs > HOLD_REMAINING_THRESHOLD_MS) continue
          // Bounded on purpose: a continuation is a bridge to the next plan, not
          // an indefinite effect, and never exceeds the channel's duration cap.
          const durationSec = Math.max(1, Math.min(30, channel.maxDurationSec ?? 30))
          try {
            if (held.body.kind === 'level') {
              if (held.body.percent <= 0) continue
              await this.env.registry.setLevel('system', {
                deviceId: device.id,
                channelId: channel.id,
                percent: held.body.percent,
                durationSec,
              })
            } else if (held.body.kind === 'pattern') {
              // Keep the waveform only when the registry library can still play
              // it; a vanished scratch asset must not fail the whole hold.
              const waveformId = held.body.waveformId !== undefined
                && channel.supportsWaveform
                && this.env.waveforms.get(held.body.waveformId) !== undefined
                ? held.body.waveformId
                : undefined
              await this.env.registry.runPattern('system', {
                deviceId: device.id,
                channelId: channel.id,
                // The original envelope: a loop keeps its own rhythm, not a
                // host-flattened steady level.
                envelope: held.body.envelope,
                durationSec,
                ...(waveformId === undefined ? {} : { waveformId }),
              })
            }
          } catch {
            // Best-effort by design: the registry already audited the refusal
            // (locked/policy/device); the turn itself must go on.
          }
        }
      }
    } finally {
      this.dispatchWindowActive = false
    }
  }

  /**
   * Human-facing summary of what this turn actually dispatched.
   *
   * Every non-rejected action is kept, whatever region the beat *asked* for:
   * the resolver may route a request through a region alias or fall back to
   * every online level channel, and the player's part is the channel's
   * post-dispatch `region` label. Filtering on `beat.regions` (v9) hid exactly
   * those fallback dispatches, which is why the transcript's effect box only
   * appeared "偶尔一次" while actions really ran. Rows are deduplicated by
   * `(device, channel, region, percent, waveformId)`, because several beats or
   * route matches can drive the same channel with the same effect.
   *
   * Uses the post-dispatch registry snapshot so a waveform selected by this
   * turn's plan is already reflected; region labels use the same vocabulary the
   * player sees in the soft-cap editors. No numbers beyond the actual
   * dispatched percentage reach this row.
   */
  private effectSummary(result: TurnResult): readonly PlayTurnEffect[] {
    const scenario = this.scenario
    if (scenario === undefined) return []
    const after = this.env.registry.snapshot()
    const labels = new Map(
      sessionRegions(scenario, after).map(region => [region.id, region.label] as const),
    )
    const channels = new Map<string, { channel: (typeof after.devices)[number]['channels'][number]; deviceName: string }>()
    for (const device of after.devices) {
      for (const channel of device.channels) {
        channels.set(`${device.id}:${channel.id}`, { channel, deviceName: device.name })
      }
    }
    const beats = new Map((result.plan?.beats ?? []).map(beat => [beat.id, beat] as const))
    const effects: PlayTurnEffect[] = []
    const seen = new Set<string>()
    for (const action of result.dispatch?.actions ?? []) {
      if (action.status === 'rejected') continue
      const beat = beats.get(action.beatId)
      const found = channels.get(`${action.deviceId}:${action.channelId}`)
      const channel = found?.channel
      const region = channel?.region
      const waveform = channel?.waveform
      // One row per real effect; `\u0000` cannot occur in an id or a label.
      const key = [
        action.deviceId,
        action.channelId,
        region ?? '',
        action.percent ?? '',
        waveform?.id ?? '',
      ].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      const intentId = beat?.intentId
      // The executor reports the model's pre-mapping request alongside the
      // actual percent; passing it through is what lets the effect box show
      // "requested band % → actual output %" instead of a mysteriously small
      // number. Older/stop paths without a request simply omit both fields.
      const request = action.request
      effects.push({
        deviceId: action.deviceId,
        channelId: action.channelId,
        ...(channel?.label === undefined ? {} : { channelLabel: channel.label }),
        ...(region === undefined ? {} : { region }),
        ...(region === undefined ? {} : { regionLabel: labels.get(region) ?? region }),
        ...(request?.requestedPercent === undefined ? {} : { requestedPercent: request.requestedPercent }),
        ...(request === undefined ? {} : { strength: request.strength }),
        ...(action.percent === undefined ? {} : { percent: action.percent }),
        ...(waveform === undefined ? {} : { waveformId: waveform.id, waveformName: waveform.name }),
        ...(intentId === undefined ? {} : { intentId }),
        status: action.status,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      })
    }
    return effects
  }

  /**
   * System prompt for the current turn: boundaries → host → persona → scene → facts.
   *
   * The facts block carries the director-ish facts a single-call model needs to
   * produce a valid plan at all: the pack's intent menu, the declared region
   * ids with their player-facing labels, and which regions currently have a
   * ready channel. The frozen device snapshot is passed in so this projection
   * and the resolver agree within one turn.
   */
  private messagesFor(
    request: TurnRequest,
    phases: PhaseMachine,
    pack: LoadedPack,
    snapshot: RegistrySnapshot,
    opening: boolean,
    choice: PlayerChoice | undefined,
  ): readonly LlmMessage[] {
    const system = this.systemPrompt(phases, pack, snapshot, opening)
    const playerText = playerTextOf(request, choice)
      ?? (request.turnId > 1 ? AUTO_CONTINUE_MESSAGE : undefined)
    return buildTurnMessages({
      ...(system === '' ? {} : { system }),
      recentLines: this.recentEntries.map(entry => entry.text),
      ...(playerText === undefined ? {} : { playerText }),
    })
  }

  private systemPrompt(
    phases: PhaseMachine,
    pack: LoadedPack,
    snapshot: RegistrySnapshot,
    opening: boolean,
  ): string {
    const note = pack.phaseNotes.get(phases.current)
    const scene = [pack.setting, note, phases.currentPhase.goal]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join('\n\n')
    const sensor = sensorPromptBlock(this.env.sensors.statuses())
    // The cross-session opening brief (B2-T8) is a first-turn brief only: the
    // pack's `metaReactions.tone/firstIntent`, never a number or a device fact.
    // `firstIntent` is filtered against the effective intent table: validation
    // only warns when it is unknown (and freeform packs are unchecked), so a
    // stale id must not contradict the `apply_plan` enum the model is given.
    const brief = this.openingBrief === undefined ? '' : openingBriefText(this.openingBrief, this.intentIds())
    // The world facts are the mandatory playable menu: buildSystemPrompt keeps
    // them even when persona/scene/briefs consume the whole budget, because a
    // plan without intent/region ids would be dropped by the parser. They are
    // appended after the budgeted blocks, keeping the cacheable prefix stable.
    const facts = this.worldFacts(snapshot)
    const briefs = [brief, sensor].filter(part => part !== '')
    const autopilot = this.engine?.autopilotEnabled === true
    // Auto mode's pacing window is live engine state (the human may move it
    // while playing); naming the current range lets the director place
    // `nextTurnAfterSec` inside it instead of guessing.
    const pacing = autopilot ? this.autopilotPacingLine() : []
    // The pack's waveform ids are namespaced; the model otherwise invents short
    // names (`saw-spin`) and the executor rejects the plan with UNKNOWN_WAVEFORM.
    const waveformMenu = pack.waveforms.length === 0
      ? []
      : [`可用波形：${pack.waveforms.map(waveform => `${waveform.id}=${waveform.name}`).join('；')}（change.waveformId 只能取这些 id）`]
    // Time + phase facts are mandatory prompt context: the pack graph alone
    // cannot tell the model how far the session has progressed, and without
    // the time budget it has no basis for deciding when to advance.
    const phaseFacts = this.phaseFacts(phases)
    return buildSystemPrompt({
      ...(pack.manifest.boundaries === undefined ? {} : { boundaries: pack.manifest.boundaries }),
      ...(pack.host === undefined ? {} : { host: pack.host }),
      persona: pack.persona,
      ...(scene === '' ? {} : { scene }),
      ...(facts.length === 0 ? {} : { world: facts }),
      ...(briefs.length === 0 ? {} : { briefs }),
      // Mandatory, like `world`: appended after the budget so a long persona
      // cannot drop the narration field / tool discipline that makes the model
      // actually speak on this provider.
      protocol: [
        ...TURN_PROTOCOL,
        ...phaseFacts,
        ...waveformMenu,
        ...(opening ? OPENING_PROTOCOL : []),
        ...(autopilot ? AUTOPILOT_PROTOCOL : []),
        ...pacing,
      ],
    })
  }

  /**
   * Session-time and phase facts for the prompt.
   *
   * The session length is a host input (the pack's `plannedMinutes` is only
   * archival), so the prompt must state elapsed/remaining time for the model to
   * know where the session sits on the pack's phase windows. All values here
   * are temporal — never a device cap or an absolute intensity.
   */
  private phaseFacts(phases: PhaseMachine): readonly string[] {
    const facts: string[] = []
    const engine = this.engine?.snapshot()
    if (engine !== undefined && this.plannedMinutes > 0) {
      const percent = Math.min(100, Math.round((engine.elapsedMin / this.plannedMinutes) * 100))
      const remaining = engine.remainingMin === null ? '开放式' : `${engine.remainingMin} 分钟`
      const resolve = engine.mustResolve ? '；已到强制收束点，本回合必须收束' : ''
      facts.push(`会话时间：已进行 ${engine.elapsedMin} 分钟 / 计划 ${this.plannedMinutes} 分钟（${percent}%）；剩余 ${remaining}${resolve}。`)
    }
    const phase = phases.currentPhase
    const next = phases.allowedNext
    const condition = phase.advanceWhen === undefined ? '' : `；推进条件：${phase.advanceWhen}`
    facts.push(`当前阶段：${phase.id}（${phase.goal}）${condition}${next.length === 0 ? '；终局阶段，不可再推进' : `；可推进到：${next.join('、')}`}。`)
    const windows = this.scenario?.session.phaseWindows ?? []
    if (windows.length > 0) {
      facts.push(`阶段时间窗：${windows.map(window => `${window.phase} ${Math.round(window.from * 100)}–${Math.round(window.to * 100)}%`).join('；')}。`)
    }
    if (next.length > 0) {
      facts.push('需要推进阶段时，在 apply_plan 里给 advanceTo（只能取「可推进到」里的 id）；阶段切换由引擎执行，不要只在 narration 里宣称已进入下一阶段。')
    }
    return facts
  }

  /**
   * One protocol line naming the engine's current autopilot pacing window.
   *
   * The window is `[windowMinSec, windowMaxSec]` after the user moved range
   * sliders (falling back to the engine's absolute bounds); the director may
   * suggest the next delay with `apply_plan.nextTurnAfterSec`. A fixed window
   * (`min === max`, e.g. the legacy single interval) is not random, so the
   * line must not promise a random pick.
   */
  private autopilotPacingLine(): readonly string[] {
    const autopilot = this.engine?.snapshot().autopilot
    if (autopilot === undefined) return []
    const minSec = autopilot.windowMinSec ?? autopilot.minSec
    const maxSec = autopilot.windowMaxSec ?? autopilot.maxSec
    if (minSec === maxSec) {
      return [
        `自动运行等待：固定 ${minSec}s；可在 apply_plan.nextTurnAfterSec 给下一回合等待建议（引擎会夹到该固定值），不写则固定等待。`,
      ]
    }
    return [
      `自动运行节奏区间：${minSec}–${maxSec}s；可在 apply_plan.nextTurnAfterSec 给下一回合等待建议（引擎会夹进区间），不写则由引擎在区间内随机。`,
    ]
  }

  /** Ids in the effective intent table (the only `apply_plan` values). */
  private intentIds(): ReadonlySet<string> {
    return new Set((this.scenario?.feedbackIntents ?? []).map(intent => intent.id))
  }

  /**
   * Compact, number-free projection of what the model may act on this turn.
   *
   * Only `level` channels count: a plan can never drive a motion channel, so a
   * region with only that kind of channel is not "ready". Channel labels are
   * not sent — a pack addresses body regions, never device/channel ids
   * (`导演与写作上下文契约.md` §2: 设备能力 is a region list).
   *
   * The region list is the *reachable* part of the session vocabulary: pack
   * recommendations only make it when a ready channel carries them (or the
   * player named a channel that way). The audit's world facts listed both the
   * pack ids and the player's labels, and the model kept writing 内容包 ids
   * while the player's own parts were the only ones that could feel anything.
   */
  private worldFacts(snapshot: RegistrySnapshot): readonly string[] {
    const scenario = this.scenario
    if (scenario === undefined) return []
    return buildWorldFacts({
      intents: scenario.feedbackIntents,
      regions: targetableRegions(scenario, snapshot),
      channels: snapshot.devices.flatMap(device => device.channels
        .filter(channel => channel.kind === 'level')
        .map(channel => ({ region: channel.region, ready: device.lifecycle === 'ready' }))),
    })
  }
}

/**
 * One *active* session per process: pack lookup, the start gate and panic
 * delegation.
 *
 * "One process, one session" still holds while a session is running; a session
 * that has reached `ended` is closed and may be replaced by a fresh start (the
 * play view returns to the lobby, so the next 开局 must be able to open a new
 * one). The old session is disposed before the replacement is created.
 */
export class PlayHost {
  private readonly options: PlayHostOptions
  private session: PlaySession | undefined
  /** True while a start is resolving the pack; closes the concurrent-start race. */
  private starting = false

  constructor(options: PlayHostOptions) {
    this.options = options
  }

  /**
   * Resolve the pack and open a session.
   *
   * A failed start leaves the process open for a retry (for example after the
   * operator removes the lock); a still-running session refuses a second start
   * with `SESSION_OPEN`. Only an `ended` session is reusable by replacement.
   */
  async start(request: PlayHostStartRequest): Promise<PlaySnapshot> {
    if (this.starting) {
      throw new SessionError('SESSION_OPEN', 'a session start is already in progress')
    }
    if (this.session !== undefined) {
      if (this.session.snapshot()?.state !== 'ended') {
        throw new SessionError('SESSION_OPEN', 'a session is already open in this process')
      }
      // The lobby is the next screen after 结束; dispose the finished engine so
      // its timers/archive handle cannot leak into the replacement.
      this.session.dispose()
      this.session = undefined
    }
    this.starting = true
    try {
      const packId = request.packId.trim()
      if (!PACK_ID_PATTERN.test(packId)) {
        throw new SessionError('INVALID_INPUT', `"${request.packId}" is not a valid pack id`)
      }
      const plannedMinutes = normalizePlannedMinutes(request.plannedMinutes)
      const ceilingPercent = request.ceilingPercent
      if (ceilingPercent !== undefined) assertCeiling(ceilingPercent)
      if (this.options.registry.isLocked) {
        throw new SessionError('LOCKED', 'the device registry is locked; unlock it before starting a session')
      }
      const pack = await this.loadPack(packId)
      const session = new PlaySession(this.options)
      this.session = session
      try {
        return await session.start({
          pack,
          plannedMinutes,
          ...(ceilingPercent === undefined ? {} : { ceilingPercent }),
          ...(request.autopilot === undefined ? {} : { autopilot: request.autopilot }),
        })
      } catch (error) {
        this.session = undefined
        session.dispose()
        throw error
      }
    } finally {
      this.starting = false
    }
  }

  /** Forward a player message to the open session. */
  async message(text: string): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.message(text)
  }

  /** Pause the open session; `SESSION_OPEN`-scoped like every session call. */
  async pause(): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.pause()
  }

  /** Resume the open session without replaying effects. */
  async resume(): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.resume()
  }

  /** Human autopilot change; requires an open, non-terminal session. */
  async setAutopilot(input: PlayAutopilotInput): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return session.setAutopilot(input)
  }

  /** Pick an offered option; the session validates the id against its menu. */
  async submitChoice(choiceId: string): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.submitChoice(choiceId)
  }

  /** Route-name alias of {@link submitChoice} (`POST /api/session/choice`). */
  async choice(choiceId: string): Promise<PlaySnapshot> {
    return await this.submitChoice(choiceId)
  }

  /** Settled transcript lines for the poller; empty before the first start. */
  transcript(): readonly PlayTranscriptEntry[] {
    return this.session?.transcript() ?? []
  }

  /** Recent ledger lines; empty without an archive or before a session. */
  async ledgerEntries(limit?: number): Promise<readonly LedgerEntry[]> {
    const session = this.session
    if (session === undefined) return []
    return await session.ledgerEntries(limit)
  }

  /** Route-name alias of {@link ledgerEntries} (`GET /api/ledger`). */
  async ledger(limit?: number): Promise<readonly LedgerEntry[]> {
    return await this.ledgerEntries(limit)
  }

  /** End the open session; the reason is validated against the M2 vocabulary. */
  async end(reason: string): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.end(parseEndReason(reason))
  }

  /** Engine snapshot + pack identity; undefined before the first start. */
  snapshot(): PlaySnapshot | undefined {
    return this.session?.snapshot()
  }

  /** P0 stop: locks the live engine when there is one, always stops effects. */
  async panic(source: string): Promise<void> {
    const session = this.session
    if (session === undefined) {
      await this.options.registry.emergencyStop(source)
      return
    }
    await session.panic(source)
  }

  /** Human session-ceiling change; requires an open session (B2-T9). */
  async setCeiling(percent: number): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.setSessionCeiling(percent)
  }

  /** Region label edit; works without a session (it is device config, B2-T10). */
  async setRegion(deviceId: string, channelId: string, region: string | undefined): Promise<void> {
    if (this.session !== undefined) {
      await this.session.setRegion(deviceId, channelId, region)
      return
    }
    await this.options.registry.setRegionByHuman(deviceId, channelId, region)
  }

  /** Region labels in force, keyed `device:channel`. */
  regions(): Readonly<Record<string, string>> {
    return this.session?.regions() ?? regionsOf(this.options.registry.snapshot())
  }

  /** Recent probes from the open session (debug panel only). */
  probes(): readonly ProbeRecord[] {
    return this.session?.probes() ?? []
  }

  /** Latest model-requested band percent per `device:channel` (empty before start). */
  requestedPercents(): Readonly<Record<string, number>> {
    return this.session?.requestedPercents() ?? {}
  }

  /** Human unlock for both latches (registry unlock stays the dashboard's job). */
  unlock(note?: string): void {
    this.session?.unlock(note)
  }

  /** Cancel timers when the host shuts down. */
  dispose(): void {
    this.session?.dispose()
  }

  private async loadPack(packId: string): Promise<LoadedPack> {
    try {
      return await this.options.packs.load(packId)
    } catch (error) {
      if (error instanceof SessionError) throw error
      if (error instanceof ContentPackError) {
        throw new SessionError('PACK_INVALID', error.message)
      }
      throw new SessionError('PACK_NOT_FOUND', `could not load content pack "${packId}": ${describe(error)}`)
    }
  }
}

/** Everything {@link PlayHost} needs; the pack source is the only extra. */
export interface PlayHostOptions extends PlaySessionEnvironment {
  readonly packs: PlayPackSource
}

/**
 * Read packs from `<dataDir>/content/packs/<packId>/<version>/`.
 *
 * Interim lookup until B2-T14 owns `content/registry.json`: the highest
 * installed semver wins, because "the next session starts from the active
 * version" is the contract and the newest installed version is the closest
 * stand-in in M2-B1. Errors are {@link SessionError}s so HTTP answers `400`.
 */
export class DirectoryPackSource implements PlayPackSource {
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  async load(packId: string): Promise<LoadedPack> {
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new SessionError('INVALID_INPUT', `"${packId}" is not a valid pack id`)
    }
    const packRoot = join(this.dataDir, 'content', 'packs', packId)
    let entries
    try {
      entries = await readdir(packRoot, { withFileTypes: true })
    } catch (error) {
      throw new SessionError(
        'PACK_NOT_FOUND',
        `content pack "${packId}" is not installed under ${packRoot}: ${describe(error)}`,
      )
    }
    const versions: { readonly name: string; readonly version: SemverVersion }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const version = parseVersion(entry.name)
      if (version !== undefined) versions.push({ name: entry.name, version })
    }
    versions.sort((left, right) => compareVersions(right.version, left.version))
    const best = versions[0]
    if (best === undefined) {
      throw new SessionError(
        'PACK_NOT_FOUND',
        `content pack "${packId}" has no installed version directory (expected <version>/ under ${packRoot})`,
      )
    }
    const source = new DirectoryContentSource(join(packRoot, best.name))
    try {
      return await loadPack(source)
    } catch (error) {
      if (error instanceof ContentPackError) throw new SessionError('PACK_INVALID', error.message)
      throw new SessionError('PACK_INVALID', `could not load content pack "${packId}": ${describe(error)}`)
    }
  }
}

/** `ContentSource` over one pack directory; POSIX relative paths to the loader. */
class DirectoryContentSource implements ContentSource {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async list(): Promise<readonly string[]> {
    const files: string[] = []
    await this.walk(this.root, '', files)
    return files.sort()
  }

  async readText(path: string): Promise<string> {
    return await readFile(this.absolute(path), 'utf8')
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const bytes = await readFile(this.absolute(path))
    return new Uint8Array(bytes)
  }

  async byteSize(path: string): Promise<number> {
    const info = await stat(this.absolute(path))
    return info.size
  }

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'))
  }

  private async walk(directory: string, prefix: string, out: string[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      // The loader cannot see symlinks through its port; the host refuses them
      // here so an installed pack can never read outside its own directory.
      if (entry.isSymbolicLink()) continue
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await this.walk(join(directory, entry.name), relative, out)
      } else if (entry.isFile()) {
        out.push(relative)
      }
    }
  }
}

/** Freeform packs get the documented synthetic scenario (loader stays neutral). */
function scenarioFor(pack: LoadedPack, plannedMinutes: number): ScenarioDefinition {
  if (pack.scenario !== undefined) return pack.scenario
  return {
    session: { plannedMinutes, phaseWindows: [], aftercareMin: FREEFORM_AFTERCARE_MIN },
    regions: [{ id: WHOLE_BODY_REGION, label: '全身' }],
    phases: [
      {
        id: FREEFORM_PHASE_ID,
        goal: '与玩家即时互动；每回合只推进一小步，先观察对方的反应。',
        next: [],
      },
    ],
    feedbackIntents: DEFAULT_INTENTS,
  }
}

/**
 * The narrative body regions one pack offers the player.
 *
 * A `scenario` pack declares them in `scenario.regions`; a freeform pack gets
 * the same synthetic `whole-body` region {@link scenarioFor} adds, so the
 * console's per-channel picker never has to special-case the pack mode.
 *
 * `whole-body` always comes first, even when the pack omits it: the wildcard is
 * accepted by the resolver, world facts and the runtime enum for every pack, so
 * hiding it from the picker would make the UI contradict the engine. A declared
 * `whole-body` entry keeps its authored label; otherwise the default is 全身.
 * This is a read-only projection: the human is the only writer of channel
 * labels.
 */
export function regionVocabularyOf(pack: LoadedPack): readonly { id: string; label: string }[] {
  const declared = pack.scenario?.regions ?? [{ id: WHOLE_BODY_REGION, label: '全身' }]
  const wholeBody = declared.find(region => region.id === WHOLE_BODY_REGION)
  return [
    { id: WHOLE_BODY_REGION, label: wholeBody?.label ?? '全身' },
    ...declared
      .filter(region => region.id !== WHOLE_BODY_REGION)
      .map(region => ({ id: region.id, label: region.label })),
  ]
}

/** Region labels from a registry snapshot, keyed `device:channel`. */
function regionsOf(snapshot: RegistrySnapshot): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {}
  for (const device of snapshot.devices) {
    for (const channel of device.channels) {
      if (channel.region !== undefined) labels[`${device.id}:${channel.id}`] = channel.region
    }
  }
  return labels
}

/**
 * The regions this session can speak: the pack's recommendations plus every
 * player-named part currently on a channel.
 *
 * The pack's `scenario.regions` is a *recommendation* list (v6). The human may
 * label a channel with any short text; those labels become additional region
 * keys for this session, so the model can target them in `apply_plan.regions`
 * and the resolver can match them. Order is pack-declared first, then player
 * parts in snapshot order; the same string is one region.
 */
function sessionRegions(
  scenario: ScenarioDefinition,
  snapshot: RegistrySnapshot,
): readonly { readonly id: string; readonly label: string }[] {
  const regions: { id: string; label: string }[] = scenario.regions.map(region => ({
    id: region.id,
    label: region.label,
  }))
  const known = new Set(regions.map(region => region.id))
  for (const device of snapshot.devices) {
    for (const channel of device.channels) {
      // A motion channel can never be driven by a plan, so its label must not
      // be advertised as a targetable region.
      if (channel.kind !== 'level') continue
      const region = channel.region
      if (region === undefined || region === '' || known.has(region)) continue
      known.add(region)
      // A player-authored part has no separate label: the key is its name.
      regions.push({ id: region, label: region })
    }
  }
  return regions
}

/**
 * The session vocabulary a beat can actually reach this turn.
 *
 * Takes {@link sessionRegions} and keeps only the ids that sit on a *ready*
 * level channel, so the prompt's 可用部位 line and the `apply_plan` region enum
 * advertise parts the resolver can really reach. A pack recommendation with no
 * ready channel behind it is not a target: leaving it in the menu is what made
 * the model write `inner-thigh` while the player's channels were 阴蒂/小穴.
 *
 * `whole-body` stays out of this subset — it is the wildcard every plan may
 * use, re-added by `buildWorldFacts`/`withPlayableEnums` at the head of the
 * menu. When *no* ready channel is labelled the answer is the empty list, not
 * the pack vocabulary: an unlabelled rig can still be driven through
 * `whole-body`, but advertising pack ids there only makes the model name parts
 * the resolver cannot match, which forces the "drive every channel" fallback
 * and re-creates the audit's 文不对部位 symptom.
 */
function targetableRegions(
  scenario: ScenarioDefinition,
  snapshot: RegistrySnapshot,
): readonly { readonly id: string; readonly label: string }[] {
  const reachable = new Set<string>()
  for (const device of snapshot.devices) {
    if (device.lifecycle !== 'ready') continue
    for (const channel of device.channels) {
      if (channel.kind !== 'level') continue
      if (channel.region !== undefined && channel.region !== '') reachable.add(channel.region)
    }
  }
  if (reachable.size === 0) return []
  return sessionRegions(scenario, snapshot).filter(region => reachable.has(region.id))
}

/**
 * Pack region id → the player-named channel regions that mean the same part.
 *
 * A pack authors prose (`核心敏感区（阴部/阴茎/阴蒂/大腿内侧）`), while a channel
 * carries the player's own word (`阴蒂`). The resolver's alias map makes a beat
 * that uses the pack id land on the talked-about channel instead of falling
 * back to every online level channel — and `narration` then names the part the
 * player actually has. Matching is strictly "the player label is a substring
 * of the pack label, and is not the region id"; entries are collected in
 * stable device/channel order so the map (and the resolved plan) is
 * deterministic. `whole-body` is already a wildcard, so it needs no alias.
 */
function regionAliasesOf(
  scenario: ScenarioDefinition,
  snapshot: RegistrySnapshot,
): Map<string, readonly string[]> {
  const channels: { readonly deviceId: string; readonly channelId: string; readonly region: string }[] = []
  for (const device of snapshot.devices) {
    for (const channel of device.channels) {
      if (channel.kind !== 'level') continue
      if (channel.region === undefined || channel.region === '') continue
      channels.push({ deviceId: device.id, channelId: channel.id, region: channel.region })
    }
  }
  channels.sort((left, right) => compareStrings(left.deviceId, right.deviceId)
    || compareStrings(left.channelId, right.channelId))

  const aliases = new Map<string, readonly string[]>()
  for (const region of scenario.regions) {
    if (region.id === WHOLE_BODY_REGION) continue
    const matched: string[] = []
    for (const channel of channels) {
      if (channel.region === region.id) continue
      if (!region.label.includes(channel.region)) continue
      if (!matched.includes(channel.region)) matched.push(channel.region)
    }
    if (matched.length > 0) aliases.set(region.id, matched)
  }
  return aliases
}

/** Code-unit comparison: locale-independent, so a resolved plan is stable. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Map key for one channel; `\u0000` cannot occur in a device or channel id. */
function dispatchKey(deviceId: string, channelId: string): string {
  return `${deviceId}\u0000${channelId}`
}

/** What the model may read about the world this turn: registry facts only. */
function resolveContextOf(
  snapshot: RegistrySnapshot,
  scenario: ScenarioDefinition,
  waveforms: WaveformLookup,
  regionAliases: ReadonlyMap<string, readonly string[]>,
  roundRobinCursor: number,
  defaultWaveformId: string | undefined,
  sustainLoopSec: number,
): ResolveContext {
  const intents = new Map<string, FeedbackIntent>()
  for (const intent of scenario.feedbackIntents) intents.set(intent.id, intent)
  return {
    snapshot,
    intents,
    // The resolver keeps the *full* session vocabulary: it is what accepts a
    // player-named part and what makes the "region not in vocabulary" warning
    // meaningful. Aliases are an optional extra route to a channel.
    regions: sessionRegions(scenario, snapshot).map(region => region.id),
    waveforms,
    // Per-turn rotation seed for round-robin intents (production never moved
    // it before; the resolver accepts it, so the host must supply it).
    roundRobinCursor,
    // A pack with waveforms ships one default: an unknown model reference
    // degrades to it (with a warning) instead of silently losing the texture.
    ...(defaultWaveformId === undefined ? {} : { defaultWaveformId }),
    // Loop assets sustain themselves instead of being restarted by the hold.
    sustainLoopSec,
    ...(regionAliases.size === 0 ? {} : { regionAliases }),
  }
}

/** A choice has no prose; render it as the player's line so the prompt still reads. */
function playerTextOf(request: TurnRequest, choice?: PlayerChoice): string | undefined {
  if (request.choiceId !== undefined) {
    const label = choice?.label?.trim()
    const tag = choice?.tag?.trim()
    if (label !== undefined && label !== '') {
      return `（玩家选择：${label}${tag === undefined || tag === '' ? '' : `（${tag}）`}）`
    }
    return `（选择：${request.choiceId}）`
  }
  const text = request.playerText?.trim()
  return text === undefined || text === '' ? undefined : text
}

/** Render a `metaReactions` brief as a prompt line; an empty brief renders nothing. */
/**
 * Render a `metaReactions` opening brief as a prompt line.
 *
 * `firstIntent` is only rendered when the id is in the effective intent table:
 * the scenario validator only warns about an unknown default (and a freeform
 * pack is not checked against `DEFAULT_INTENTS` at all), while the model's
 * `apply_plan` enum would reject it. Tone is always safe to render.
 */
export function openingBriefText(
  brief: OpeningBrief,
  allowedIntentIds?: ReadonlySet<string>,
): string {
  const parts: string[] = []
  if (brief.tone !== undefined) parts.push(`语气「${brief.tone}」`)
  if (brief.firstIntent !== undefined
    && (allowedIntentIds === undefined || allowedIntentIds.has(brief.firstIntent))) {
    parts.push(`首个意图「${brief.firstIntent}」`)
  }
  return parts.length === 0 ? '' : `开场指引：${parts.join('，')}。`
}

/**
 * Validate the human autopilot request.
 *
 * `enabled` must be a real boolean (a string "false" must not silently switch
 * the timer on). The legacy interval and the pacing window are optional,
 * positive and finite and are clamped by the engine into its absolute bounds;
 * the window's two bounds must be provided together and be ordered. A
 * malformed request is a caller error.
 */
function normalizeAutopilot(input: PlayAutopilotInput | undefined): PlayAutopilotInput | undefined {
  if (input === undefined) return undefined
  if (typeof input.enabled !== 'boolean') {
    throw new SessionError('INVALID_INPUT', 'autopilot.enabled must be a boolean')
  }
  if (input.intervalSec !== undefined
    && (!Number.isFinite(input.intervalSec) || input.intervalSec <= 0)) {
    throw new SessionError('INVALID_INPUT', 'autopilot.intervalSec must be a positive number')
  }
  for (const [name, value] of [
    ['windowMinSec', input.windowMinSec],
    ['windowMaxSec', input.windowMaxSec],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new SessionError('INVALID_INPUT', `autopilot.${name} must be a positive number`)
    }
  }
  if ((input.windowMinSec === undefined) !== (input.windowMaxSec === undefined)) {
    throw new SessionError(
      'INVALID_INPUT',
      'autopilot.windowMinSec and autopilot.windowMaxSec must be provided together',
    )
  }
  if (input.windowMinSec !== undefined && input.windowMaxSec !== undefined
    && input.windowMinSec > input.windowMaxSec) {
    throw new SessionError('INVALID_INPUT', 'autopilot.windowMinSec must not exceed autopilot.windowMaxSec')
  }
  return {
    enabled: input.enabled,
    ...(input.intervalSec === undefined ? {} : { intervalSec: input.intervalSec }),
    ...(input.windowMinSec === undefined ? {} : { windowMinSec: input.windowMinSec }),
    ...(input.windowMaxSec === undefined ? {} : { windowMaxSec: input.windowMaxSec }),
  }
}

function normalizePlannedMinutes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new SessionError('INVALID_INPUT', 'plannedMinutes must be a positive number of minutes')
  }
  return value
}

function assertCeiling(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new SessionError('INVALID_INPUT', 'ceilingPercent must be a whole number from 0 to 100')
  }
}

function parseEndReason(reason: string): EndReason {
  if (reason === 'completed' || reason === 'left_early' || reason === 'stop') return reason
  throw new SessionError('INVALID_INPUT', 'reason must be one of: completed, left_early, stop')
}

function compareVersions(left: SemverVersion, right: SemverVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
