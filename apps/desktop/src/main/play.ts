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
  runTurn,
  sensorPromptBlock,
  TurnEngine,
  WHOLE_BODY_REGION,
  withPlayableEnums,
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

/** Pack ids follow `内容包规范.md` §3: lowercase slug. */
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u

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

/** Human-facing autopilot request: enable flag plus an optional interval. */
export interface PlayAutopilotInput {
  readonly enabled: boolean
  /** Seconds; clamped by the engine into its configured bounds. */
  readonly intervalSec?: number
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
  /** `metaReactions` opening brief, consumed by the opening turn only. */
  private openingBrief: OpeningBrief | undefined

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
    const phases = new PhaseMachine(scenario.phases)

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
        phase: phases.current,
      })
      await ledger.open(sessionId, { pack: input.pack.manifest.id, plannedMin: plannedMinutes })
    }

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
    this.scenario = scenario
    this.phases = phases
    this.store = store
    this.ledger = ledger
    this.archived = archived
    this.openingBrief = openingBrief
    this.turnBeats.length = 0
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

    // The scheduler's P2 vocabulary has no `opening` kind (B2-T4 owns it);
    // `resume` is the session-level "begin/continue" trigger and starts
    // immediately because the engine is idle.
    engine.startSession()
    engine.submit({ priority: 'session', kind: OPENING_TRIGGER_KIND, at: this.env.clock.now() })
    await engine.whenIdle()
    // Apply the lobby's autopilot choice after the opening turn: an enabled
    // timer controls only *subsequent* P3 turns, and starting it earlier would
    // only arm a tick that the opening turn immediately drops.
    if (autopilot !== undefined) {
      if (autopilot.intervalSec !== undefined) engine.setAutopilotInterval(autopilot.intervalSec)
      engine.setAutopilot(autopilot.enabled)
    }
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
   * Human autopilot change while playing: toggle and/or set the interval.
   *
   * The engine clamps the interval into its configured bounds; the next
   * snapshot carries the adopted values so the UI can re-render the slider.
   */
  setAutopilot(input: PlayAutopilotInput): PlaySnapshot {
    const engine = this.liveEngine()
    if (input.intervalSec !== undefined) engine.setAutopilotInterval(input.intervalSec)
    engine.setAutopilot(input.enabled)
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
    if (!offered.some(choice => choice.id === id)) {
      throw new SessionError('INVALID_INPUT', `choice "${id}" was not offered in this turn`)
    }
    await engine.submitChoice(id)
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
    return [...this.recentEntries]
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
      dispatch: async (plan, ctx, diagnostics) => {
        if (this.engine?.state === 'planning') request.onStage?.('executing')
        return await this.executor.dispatch(plan, ctx, diagnostics)
      },
    }

    let wrote = false
    // Freeze the registry facts once per turn: the prompt's device/region
    // projection and the resolver must see the same snapshot, or the model
    // could be told a region is ready and be resolved against one that is not.
    const snapshot = this.env.registry.snapshot()
    const resolveContext = resolveContextOf(snapshot, scenario, this.waveformLookup)
    // Build the prompt (the opening brief, when present, is part of it), then
    // consume the brief: it belongs to the opening turn only, even if that
    // request ends in a fallback.
    const messages = this.messagesFor(request, phases, pack, snapshot)
    this.openingBrief = undefined
    const result = await runTurn({
      runner: this.modelRunnerFor(),
      // The pack's intent menu and region vocabulary are the only legal values
      // for `apply_plan`; injecting them keeps the static tool schema free of
      // content while stopping the model from inventing ids (§4.9.2).
      tools: withPlayableEnums(M2_MODEL_TOOLS, [...resolveContext.intents.keys()], resolveContext.regions),
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

    const line = result.line
    if (line.trim() !== '') {
      // One entry serves both the writer's recent memory and the transcript:
      // no second write path, and `at` is the injected-clock settlement time.
      this.recentEntries.push({ turnId: request.turnId, at: this.env.clock.now(), text: line })
      if (this.recentEntries.length > RECENT_LINE_LIMIT) this.recentEntries.shift()
    }
    // Ledger/archive facts for this turn: dispatched percentages (B2-T8
    // `maxCapUsed`, never a cap) and the intent ids of the last two turns.
    this.recordTurnFacts(result)
    const choices = result.plan?.choices
    return {
      line,
      ...(choices === undefined ? {} : { choices }),
    }
  }

  /** Persist the snapshot that `TurnEngine.onSettle` hands us (B2-T7). */
  private async persistSnapshot(engine: EngineSnapshot): Promise<void> {
    const store = this.store
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
  ): readonly LlmMessage[] {
    const system = this.systemPrompt(phases, pack, snapshot)
    const playerText = playerTextOf(request)
    return buildTurnMessages({
      ...(system === '' ? {} : { system }),
      recentLines: this.recentEntries.map(entry => entry.text),
      ...(playerText === undefined ? {} : { playerText }),
    })
  }

  private systemPrompt(phases: PhaseMachine, pack: LoadedPack, snapshot: RegistrySnapshot): string {
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
    const opening = this.openingBrief === undefined ? '' : openingBriefText(this.openingBrief, this.intentIds())
    // The world facts are the mandatory playable menu: buildSystemPrompt keeps
    // them even when persona/scene/briefs consume the whole budget, because a
    // plan without intent/region ids would be dropped by the parser. They are
    // appended after the budgeted blocks, keeping the cacheable prefix stable.
    const facts = this.worldFacts(snapshot)
    const briefs = [opening, sensor].filter(part => part !== '')
    return buildSystemPrompt({
      ...(pack.manifest.boundaries === undefined ? {} : { boundaries: pack.manifest.boundaries }),
      ...(pack.host === undefined ? {} : { host: pack.host }),
      persona: pack.persona,
      ...(scene === '' ? {} : { scene }),
      ...(facts.length === 0 ? {} : { world: facts }),
      ...(briefs.length === 0 ? {} : { briefs }),
    })
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
   */
  private worldFacts(snapshot: RegistrySnapshot): readonly string[] {
    const scenario = this.scenario
    if (scenario === undefined) return []
    return buildWorldFacts({
      intents: scenario.feedbackIntents,
      // Pack recommendations + player-named parts; the model may target either.
      regions: sessionRegions(scenario, snapshot),
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

/** What the model may read about the world this turn: registry facts only. */
function resolveContextOf(
  snapshot: RegistrySnapshot,
  scenario: ScenarioDefinition,
  waveforms: WaveformLookup,
): ResolveContext {
  const intents = new Map<string, FeedbackIntent>()
  for (const intent of scenario.feedbackIntents) intents.set(intent.id, intent)
  return {
    snapshot,
    intents,
    regions: sessionRegions(scenario, snapshot).map(region => region.id),
    waveforms,
  }
}

/** A choice has no prose; render it as the player's line so the prompt still reads. */
function playerTextOf(request: TurnRequest): string | undefined {
  if (request.choiceId !== undefined) return `（选择：${request.choiceId}）`
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
 * the timer on); the interval is optional, positive and finite, and the engine
 * clamps it into its configured range. A malformed request is a caller error.
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
  return {
    enabled: input.enabled,
    ...(input.intervalSec === undefined ? {} : { intervalSec: input.intervalSec }),
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
