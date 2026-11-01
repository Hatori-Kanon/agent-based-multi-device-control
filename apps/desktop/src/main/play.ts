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
 * ## One process, one session
 *
 * {@link PlayHost} holds at most one {@link PlaySession}. `start` is refused
 * while a session exists — including after `end`, because the process-level
 * contract is "one session per process" for M2. `message` and `end` are
 * refused when no session was ever opened. Every refusal is a typed
 * {@link SessionError}; the HTTP layer maps it to `400`, never `500`.
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
  type AuditLog,
  type Clock,
  type DeviceRegistry,
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
  type TurnRunner,
  type TurnRunnerResult,
  type WaveformLibrary,
} from '@embodied/core'
import type { ContentSource } from '@embodied/core'

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

/** Everything a session needs from the host; all injected, nothing global. */
export interface PlaySessionEnvironment {
  readonly clock: Clock
  readonly audit: AuditLog
  readonly registry: DeviceRegistry
  readonly policy: PolicyStore
  readonly waveforms: WaveformLibrary
  readonly sensors: SensorRegistry
  readonly runner: ModelRunner
  /** Persist `state/policy.json` after a human ceiling change (D4/A1-T10). */
  readonly savePolicy: () => Promise<void>
  /** Live line deltas for the play UI / transcript (B2-T11 consumes it later). */
  readonly onLine?: (delta: string) => void
  /** Engine observability, forwarded to the debug panel when present. */
  readonly onEvent?: (event: EngineEvent) => void
  /** Engine tuning; defaults match {@link TurnEngine}'s own defaults. */
  readonly engineConfig?: Partial<EngineConfig>
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
}

/** What `GET /api/session` returns: the engine snapshot plus the pack identity. */
export interface PlaySnapshot extends EngineSnapshot {
  readonly packId: string
  readonly packVersion: string
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
  private scenario: ScenarioDefinition | undefined
  private phases: PhaseMachine | undefined
  private sessionId: string | undefined
  private plannedMinutes = 0
  private started = false
  private readonly recentLines: string[] = []

