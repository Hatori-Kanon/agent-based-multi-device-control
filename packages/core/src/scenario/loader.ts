/**
 * Content-pack loading.
 *
 * One `loadPack(source)` call turns a directory-shaped pack (reached through
 * the platform-free {@link ContentSource} port) into a typed {@link LoadedPack}
 * or a {@link ContentPackError} that names the offending file. Validation is
 * split in two on purpose:
 *
 * - {@link validatePack} (in `validate.ts`) owns the structural rules from
 *   `内容包规范.md` §3/§4 that need only the file list and the parsed JSON.
 * - this module owns everything that needs the *contents*: persona excerpts,
 *   host fallback, phase notes and the waveform assets.
 *
 * The split follows `M2-实施计划.md` §4.6.2, whose `validatePack` input has no
 * waveform bytes or text fields. Errors are never downgraded to warnings: a
 * pack that breaks a rule is refused and the previously active pack stays.
 *
 * `ScenarioDefinition.feedbackIntents` reuses `FeedbackIntent` from
 * `scenario/intents.ts` — the resolver already owns that shape, and the loader
 * normalizes an omitted `regions` list to the documented `["whole-body"]`
 * default so downstream code can rely on the property existing.
 */

import type { ContentSource } from '../ports/content-source.ts'
import type { Waveform } from '../waveform/types.ts'
import type { WaveformSegment } from '../waveform/dsl.ts'
import { compileWaveformScript } from '../waveform/dsl.ts'
import { parseHexFrames } from '../waveform/hex.ts'
import { createBuiltinWaveforms } from '../waveform/builtin.ts'
import { ENGINE_VERSION } from '../version.ts'
import type { FeedbackIntent } from './intents.ts'
import { pathProblem, validatePack, type ValidationIssue } from './validate.ts'

/** Manifest file name at the pack root. */
export const PACK_MANIFEST_FILE = 'pack.json'
/** The character sheet every pack must ship. */
export const PACK_PERSONA_FILE = 'persona.md'
/** Optional scenario graph; required when `mode` is `scenario`. */
export const PACK_SCENARIO_FILE = 'scenario.json'

export type PackMode = 'freeform' | 'scenario'
export type PackRating = 'all' | '18+'

/** Same union `memory/ledger.ts` will export; kept structural here. */
export type PackSessionEndReason = 'completed' | 'left_early' | 'paused' | 'panic' | 'stop' | 'unexpected_exit'

/** `pack.aftercare` is text only — the duration lives in `scenario.session.aftercareMin` (S12). */
export interface PackAftercare {
  readonly text?: string
}

export interface PackHistory {
  readonly read: boolean
  readonly windowHours?: number
  readonly lastN?: number
}

export interface MetaReactionWhen {
  readonly endReason?: readonly PackSessionEndReason[]
  readonly aftercare?: boolean
}

export interface MetaReactionOpening {
  readonly tone?: string
  readonly firstIntent?: string
}

/**
 * Cross-session reaction rule. Only injected into the opening brief; M2 has no
 * NPC behaviour machine (`M2-实施计划.md` §8.4).
 */
export interface MetaReaction {
  readonly when: MetaReactionWhen
  readonly opening: MetaReactionOpening
}

/** `pack.json`, per `内容包规范.md` §3. */
export interface PackManifest {
  /** `^[a-z0-9][a-z0-9-]*$` */
  readonly id: string
  readonly name: string
  /** Plain semver triple. */
  readonly version: string
  /** Engine range, e.g. `">=0.2 <1.0"`; compared against `ENGINE_VERSION`. */
  readonly engine: string
  readonly mode: PackMode
  readonly rating: PackRating
  readonly language?: string
  readonly author?: string
  readonly homepage?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly license?: string
  /** Hard content constraints; injected first into prompts. */
  readonly boundaries?: readonly string[]
  readonly aftercare?: PackAftercare
  readonly history?: PackHistory
  readonly metaReactions?: readonly MetaReaction[]
  /** Engine capabilities the pack relies on; unsupported ones only warn. */
  readonly requires?: readonly string[]
}

export interface ScenarioRegion {
  readonly id: string
  readonly label: string
}

export interface ScenarioPhase {
  readonly id: string
  readonly goal: string
  readonly advanceWhen?: string
  /** Empty list = terminal phase. */
  readonly next: readonly string[]
}