  constructor(env: PlaySessionEnvironment) {
    this.env = env
    // The executor is the only dispatch path, and it enforces the registry's
    // safety contract (locked ⇒ blocked, no direct backend access).
    this.executor = new PlanExecutor({
      registry: env.registry,
      audit: env.audit,
      waveforms: env.waveforms,
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
   */
  async start(input: PlayStartInput): Promise<PlaySnapshot> {
    if (this.started) {
      throw new SessionError('SESSION_OPEN', 'a session is already open in this process')
    }
    const plannedMinutes = normalizePlannedMinutes(input.plannedMinutes)
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
    const phases = new PhaseMachine(scenario.phases)
    const engine = new TurnEngine({
      clock: this.env.clock,
      audit: this.env.audit,
      runner: this.runnerFor(),
      plannedMinutes,
      phase: () => phases.current,
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
      ...(this.env.engineConfig === undefined ? {} : { config: this.env.engineConfig }),
    })
    this.pack = input.pack
    this.scenario = scenario
    this.phases = phases
    this.engine = engine
    this.plannedMinutes = plannedMinutes
    this.sessionId = randomUUID()
    this.started = true

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
    engine.submit({ priority: 'session', kind: OPENING_TRIGGER_KIND, at: this.env.clock.now() })
    await engine.whenIdle()
    return this.requireSnapshot()
  }

  /**
   * Send a player line (P1: always preempts).
   *
   * Rejects when there is no session, after `end`, or while the runtime is
   * locked — the engine would silently ignore the last case, which an HTTP
   * caller must not read as success.
   */
  async message(text: string): Promise<PlaySnapshot> {
    const engine = this.engine
    if (engine === undefined) throw new SessionError('NO_SESSION', 'no session is open')
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

  /** End the session and stop every effect (idempotent once ended). */
  async end(reason: EndReason): Promise<PlaySnapshot> {
    const engine = this.engine
    if (engine === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    await engine.end(reason)
    return this.requireSnapshot()
  }

  /** The current engine snapshot plus the pack identity, or undefined. */
  snapshot(): PlaySnapshot | undefined {
    const engine = this.engine
    const pack = this.pack
    if (engine === undefined || pack === undefined) return undefined
    return {
      ...engine.snapshot(),
      packId: pack.manifest.id,
      packVersion: pack.manifest.version,
    }
  }

  /** P0: out-of-band stop. Locks the engine and cuts the devices. */
  async panic(source: string): Promise<void> {
    const engine = this.engine
    if (engine !== undefined && engine.state !== 'ended') {
      await engine.panic(source)
      return
    }
    // No engine yet (or a finished session): the registry is still the stop.
    await this.env.registry.emergencyStop(source)
  }

  /** Human unlock; the only way out of the LOCKED latch. */
  unlock(note?: string): void {
    this.engine?.unlock(note)
  }

  /** Cancel timers/queued turns; safe to call at host shutdown. */
  dispose(): void {
    this.engine?.dispose()
  }

  private requireSnapshot(): PlaySnapshot {
    const snapshot = this.snapshot()
    if (snapshot === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return snapshot
  }

  /** The adapter that makes `runTurn` satisfy the engine's {@link TurnRunner}. */
  private runnerFor(): TurnRunner {
    return { run: async (request: TurnRequest): Promise<TurnRunnerResult> => this.runOneTurn(request) }
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
    const result = await runTurn({
      runner: this.env.runner,
      tools: M2_MODEL_TOOLS,
      executor,
      input: {
        turnId: request.turnId,
        phase: phases.current,
        messages: this.messagesFor(request, phases, pack),
        resolveContext: resolveContextOf(this.env.registry.snapshot(), scenario, this.env.waveforms),
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
      this.recentLines.push(line)
      if (this.recentLines.length > RECENT_LINE_LIMIT) this.recentLines.shift()
    }
    const choices = result.plan?.choices
    return {
      line,
      ...(choices === undefined ? {} : { choices }),
    }
  }

  /** System prompt for the current turn: boundaries → host → persona → scene → facts. */
  private messagesFor(
    request: TurnRequest,
    phases: PhaseMachine,
    pack: LoadedPack,
  ): readonly LlmMessage[] {
    const system = this.systemPrompt(phases, pack)
    const playerText = playerTextOf(request)
    return buildTurnMessages({
      ...(system === '' ? {} : { system }),
      recentLines: this.recentLines,
      ...(playerText === undefined ? {} : { playerText }),
    })
  }

  private systemPrompt(phases: PhaseMachine, pack: LoadedPack): string {
    const note = pack.phaseNotes.get(phases.current)
    const scene = [pack.setting, note, phases.currentPhase.goal]
      .filter((part): part is string => part !== undefined && part.trim() !== '')
      .join('\n\n')
    const sensor = sensorPromptBlock(this.env.sensors.statuses())
    const briefs = sensor === '' ? [] : [sensor]
    return buildSystemPrompt({
      ...(pack.manifest.boundaries === undefined ? {} : { boundaries: pack.manifest.boundaries }),
      ...(pack.host === undefined ? {} : { host: pack.host }),
      persona: pack.persona,
      ...(scene === '' ? {} : { scene }),
      ...(briefs.length === 0 ? {} : { briefs }),
    })
  }
}

/**
 * One session per process: pack lookup, the start gate and panic delegation.
 *
 * B1-T16 exposes the engine snapshot; pause/resume/choice/transcript belong to
 * B2-T11 and plug into this class without changing the start/message/end/snapshot
 * surface.
 */
export class PlayHost {
  private readonly options: PlayHostOptions
  private session: PlaySession | undefined

  constructor(options: PlayHostOptions) {
    this.options = options
  }

  /**
   * Resolve the pack and open the only session this process will run.
   *
   * A failed start leaves the process open for a retry (for example after the
   * operator removes the lock); the "already open" refusal applies only to a
   * session that actually started.
   */
  async start(request: PlayHostStartRequest): Promise<PlaySnapshot> {
    if (this.session !== undefined) {
      throw new SessionError('SESSION_OPEN', 'a session is already open in this process')
    }
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
      })
    } catch (error) {
      this.session = undefined
      session.dispose()
      throw error
    }
  }

  /** Forward a player message to the open session. */
  async message(text: string): Promise<PlaySnapshot> {
    const session = this.session
    if (session === undefined) throw new SessionError('NO_SESSION', 'no session is open')
    return await session.message(text)
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

/** What the model may read about the world this turn: registry facts only. */
function resolveContextOf(
  snapshot: RegistrySnapshot,
  scenario: ScenarioDefinition,
  waveforms: WaveformLibrary,
): ResolveContext {
  const intents = new Map<string, FeedbackIntent>()
  for (const intent of scenario.feedbackIntents) intents.set(intent.id, intent)
  return {
    snapshot,
    intents,
    regions: scenario.regions.map(region => region.id),
    waveforms,
  }
}

/** A choice has no prose; render it as the player's line so the prompt still reads. */
function playerTextOf(request: TurnRequest): string | undefined {
  if (request.choiceId !== undefined) return `（选择：${request.choiceId}）`
  const text = request.playerText?.trim()
  return text === undefined || text === '' ? undefined : text
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