export interface ScenarioPhaseWindow {
  readonly phase: string
  readonly from: number
  readonly to: number
}

export interface ScenarioSession {
  /** `null` = open-ended. */
  readonly plannedMinutes: number | null
  readonly phaseWindows: readonly ScenarioPhaseWindow[]
  /** Shortest aftercare duration in minutes; the only duration source (S12). */
  readonly aftercareMin: number
}

/**
 * `scenario.json` — the single scenario schema of the project (`内容包规范.md` §4, D5).
 *
 * `opening` / `npcs` / `secrets` are optional legacy fields kept for writing
 * prompts only; M2 implements no behaviour for them.
 */
export interface ScenarioDefinition {
  /** Optional file reference; missing file warns and falls back to the engine host (S31). */
  readonly host?: string
  readonly session: ScenarioSession
  readonly regions: readonly ScenarioRegion[]
  readonly phases: readonly ScenarioPhase[]
  readonly feedbackIntents: readonly FeedbackIntent[]
  /** Ignored in `scenario.json`; the only source is `pack.json` (S12). */
  readonly boundaries?: readonly string[]
  readonly opening?: string
  readonly npcs?: readonly { readonly id: string; readonly name?: string; readonly goals?: readonly string[]; readonly escalation?: readonly string[] }[]
  readonly secrets?: readonly string[]
}

export interface LoadedPack {
  readonly manifest: PackManifest
  /** Required, non-empty; used in full by the writer. */
  readonly persona: string
  /** Custom host text; undefined = engine default host. */
  readonly host?: string
  readonly setting?: string
  readonly corpus?: string
  /** `phases/<id>.md` for phases that ship a note. */
  readonly phaseNotes: ReadonlyMap<string, string>
  /** Present iff `mode === 'scenario'`. */
  readonly scenario?: ScenarioDefinition
  /** Validated pack waveforms, ids already namespaced as `<packId>:<waveId>`. */
  readonly waveforms: readonly Waveform[]
  /**
   * Resolve a `suggest.waveform`-style reference to the waveform it means.
   *
   * The resolution rules are exactly the ones validation accepts, so
   * "`validatePack` passed" implies "the runtime can resolve it" (S5):
   * - `builtin:<id>` → the engine's builtin waveform library;
   * - `<packId>:<id>` → this pack's namespaced asset;
   * - bare `<id>` → this pack's `<packId>:<id>`.
   *
   * Unresolvable references return `undefined`; execution then falls back to a
   * default waveform and keeps playing (`内容包规范.md` §4.5).
   */
  readonly resolveWaveform: (reference: string) => Waveform | undefined
  /** Non-blocking problems the UI/author should see, in deterministic order. */
  readonly warnings: readonly string[]
}

export interface LoadPackOptions {
  /** Defaults to `ENGINE_VERSION`; tests override it to exercise ranges. */
  readonly engineVersion?: string
}

/**
 * A pack that cannot be loaded.
 *
 * Always names the offending file (plus the JSON path when it has one) so the
 * import UI can point an author at the line that broke.
 */
export class ContentPackError extends Error {
  /** File that triggered the failure, POSIX relative to the pack root. */
  readonly file: string
  /** JSON path inside that file (`phases[0].next`), or `.`. */
  readonly path: string
  readonly issues: readonly ValidationIssue[]

  constructor(input: { readonly file: string; readonly path: string; readonly message: string; readonly issues?: readonly ValidationIssue[] }) {
    super(`content pack error in "${input.file}" (${input.path}): ${input.message}`)
    this.name = 'ContentPackError'
    this.file = input.file
    this.path = input.path
    this.issues = input.issues ?? []
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toIssue(file: string, path: string, rule: string, severity: 'error' | 'warning', message: string): ValidationIssue {
  return { file, path, rule, severity, message }
}

/** Report a parse failure instead of throwing: callers decide if the file matters. */
async function tryReadJson(
  source: ContentSource,
  file: string,
  issues: ValidationIssue[],
  rule: string,
): Promise<unknown | undefined> {
  let text: string
  try {
    text = await source.readText(file)
  } catch (error) {
    issues.push(toIssue(file, '.', rule, 'error', `could not read file: ${describe(error)}`))
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    issues.push(toIssue(file, '.', rule, 'error', `invalid JSON: ${describe(error)}`))
    return undefined
  }
}

async function readTextOrThrow(source: ContentSource, file: string): Promise<string> {
  try {
    return await source.readText(file)
  } catch (error) {
    throw new ContentPackError({ file, path: '.', message: `could not read file: ${describe(error)}` })
  }
}

function isSafeWaveformId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
}

interface ParsedWaveform {
  readonly localId: string
  readonly waveform: Waveform
}

/**
 * Turn one `waveforms/*.json` asset into a `Waveform`.
 *
 * Two shapes are accepted (`内容包规范.md` §4.5): `{ frames: [hex…] }` and
 * `{ segments: [dsl…] }`. Both reuse the existing waveform parsers, so the
 * bounds (freq 10-240, intensity 0-100, 1-600 frames, 100 ms multiples, at
 * least one non-zero intensity) are enforced by the same code the authoring
 * tools use.
 */
function parseWaveformAsset(file: string, raw: unknown, issues: ValidationIssue[]): ParsedWaveform | undefined {
  if (!isRecord(raw)) {
    issues.push(toIssue(file, '.', 'waveform.shape', 'error', 'a waveform asset must be a JSON object'))
    return undefined
  }
  const declaredId = typeof raw['id'] === 'string' ? raw['id'].trim() : ''
  const fileId = file.split('/').pop()?.replace(/\.json$/u, '') ?? ''
  const localId = declaredId.length > 0 ? declaredId : fileId
  if (!isSafeWaveformId(localId)) {
    issues.push(toIssue(file, 'id', 'waveform.id', 'error', `waveform id "${localId}" must be a non-empty slug ([A-Za-z0-9._-])`))
    return undefined
  }
  const name = typeof raw['name'] === 'string' && raw['name'].trim().length > 0 ? raw['name'].trim() : localId
  const loop = typeof raw['loop'] === 'boolean' ? raw['loop'] : true
  const tags: string[] = []
  if (Array.isArray(raw['tags'])) {
    for (const tag of raw['tags']) {
      if (typeof tag === 'string' && tag.trim().length > 0 && !tags.includes(tag.trim())) tags.push(tag.trim())
    }
  }
  // `sensation` is the writer-facing feeling label ("细密/潮汐/凌厉", or a full
  // sentence in the packs end users actually import); the core `Waveform` has no
  // separate field for it, so it travels as a tag. It is appended **after** the
  // waveform compiler's tag validation, because the 1–24 character cap is for
  // author keywords: feeding a long sensation through that check made a perfectly
  // valid pack fail import with the misleading error
  // `each tag must be 1-24 characters` on `segments` (real packs:
  // mech-restraint / succubus-abyss, 2026-11-04). There is no length cap here —
  // the author's prose is what the writer is meant to read.
  const sensation = typeof raw['sensation'] === 'string' ? raw['sensation'].trim() : ''
  const withSensation = (base: readonly string[]): string[] => {
    if (sensation.length === 0) return [...base]
    return base.includes(sensation) ? [...base] : [...base, sensation]
  }

  const framesField = raw['frames']
  if (Array.isArray(framesField)) {
    const hexFrames: string[] = []
    for (const [index, frame] of framesField.entries()) {
      if (typeof frame !== 'string') {
        issues.push(toIssue(file, `frames[${index}]`, 'waveform.frames', 'error', 'every frame must be a hex string'))
        return undefined
      }
      hexFrames.push(frame)
    }
    try {
      const frames = parseHexFrames(hexFrames)
      const produces = frames.some(frame => frame.intensity.some(slot => slot > 0))
      if (!produces) {
        issues.push(toIssue(file, 'frames', 'waveform.output', 'error', 'this waveform never produces output; at least one intensity slot must be above 0'))
        return undefined
      }
      return { localId, waveform: { id: localId, name, frames, loop, source: 'imported', tags: withSensation(tags) } }
    } catch (error) {
      // The parser names the offending frame and slot; keep that text.
      issues.push(toIssue(file, 'frames', 'waveform.bounds', 'error', describe(error)))
      return undefined
    }
  }

  const segmentsField = raw['segments']
  if (Array.isArray(segmentsField)) {
    try {
      const compiled = compileWaveformScript({ name, loop, tags, segments: segmentsField as readonly WaveformSegment[] })
      return { localId, waveform: { id: localId, name: compiled.name, frames: compiled.frames, loop: compiled.loop, source: 'imported', tags: withSensation(compiled.tags) } }
    } catch (error) {
      issues.push(toIssue(file, 'segments', 'waveform.bounds', 'error', describe(error)))
      return undefined
    }
  }

  issues.push(toIssue(file, '.', 'waveform.shape', 'error', 'a waveform asset needs a "frames" or "segments" array'))
  return undefined
}

/** Load and validate every `waveforms/<name>.json` asset. */
async function loadWaveforms(
  source: ContentSource,
  files: readonly string[],
  issues: ValidationIssue[],
  warnings: string[],
): Promise<{ readonly waveforms: readonly Waveform[] }> {
  const assetFiles = files.filter(file => file.startsWith('waveforms/') && file.endsWith('.json'))
  if (assetFiles.includes('waveforms/index.json')) {
    warnings.push(
      'waveforms/index.json: the frozen spec does not define its schema, so M2 discovers waveform definitions by scanning waveforms/*.json and ignores index.json',
    )
  }
  const parsed: ParsedWaveform[] = []
  const seen = new Set<string>()
  for (const file of assetFiles) {
    if (file === 'waveforms/index.json') continue
    const raw = await tryReadJson(source, file, issues, 'waveform.json')
    if (raw === undefined) continue
    const candidate = parseWaveformAsset(file, raw, issues)
    if (candidate === undefined) continue
    if (seen.has(candidate.localId)) {
      issues.push(toIssue(file, 'id', 'waveform.duplicate', 'error', `duplicate waveform id "${candidate.localId}"`))
      continue
    }
    seen.add(candidate.localId)
    parsed.push(candidate)
  }
  return { waveforms: parsed.map(entry => entry.waveform) }
}

/** Waveforms shipped by the engine, indexed by their unprefixed id. */
function builtinWaveformIndex(): ReadonlyMap<string, Waveform> {
  return new Map(createBuiltinWaveforms().map(waveform => [waveform.id, waveform]))
}

interface WaveformResolution {
  /** Pack waveforms with the `<packId>:` namespace applied (fixed at load). */
  readonly waveforms: readonly Waveform[]
  /**
   * Single source of truth for `suggest.waveform` resolution (S5). Validation
   * and the returned {@link LoadedPack.resolveWaveform} both go through it, so
   * the two can never disagree.
   */
  readonly resolveWaveform: (reference: string) => Waveform | undefined
}

function createWaveformResolution(packId: string, localWaveforms: readonly Waveform[]): WaveformResolution {
  const prefix = `${packId}:`
  const waveforms = localWaveforms.map(waveform => ({ ...waveform, id: `${prefix}${waveform.id}` }))
  const packIndex = new Map(waveforms.map(waveform => [waveform.id, waveform]))
  const builtins = builtinWaveformIndex()
  const resolveWaveform = (reference: string): Waveform | undefined => {
    if (typeof reference !== 'string') return undefined
    const trimmed = reference.trim()
    if (trimmed.length === 0) return undefined
    if (trimmed.startsWith('builtin:')) {
      const id = trimmed.slice('builtin:'.length)
      return id.length === 0 ? undefined : builtins.get(id)
    }
    if (trimmed.startsWith(prefix)) return packIndex.get(trimmed)
    return packIndex.get(`${prefix}${trimmed}`)
  }
  return { waveforms, resolveWaveform }
}

/**
 * Warn about `suggest.waveform` references that cannot resolve; execution falls
 * back to a default waveform and keeps playing (`内容包规范.md` §4.5).
 *
 * This deliberately calls the same resolver the runtime gets, so a reference
 * that passes validation is guaranteed to resolve (S5).
 */
function checkWaveformReferences(
  scenario: ScenarioDefinition | undefined,
  resolveWaveform: (reference: string) => Waveform | undefined,
  warnings: string[],
): void {
  if (scenario === undefined) return
  const intents = Array.isArray(scenario.feedbackIntents) ? scenario.feedbackIntents : []
  for (const intent of intents) {
    // Structurally broken entries are reported by `validatePack`; this pass
    // must not throw a raw TypeError on them (review blocker B1).
    if (typeof intent !== 'object' || intent === null) continue
    const reference = intent.suggest?.waveform
    if (reference === undefined) continue
    if (typeof reference !== 'string') continue
    if (resolveWaveform(reference) !== undefined) continue
    warnings.push(
      `scenario.json: feedbackIntents "${intent.id}": suggest.waveform "${reference}" is neither a pack waveform (bare or "<packId>:<id>") nor a builtin "builtin:<id>"; execution falls back to a default waveform`,
    )
  }
}

/**
 * Fill the documented defaults for an omitted scenario field.
 *
 * - `intent.regions` omitted → `["whole-body"]` (S15 ladder step 0).
 * - `regions` omitted → `[]` (v6: recommendations are optional; the session's
 *   player-named parts are unioned in by the host at play time).
 */
function normalizeScenario(scenario: ScenarioDefinition): ScenarioDefinition {
  const intents = Array.isArray(scenario.feedbackIntents) ? scenario.feedbackIntents : []
  const feedbackIntents = intents.map(intent => (typeof intent === 'object' && intent !== null
    ? { ...intent, regions: intent.regions ?? ['whole-body'] }
    : intent))
  const regions = Array.isArray(scenario.regions) ? scenario.regions : []
  return { ...scenario, regions, feedbackIntents }
}

function personaIssues(persona: string): readonly ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (persona.trim().length === 0) {
    // The file passed the size check (it has bytes) but carries no character.
    issues.push(toIssue(PACK_PERSONA_FILE, '.', 'persona.empty', 'error', 'persona.md is empty; a pack must describe a character'))
  }
  if (!/^##\s*导演摘要\s*$/mu.test(persona)) {
    issues.push(
      toIssue(
        PACK_PERSONA_FILE,
        '## 导演摘要',
        'persona.director-summary',
        'warning',
        'persona.md has no "## 导演摘要" section; the director falls back to the first 200 characters',
      ),
    )
  }
  return issues
}

/**
 * Load a content pack.
 *
 * @throws {ContentPackError} when a required file is missing, JSON is invalid,
 *   or any validation rule fails. Only errors block; warnings ride along on
 *   the returned pack.
 */
export async function loadPack(source: ContentSource, options: LoadPackOptions = {}): Promise<LoadedPack> {
  const engineVersion = options.engineVersion ?? ENGINE_VERSION
  const listed = await source.list()
  const files = [...listed].sort()
  // Reject unsafe paths before the first stat/read (review blocker B2): the
  // ContentSource maps these strings onto a real directory on the host, so a
  // ".." segment must never reach it, and the error must name the file.
  for (const file of files) {
    const problem = pathProblem(file)
    if (problem !== undefined) {
      throw new ContentPackError({ file, path: '.', message: `unsafe path: ${problem}` })
    }
  }
  const sizes = new Map<string, number>()
  for (const file of files) {
    try {
      sizes.set(file, await source.byteSize(file))
    } catch (error) {
      throw new ContentPackError({ file, path: '.', message: `could not stat file: ${describe(error)}` })
    }
  }

  if (!sizes.has(PACK_MANIFEST_FILE)) {
    throw new ContentPackError({ file: PACK_MANIFEST_FILE, path: '.', message: 'required manifest is missing' })
  }
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(await readTextOrThrow(source, PACK_MANIFEST_FILE)) as unknown
  } catch (error) {
    if (error instanceof ContentPackError) throw error
    throw new ContentPackError({ file: PACK_MANIFEST_FILE, path: '.', message: `invalid JSON: ${describe(error)}` })
  }
  if (!isRecord(rawManifest)) {
    throw new ContentPackError({ file: PACK_MANIFEST_FILE, path: '.', message: 'pack.json must contain a JSON object' })
  }
  const manifest = rawManifest as unknown as PackManifest
  const rawMode = rawManifest['mode']
  const manifestId = typeof rawManifest['id'] === 'string' ? rawManifest['id'] : 'pack'

  const issues: ValidationIssue[] = []
  const loaderWarnings: string[] = []

  // scenario.json is only meaningful (and only parsed) for scenario packs; a
  // freeform pack that ships one gets a warning instead of a hard failure, so
  // switching a pack's mode never bricks it.
  let scenario: ScenarioDefinition | undefined
  if (rawMode === 'scenario' && sizes.has(PACK_SCENARIO_FILE)) {
    const rawScenario = await tryReadJson(source, PACK_SCENARIO_FILE, issues, 'scenario.json')
    if (rawScenario !== undefined) {
      if (!isRecord(rawScenario)) {
        issues.push(toIssue(PACK_SCENARIO_FILE, '.', 'scenario.shape', 'error', 'scenario.json must contain a JSON object'))
      } else {
        scenario = rawScenario as unknown as ScenarioDefinition
      }
    }
  }

  const persona = sizes.has(PACK_PERSONA_FILE) ? await readTextOrThrow(source, PACK_PERSONA_FILE) : ''

  // Structurally broken entries must be reported, never dereferenced: a raw
  // TypeError here would escape the ContentPackError contract (review B1).
  if (scenario !== undefined) {
    const rawIntents: unknown = (scenario as { feedbackIntents?: unknown }).feedbackIntents
    if (Array.isArray(rawIntents)) {
      rawIntents.forEach((intent, index) => {
        if (typeof intent !== 'object' || intent === null) {
          issues.push(toIssue(
            PACK_SCENARIO_FILE,
            `feedbackIntents[${index}]`,
            'intent.shape',
            'error',
            'feedbackIntents entries must be objects',
          ))
        }
      })
    }
  }

  issues.push(...validatePack({ manifest, files, sizes, ...(scenario === undefined ? {} : { scenario }), engineVersion }))
  issues.push(...personaIssues(persona))
  if (rawMode === 'freeform' && sizes.has(PACK_SCENARIO_FILE)) {
    loaderWarnings.push(`${PACK_SCENARIO_FILE}: present but mode is "freeform"; ignored`)
  }

  const waveformResult = await loadWaveforms(source, files, issues, loaderWarnings)
  // Namespace pack waveform ids once; the same resolver object backs both the
  // validation warning pass and `LoadedPack.resolveWaveform` (S5).
  const waveformResolution = createWaveformResolution(manifestId, waveformResult.waveforms)

  // Phase notes: a missing note is a warning, not a failure (`内容包规范.md` §8).
  // The graph is re-read defensively: this runs before the validation errors
  // are thrown, so `phases` may still be structurally wrong.
  const phaseNotes = new Map<string, string>()
  if (scenario !== undefined) {
    const declaredPhases = Array.isArray(scenario.phases) ? scenario.phases : []
    for (const phase of declaredPhases) {
      if (typeof phase?.id !== 'string' || phase.id.length === 0) continue
      const noteFile = `phases/${phase.id}.md`
      if (sizes.has(noteFile)) phaseNotes.set(phase.id, await readTextOrThrow(source, noteFile))
    }
    checkWaveformReferences(scenario, waveformResolution.resolveWaveform, loaderWarnings)
  }

  const warnings = [
    ...issues.filter(issue => issue.severity === 'warning').map(issue => `${issue.file}: ${issue.message}`),
    ...loaderWarnings,
  ]
  const errors = issues.filter(issue => issue.severity === 'error')
  if (errors.length > 0) {
    const first = errors[0]!
    const more = errors.length > 1 ? ` (${errors.length - 1} more validation issue(s))` : ''
    throw new ContentPackError({
      file: first.file,
      path: first.path,
      message: `${first.message}${more}`,
      issues: errors,
    })
  }

  const normalizedScenario = scenario === undefined ? undefined : normalizeScenario(scenario)
  let host: string | undefined
  const hostReference = normalizedScenario?.host
  if (hostReference !== undefined && sizes.has(hostReference)) {
    host = await readTextOrThrow(source, hostReference)
  } else if (sizes.has('host.md')) {
    host = await readTextOrThrow(source, 'host.md')
  }

  const setting = sizes.has('setting.md') ? await readTextOrThrow(source, 'setting.md') : undefined
  const corpus = sizes.has('corpus.md') ? await readTextOrThrow(source, 'corpus.md') : undefined

  // Conditional spreads keep absent optional properties absent under
  // `exactOptionalPropertyTypes`.
  return {
    manifest,
    persona,
    phaseNotes,
    waveforms: waveformResolution.waveforms,
    resolveWaveform: waveformResolution.resolveWaveform,
    warnings,
    ...(normalizedScenario === undefined ? {} : { scenario: normalizedScenario }),
    ...(host === undefined ? {} : { host }),
    ...(setting === undefined ? {} : { setting }),
    ...(corpus === undefined ? {} : { corpus }),
  }
}
