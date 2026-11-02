/**
 * Content-pack validation.
 *
 * Pure, synchronous structural validation of an already-parsed pack. The rules
 * come from `内容包规范.md` §3/§4/§8 plus the supplementary table in
 * `M2-实施计划.md` §4.6; each issue carries the file, the JSON path and a
 * stable rule id so the import UI can point at the exact line and tests can
 * assert on the rule instead of on prose.
 *
 * Anything that would make a session ambiguous or unsafe at load time is an
 * `error` (the pack is refused). Forward-compatibility and writer-facing
 * problems are `warning`s: an unknown field, an empty `boundaries` list, a
 * missing phase note, a `host` file that does not exist, or a `metaReactions`
 * entry that names an intent the pack does not define. Warnings never block —
 * they degrade to documented defaults.
 *
 * Content that is not in the JSON — persona text, waveform assets — is checked
 * by `loader.ts`, because this function's input contract (`M2-实施计划.md`
 * §4.6.2) deliberately only carries the manifest, the file list and the
 * scenario definition.
 */

import type { PackManifest, ScenarioDefinition } from './loader.ts'
import { isValidVersion, satisfiesVersion } from './semver.ts'

/**
 * The resolver's wildcard region. Duplicated as a literal (instead of importing
 * `beat-plan.ts`) to keep this pure validator free of that module's cycle with
 * `intents.ts`; it must stay equal to `WHOLE_BODY_REGION`.
 */
const WHOLE_BODY_REGION = 'whole-body'

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationIssue {
  /** Pack-relative POSIX path the issue belongs to. */
  readonly file: string
  /** JSON path inside that file (`session.plannedMinutes`), or `.`. */
  readonly path: string
  /** Stable dotted rule id, e.g. `phases.no-terminal`. */
  readonly rule: string
  readonly severity: ValidationSeverity
  readonly message: string
}

export interface ValidatePackInput {
  readonly manifest: PackManifest
  readonly files: readonly string[]
  readonly sizes: ReadonlyMap<string, number>
  readonly scenario?: ScenarioDefinition
  readonly engineVersion: string
}

/** `50MB` total pack size limit from `内容包规范.md` §3. */
export const MAX_PACK_BYTES = 50 * 1024 * 1024

const MANIFEST_FILE = 'pack.json'
const PERSONA_FILE = 'persona.md'
const SCENARIO_FILE = 'scenario.json'
const MAX_PATH_DEPTH = 3

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const INTENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const REGION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u
const PHASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u
const ALLOWED_EXTENSION = /\.(md|json|png|jpg|webp)$/iu
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DRIVE_PREFIX = /^[A-Za-z]:/u

const MODES = new Set(['freeform', 'scenario'])
const RATINGS = new Set(['all', '18+'])
const ENVELOPE_PRESETS = new Set(['steady', 'pulse', 'wave', 'random', 'ramp'])
const STRENGTHS = new Set(['low', 'med', 'high'])
const DISTRIBUTIONS = new Set(['synced', 'primary', 'round-robin'])
const SESSION_END_REASONS = new Set(['completed', 'left_early', 'paused', 'panic', 'stop', 'unexpected_exit'])
/** Engine capabilities M2 understands; everything else only warns. */
const SUPPORTED_CAPABILITIES = new Set(['region', 'waveform'])
const KNOWN_MANIFEST_KEYS = new Set([
  'id', 'name', 'version', 'engine', 'mode', 'rating', 'language', 'author', 'homepage',
  'description', 'tags', 'license', 'boundaries', 'aftercare', 'history', 'metaReactions', 'requires',
])
const KNOWN_SCENARIO_KEYS = new Set([
  'host', 'session', 'regions', 'phases', 'feedbackIntents', 'boundaries', 'opening', 'npcs', 'secrets', 'aftercare',
])

type Rec = Readonly<Record<string, unknown>>

function asRecord(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface Context {
  readonly files: ReadonlySet<string>
  readonly sizes: ReadonlyMap<string, number>
  readonly issues: ValidationIssue[]
}

function error(ctx: Context, file: string, path: string, rule: string, message: string): void {
  ctx.issues.push({ file, path, rule, severity: 'error', message })
}

function warn(ctx: Context, file: string, path: string, rule: string, message: string): void {
  ctx.issues.push({ file, path, rule, severity: 'warning', message })
}

/**
 * Structural path problem, or `undefined` when the path is safe.
 *
 * Exported so `loadPack` can reject unsafe paths *before* it asks the
 * {@link import('../ports/content-source.ts').ContentSource} for any bytes: a
 * `..` segment must never reach a host that maps paths onto a real directory.
 */
export function pathProblem(path: string): string | undefined {
  if (path.length === 0) return 'empty path'
  if (path.startsWith('/')) return 'absolute paths are not allowed'
  if (DRIVE_PREFIX.test(path)) return 'absolute paths are not allowed'
  if (path.includes('\\')) return 'use POSIX separators ("/") inside a pack'
  if (CONTROL_CHARACTER.test(path)) return 'control characters are not allowed in file names'
  const segments = path.split('/')
  if (segments.length > MAX_PATH_DEPTH) return `directory depth exceeds ${MAX_PATH_DEPTH}`
  for (const segment of segments) {
    if (segment.length === 0) return 'empty path segment'
    if (segment === '.' || segment === '..') return '".." and "." segments are not allowed'
  }
  return undefined
}

function requireStringField(
  ctx: Context,
  raw: Rec,
  file: string,
  key: string,
  path: string,
  rule: string,
  label: string,
): string | undefined {
  const value = raw[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    error(ctx, file, path, rule, `${label} is required and must be a non-empty string`)
    return undefined
  }
  return value
}

function optionalString(ctx: Context, raw: Rec, file: string, key: string, path: string, rule: string): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    error(ctx, file, path, rule, `"${key}" must be a string when present`)
    return undefined
  }
  return value
}

function unknownKeys(ctx: Context, raw: Rec, known: ReadonlySet<string>, file: string, prefix: string, rule: string): void {
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      const path = prefix.length === 0 ? key : `${prefix}.${key}`
      warn(ctx, file, path, rule, `unknown field "${key}" is ignored (forward compatibility)`)
    }
  }
}

// ---------------------------------------------------------------------------
// pack.json
// ---------------------------------------------------------------------------

interface MetaReactionRef {
  readonly index: number
  readonly firstIntent: string
}

function validateManifest(
  ctx: Context,
  manifest: PackManifest,
  engineVersion: string,
): { readonly metaReactionRefs: readonly MetaReactionRef[]; readonly mode: string | undefined } {
  const raw = manifest as unknown as Rec
  const file = MANIFEST_FILE
  const metaReactionRefs: MetaReactionRef[] = []
  unknownKeys(ctx, raw, KNOWN_MANIFEST_KEYS, file, '', 'manifest.unknown-field')

  const id = requireStringField(ctx, raw, file, 'id', 'id', 'manifest.id', '"id"')
  if (id !== undefined && !ID_PATTERN.test(id)) {
    error(ctx, file, 'id', 'manifest.id', `"${id}" is not a valid pack id; use lowercase letters, digits and dashes`)
  }
  requireStringField(ctx, raw, file, 'name', 'name', 'manifest.name', '"name"')

  const version = optionalString(ctx, raw, file, 'version', 'version', 'manifest.version')
  if (version !== undefined && !isValidVersion(version)) {
    error(ctx, file, 'version', 'manifest.version', `"${version}" is not a semver version (expected x.y.z)`)
  }
  if (version === undefined && raw['version'] === undefined) {
    error(ctx, file, 'version', 'manifest.version', '"version" is required')
  }

  const engine = optionalString(ctx, raw, file, 'engine', 'engine', 'manifest.engine')
  if (engine === undefined && raw['engine'] === undefined) {
    error(ctx, file, 'engine', 'manifest.engine', '"engine" is required')
  } else if (engine !== undefined) {
    try {
      if (!satisfiesVersion(engine, engineVersion)) {
        error(ctx, file, 'engine', 'manifest.engine', `engine range "${engine}" does not accept ENGINE_VERSION ${engineVersion}; the pack needs a newer engine`)
      }
    } catch (failure) {
      error(ctx, file, 'engine', 'manifest.engine', `engine range "${engine}" is not supported: ${(failure as Error).message}`)
    }
  }

  const mode = raw['mode']
  if (mode === undefined) {
    error(ctx, file, 'mode', 'manifest.mode', '"mode" is required (freeform | scenario)')
  } else if (typeof mode !== 'string' || !MODES.has(mode)) {
    error(ctx, file, 'mode', 'manifest.mode', `"mode" must be "freeform" or "scenario"`)
  }
  const rating = raw['rating']
  if (rating === undefined) {
    error(ctx, file, 'rating', 'manifest.rating', '"rating" is required (all | 18+)')
  } else if (typeof rating !== 'string' || !RATINGS.has(rating)) {
    error(ctx, file, 'rating', 'manifest.rating', `"rating" must be "all" or "18+"`)
  }

  for (const key of ['language', 'author', 'homepage', 'description', 'license'] as const) {
    optionalString(ctx, raw, file, key, key, 'manifest.field')
  }
  if (raw['tags'] !== undefined && !isStringArray(raw['tags'])) {
    error(ctx, file, 'tags', 'manifest.field', '"tags" must be an array of strings')
  }

  const boundaries = raw['boundaries']
  if (boundaries !== undefined) {
    if (!isStringArray(boundaries)) {
      error(ctx, file, 'boundaries', 'manifest.boundaries', '"boundaries" must be an array of strings')
    } else if (boundaries.length === 0) {
      warn(ctx, file, 'boundaries', 'manifest.boundaries', 'no boundaries declared; global boundaries still apply')
    }
  } else {
    warn(ctx, file, 'boundaries', 'manifest.boundaries', 'no boundaries declared; global boundaries still apply')
  }

  const aftercare = raw['aftercare']
  if (aftercare !== undefined) {
    const record = asRecord(aftercare)
    if (record === undefined) {
      error(ctx, file, 'aftercare', 'manifest.aftercare', '"aftercare" must be an object')
    } else {
      for (const key of Object.keys(record)) {
        if (key === 'text') {
          if (typeof record['text'] !== 'string' || record['text'].trim().length === 0) {
            error(ctx, file, 'aftercare.text', 'manifest.aftercare', '"aftercare.text" must be a non-empty string')
          }
        } else if (key === 'minMinutes') {
          // S12: duration moved to scenario.session.aftercareMin.
          warn(ctx, file, 'aftercare.minMinutes', 'manifest.aftercare', '"aftercare.minMinutes" was removed by S12 and is ignored; the duration comes from scenario.session.aftercareMin')
        } else {
          warn(ctx, file, `aftercare.${key}`, 'manifest.aftercare', `unknown aftercare field "${key}" is ignored`)
        }
      }
    }
  }

  const history = raw['history']
  if (history !== undefined) {
    const record = asRecord(history)
    if (record === undefined) {
      error(ctx, file, 'history', 'manifest.history', '"history" must be an object')
    } else {
      if (typeof record['read'] !== 'boolean') {
        error(ctx, file, 'history.read', 'manifest.history', '"history.read" is required and must be a boolean')
      }
      if (record['windowHours'] !== undefined && (!isFiniteNumber(record['windowHours']) || record['windowHours'] <= 0)) {
        error(ctx, file, 'history.windowHours', 'manifest.history', '"history.windowHours" must be a positive number')
      }
      if (record['lastN'] !== undefined && (!Number.isSafeInteger(record['lastN']) || (record['lastN'] as number) < 1)) {
        error(ctx, file, 'history.lastN', 'manifest.history', '"history.lastN" must be a positive integer')
      }
      unknownKeys(ctx, record, new Set(['read', 'windowHours', 'lastN']), file, 'history', 'manifest.history')
    }
  }

  const metaReactions = raw['metaReactions']
  if (metaReactions !== undefined) {
    if (!Array.isArray(metaReactions)) {
      error(ctx, file, 'metaReactions', 'manifest.metaReactions', '"metaReactions" must be an array')
    } else {
      for (const [index, item] of metaReactions.entries()) {
        const base = `metaReactions[${index}]`
        const record = asRecord(item)
        if (record === undefined) {
          error(ctx, file, base, 'manifest.metaReactions', 'each meta reaction must be an object')
          continue
        }
        unknownKeys(ctx, record, new Set(['when', 'opening']), file, base, 'manifest.metaReactions')
        const when = asRecord(record['when'])
        if (when === undefined) {
          error(ctx, file, `${base}.when`, 'manifest.metaReactions', '"when" is required and must be an object')
        } else {
          unknownKeys(ctx, when, new Set(['endReason', 'aftercare']), file, `${base}.when`, 'manifest.metaReactions')
          const endReason = when['endReason']
          if (endReason !== undefined) {
            if (!Array.isArray(endReason) || endReason.length === 0) {
              error(ctx, file, `${base}.when.endReason`, 'manifest.metaReactions', '"endReason" must be a non-empty array of session end reasons')
            } else {
              for (const reason of endReason) {
                if (typeof reason !== 'string' || !SESSION_END_REASONS.has(reason)) {
                  error(ctx, file, `${base}.when.endReason`, 'manifest.metaReactions', `unknown session end reason "${String(reason)}"`)
                }
              }
            }
          }
          if (when['aftercare'] !== undefined && typeof when['aftercare'] !== 'boolean') {
            error(ctx, file, `${base}.when.aftercare`, 'manifest.metaReactions', '"aftercare" must be a boolean')
          }
        }
        const opening = asRecord(record['opening'])
        if (opening === undefined) {
          error(ctx, file, `${base}.opening`, 'manifest.metaReactions', '"opening" is required and must be an object')
        } else {
          unknownKeys(ctx, opening, new Set(['tone', 'firstIntent']), file, `${base}.opening`, 'manifest.metaReactions')
          for (const key of ['tone', 'firstIntent'] as const) {
            const value = opening[key]
            if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
              error(ctx, file, `${base}.opening.${key}`, 'manifest.metaReactions', `"${key}" must be a non-empty string`)
            }
          }
          if (typeof opening['firstIntent'] === 'string' && opening['firstIntent'].trim().length > 0) {
            metaReactionRefs.push({ index, firstIntent: opening['firstIntent'] })
          }
        }
      }
    }
  }

  const requires = raw['requires']
  if (requires !== undefined) {
    if (!isStringArray(requires)) {
      error(ctx, file, 'requires', 'manifest.requires', '"requires" must be an array of capability names')
    } else {
      for (const capability of requires) {
        if (!SUPPORTED_CAPABILITIES.has(capability)) {
          warn(ctx, file, 'requires', 'manifest.requires', `capability "${capability}" is not implemented in M2 and will be ignored (hr arrives in M2-C)`)
        }
      }
    }
  }

  return { metaReactionRefs, mode: typeof mode === 'string' ? mode : undefined }
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function validateFiles(ctx: Context, mode: string | undefined): void {
  const seen = new Set<string>()
  let totalBytes = 0
  for (const file of ctx.files) {
    const problem = pathProblem(file)
    if (problem !== undefined) {
      error(ctx, file, '.', 'files.path', problem)
    }
    if (seen.has(file)) {
      error(ctx, file, '.', 'files.duplicate', 'duplicate file path in the listing')
      continue
    }
    seen.add(file)
    if (!ALLOWED_EXTENSION.test(file)) {
      error(ctx, file, '.', 'files.extension', 'file type is not allowed; packs may contain .md, .json, .png, .jpg or .webp')
    }
    const size = ctx.sizes.get(file)
    if (size === undefined) {
      error(ctx, file, '.', 'files.size', 'file has no size in the listing')
    } else if (!isFiniteNumber(size) || size < 0) {
      error(ctx, file, '.', 'files.size', 'file size must be a non-negative finite number')
    } else {
      totalBytes += size
    }
  }

  if (!seen.has(MANIFEST_FILE)) error(ctx, MANIFEST_FILE, '.', 'files.manifest', 'pack.json is required')
  if (!seen.has(PERSONA_FILE)) {
    error(ctx, PERSONA_FILE, '.', 'persona.missing', 'persona.md is required')
  } else if ((ctx.sizes.get(PERSONA_FILE) ?? 0) === 0) {
    error(ctx, PERSONA_FILE, '.', 'persona.empty', 'persona.md must not be empty')
  }

  if (mode === 'scenario' && !seen.has(SCENARIO_FILE)) {
    error(ctx, SCENARIO_FILE, '.', 'scenario.required', 'scenario.json is required when mode is "scenario"')
  }
  if (mode === 'freeform' && seen.has(SCENARIO_FILE)) {
    warn(ctx, SCENARIO_FILE, '.', 'scenario.ignored', 'scenario.json is ignored because mode is "freeform"')
  }

  if (totalBytes > MAX_PACK_BYTES) {
    error(ctx, '.', '.', 'files.total-size', `pack is ${totalBytes} bytes; the limit is ${MAX_PACK_BYTES} bytes (50MB)`)
  }
}

// ---------------------------------------------------------------------------
// scenario.json
// ---------------------------------------------------------------------------

function validateScenario(ctx: Context, scenario: ScenarioDefinition): { readonly intentIds: ReadonlySet<string> } {
  const raw = scenario as unknown as Rec
  const file = SCENARIO_FILE
  const intentIds = new Set<string>()
  unknownKeys(ctx, raw, KNOWN_SCENARIO_KEYS, file, '', 'scenario.unknown-field')

  // S12: boundaries and aftercare only live in pack.json.
  if (raw['boundaries'] !== undefined) {
    warn(ctx, file, 'boundaries', 'scenario.boundaries', 'scenario.json#boundaries is ignored; boundaries are declared only in pack.json (S12)')
  }
  if (raw['aftercare'] !== undefined) {
    warn(ctx, file, 'aftercare', 'scenario.aftercare', 'scenario.json#aftercare is ignored; use scenario.session.aftercareMin and pack.aftercare.text (S12)')
  }

  const host = raw['host']
  if (host !== undefined) {
    if (typeof host !== 'string' || host.trim().length === 0) {
      error(ctx, file, 'host', 'scenario.host', '"host" must be a non-empty file path when present')
    } else {
      const problem = pathProblem(host)
      if (problem !== undefined) {
        error(ctx, file, 'host', 'scenario.host', `"host" reference is unsafe: ${problem}`)
      } else if (!ctx.files.has(host)) {
        warn(ctx, file, 'host', 'scenario.host', `host file "${host}" does not exist; the engine default host is used (S31)`)
      }
    }
  }

  // Compatibility fields: only writing-prompt material, but their types are
  // still checked because malformed content would leak into a prompt.
  const opening = raw['opening']
  if (opening !== undefined && typeof opening !== 'string') {
    error(ctx, file, 'opening', 'compat.opening', '"opening" must be a string')
  }
  const secrets = raw['secrets']
  if (secrets !== undefined && !isStringArray(secrets)) {
    error(ctx, file, 'secrets', 'compat.secrets', '"secrets" must be an array of strings')
  }
  const npcs = raw['npcs']
  if (npcs !== undefined) {
    if (!Array.isArray(npcs)) {
      error(ctx, file, 'npcs', 'compat.npcs', '"npcs" must be an array')
    } else {
      for (const [index, item] of npcs.entries()) {
        const base = `npcs[${index}]`
        const record = asRecord(item)
        if (record === undefined) {
          error(ctx, file, base, 'compat.npcs', 'each NPC must be an object')
          continue
        }
        unknownKeys(ctx, record, new Set(['id', 'name', 'goals', 'escalation']), file, base, 'compat.npcs')
        requireStringField(ctx, record, file, 'id', `${base}.id`, 'compat.npcs', '"id"')
        optionalString(ctx, record, file, 'name', `${base}.name`, 'compat.npcs')
        for (const key of ['goals', 'escalation'] as const) {
          if (record[key] !== undefined && !isStringArray(record[key])) {
            error(ctx, file, `${base}.${key}`, 'compat.npcs', `"${key}" must be an array of strings`)
          }
        }
      }
    }
  }

  // --- regions ---------------------------------------------------------
  // v6: `regions` is an optional recommendation list, not a hard vocabulary.
  // The player can name a part freely; the runtime adds those session parts to
  // the playable region set. A pack that wants no recommendations may omit the
  // field (or pass []), as long as its intents omit `regions` too (they default
  // to whole-body).
  const regionIds = new Set<string>()
  const regions = raw['regions']
  if (regions === undefined) {
    warn(
      ctx,
      file,
      'regions',
      'scenario.regions',
      'no region recommendations declared; intents without explicit regions default to whole-body',
    )
  } else if (!Array.isArray(regions)) {
    error(ctx, file, 'regions', 'scenario.regions', '"regions" must be an array when present')
  } else {
    if (regions.length === 0) {
      warn(ctx, file, 'regions', 'scenario.regions', 'no region recommendations declared (allowed); intents should omit regions or use whole-body')
    }
    for (const [index, item] of regions.entries()) {
      const base = `regions[${index}]`
      const record = asRecord(item)
      if (record === undefined) {
        error(ctx, file, base, 'scenario.regions', 'each region must be an object')
        continue
      }
      unknownKeys(ctx, record, new Set(['id', 'label']), file, base, 'scenario.regions')
      const id = requireStringField(ctx, record, file, 'id', `${base}.id`, 'scenario.regions', '"id"')
      if (id !== undefined) {
        if (!REGION_ID_PATTERN.test(id)) {
          error(ctx, file, `${base}.id`, 'scenario.regions', `region id "${id}" is invalid; use lowercase letters, digits and dashes (max 32)`)
        }
        if (regionIds.has(id)) error(ctx, file, `${base}.id`, 'scenario.regions', `duplicate region id "${id}"`)
        regionIds.add(id)
      }
      requireStringField(ctx, record, file, 'label', `${base}.label`, 'scenario.regions', '"label"')
    }
  }

  // --- phases ----------------------------------------------------------
  const phaseIds = new Set<string>()
  const phaseNext = new Map<string, readonly string[]>()
  const phases = raw['phases']
  if (!Array.isArray(phases) || phases.length === 0) {
    error(ctx, file, 'phases', 'scenario.phases', '"phases" is required and must contain at least one phase')
  } else {
    for (const [index, item] of phases.entries()) {
      const base = `phases[${index}]`
      const record = asRecord(item)
      if (record === undefined) {
        error(ctx, file, base, 'scenario.phases', 'each phase must be an object')
        continue
      }
      unknownKeys(ctx, record, new Set(['id', 'goal', 'advanceWhen', 'next']), file, base, 'scenario.phases')
      const id = requireStringField(ctx, record, file, 'id', `${base}.id`, 'scenario.phases', '"id"')
      requireStringField(ctx, record, file, 'goal', `${base}.goal`, 'scenario.phases', '"goal"')
      optionalString(ctx, record, file, 'advanceWhen', `${base}.advanceWhen`, 'scenario.phases')
      const next = record['next']
      if (!Array.isArray(next) || !next.every(entry => typeof entry === 'string')) {
        error(ctx, file, `${base}.next`, 'scenario.phases', '"next" must be an array of phase ids (empty = terminal)')
        continue
      }
      if (id !== undefined) {
        if (!PHASE_ID_PATTERN.test(id)) {
          error(ctx, file, `${base}.id`, 'scenario.phases', `phase id "${id}" is invalid; it is also a file name (phases/<id>.md)`)
        }
        if (phaseIds.has(id)) error(ctx, file, `${base}.id`, 'scenario.phases', `duplicate phase id "${id}"`)
        phaseIds.add(id)
        phaseNext.set(id, next as readonly string[])
      }
    }

    // Graph rules: reachable from the first phase, no self-loop deadlock, at
    // least one terminal phase, and every reachable phase can reach a terminal.
    for (const [id, next] of phaseNext) {
      for (const target of next) {
        if (target === id) error(ctx, file, `phases.${id}.next`, 'phases.self-loop', `phase "${id}" lists itself in "next"`)
        else if (!phaseIds.has(target)) error(ctx, file, `phases.${id}.next`, 'phases.next', `phase "${id}" advances to unknown phase "${target}"`)
      }
    }
    const start = phaseIds.values().next()
    if (!start.done && phaseIds.size > 0) {
      const first = start.value
      const reachable = new Set<string>()
      const queue: string[] = [first]
      while (queue.length > 0) {
        const current = queue.shift()!
        if (reachable.has(current)) continue
        if (!phaseIds.has(current)) continue
        reachable.add(current)
        for (const target of phaseNext.get(current) ?? []) {
          if (phaseIds.has(target) && !reachable.has(target)) queue.push(target)
        }
      }
      for (const id of phaseIds) {
        if (!reachable.has(id)) {
          error(ctx, file, `phases.${id}`, 'phases.unreachable', `phase "${id}" is not reachable from the first phase "${first}"`)
        }
      }
      const terminals = [...phaseIds].filter(id => (phaseNext.get(id) ?? []).length === 0)
      const reachableTerminals = terminals.filter(id => reachable.has(id))
      if (reachableTerminals.length === 0) {
        error(ctx, file, 'phases', 'phases.no-terminal', 'the phase graph has no reachable terminal phase (a phase with "next": [])')
      } else {
        for (const id of reachable) {
          const seen = new Set<string>()
          const pending = [...(phaseNext.get(id) ?? [])]
          let reachesTerminal = terminals.includes(id)
          while (!reachesTerminal && pending.length > 0) {
            const current = pending.shift()!
            if (seen.has(current)) continue
            seen.add(current)
            if (!phaseIds.has(current)) continue
            if (terminals.includes(current)) {
              reachesTerminal = true
              break
            }
            pending.push(...(phaseNext.get(current) ?? []))
          }
          if (!reachesTerminal) {
            error(ctx, file, `phases.${id}`, 'phases.no-exit', `phase "${id}" can never reach a terminal phase; it is a dead end`)
          }
        }
      }
    }

    // Phase notes are optional; a missing one degrades to an empty note (D-8).
    for (const id of phaseIds) {
      const noteFile = `phases/${id}.md`
      if (!ctx.files.has(noteFile)) {
        warn(ctx, noteFile, '.', 'phase.note', `phase "${id}" has no writing note; an empty note is used`)
      }
    }
  }

  // --- session ---------------------------------------------------------
  const session = asRecord(raw['session'])
  if (session === undefined) {
    error(ctx, file, 'session', 'scenario.session', '"session" is required and must be an object')
  } else {
    unknownKeys(ctx, session, new Set(['plannedMinutes', 'phaseWindows', 'aftercareMin']), file, 'session', 'scenario.session')
    const planned = session['plannedMinutes']
    if (!('plannedMinutes' in session)) {
      error(ctx, file, 'session.plannedMinutes', 'scenario.session', '"plannedMinutes" is required (number or null)')
    } else if (planned !== null && (!isFiniteNumber(planned) || planned <= 0)) {
      error(ctx, file, 'session.plannedMinutes', 'scenario.session', '"plannedMinutes" must be a positive number or null')
    }
    const windows = session['phaseWindows']
    if (!Array.isArray(windows)) {
      error(ctx, file, 'session.phaseWindows', 'scenario.session', '"phaseWindows" is required and must be an array')
    } else {
      for (const [index, item] of windows.entries()) {
        const base = `session.phaseWindows[${index}]`
        const record = asRecord(item)
        if (record === undefined) {
          error(ctx, file, base, 'scenario.session', 'each phase window must be an object')
          continue
        }
        unknownKeys(ctx, record, new Set(['phase', 'from', 'to']), file, base, 'scenario.session')
        const phase = requireStringField(ctx, record, file, 'phase', `${base}.phase`, 'scenario.session', '"phase"')
        if (phase !== undefined && phaseIds.size > 0 && !phaseIds.has(phase)) {
          error(ctx, file, `${base}.phase`, 'scenario.session', `phase window references unknown phase "${phase}"`)
        }
        const from = record['from']
        const to = record['to']
        if (!isFiniteNumber(from) || from < 0 || from > 1) {
          error(ctx, file, `${base}.from`, 'scenario.session', '"from" must be a number between 0 and 1')
        }
        if (!isFiniteNumber(to) || to < 0 || to > 1) {
          error(ctx, file, `${base}.to`, 'scenario.session', '"to" must be a number between 0 and 1')
        }
        if (isFiniteNumber(from) && isFiniteNumber(to) && from >= to) {
          error(ctx, file, base, 'scenario.session', '"from" must be smaller than "to"')
        }
      }
    }
    const aftercareMin = session['aftercareMin']
    if (!isFiniteNumber(aftercareMin) || aftercareMin < 0) {
      error(ctx, file, 'session.aftercareMin', 'scenario.session', '"aftercareMin" is required and must be a non-negative number of minutes')
    }
  }

  // --- feedbackIntents -------------------------------------------------
  const intents = raw['feedbackIntents']
  if (!Array.isArray(intents)) {
    error(ctx, file, 'feedbackIntents', 'scenario.intents', '"feedbackIntents" is required and must be an array')
  } else {
    if (intents.length === 0) {
      warn(ctx, file, 'feedbackIntents', 'scenario.intents', 'no feedbackIntents declared; the director has no intent menu')
    }
    for (const [index, item] of intents.entries()) {
      const base = `feedbackIntents[${index}]`
      const record = asRecord(item)
      if (record === undefined) {
        error(ctx, file, base, 'scenario.intents', 'each feedback intent must be an object')
        continue
      }
      unknownKeys(ctx, record, new Set(['id', 'meaning', 'regions', 'suggest', 'distribution']), file, base, 'scenario.intents')
      const id = requireStringField(ctx, record, file, 'id', `${base}.id`, 'scenario.intents', '"id"')
      if (id !== undefined) {
        if (!INTENT_ID_PATTERN.test(id)) {
          error(ctx, file, `${base}.id`, 'scenario.intents', `intent id "${id}" is invalid; use lowercase letters, digits and dashes`)
        }
        if (intentIds.has(id)) error(ctx, file, `${base}.id`, 'intent.duplicate', `duplicate feedback intent id "${id}"`)
        intentIds.add(id)
      }
      requireStringField(ctx, record, file, 'meaning', `${base}.meaning`, 'scenario.intents', '"meaning"')
      const regions = record['regions']
      if (regions !== undefined) {
        if (!isStringArray(regions)) {
          error(ctx, file, `${base}.regions`, 'scenario.intents', '"regions" must be an array of region ids')
        } else {
          for (const region of regions) {
            // `whole-body` is the resolver's reserved wildcard and is legal for
            // every pack, whether or not it appears in `regions` (v6 makes the
            // recommendation list optional, so requiring an explicit entry
            // would make `regions: []` + `whole-body` intents unrepresentable).
            if (region !== WHOLE_BODY_REGION && !regionIds.has(region)) {
              // S15 ladder step 1: undeclared region is refused, not degraded.
              error(ctx, file, `${base}.regions`, 'intent.region-undeclared', `intent "${id ?? base}" references undeclared region "${region}" (S15)`)
            }
          }
        }
      }
      const suggest = record['suggest']
      if (suggest !== undefined) {
        const suggestRecord = asRecord(suggest)
        if (suggestRecord === undefined) {
          error(ctx, file, `${base}.suggest`, 'intent.suggest', '"suggest" must be an object')
        } else {
          unknownKeys(ctx, suggestRecord, new Set(['preset', 'waveform', 'durationSec', 'strength']), file, `${base}.suggest`, 'intent.suggest')
          const preset = suggestRecord['preset']
          if (preset !== undefined && (typeof preset !== 'string' || !ENVELOPE_PRESETS.has(preset))) {
            error(ctx, file, `${base}.suggest.preset`, 'intent.suggest', `"preset" must be one of ${[...ENVELOPE_PRESETS].join(', ')}`)
          }
          const waveform = suggestRecord['waveform']
          if (waveform !== undefined && (typeof waveform !== 'string' || waveform.trim().length === 0)) {
            error(ctx, file, `${base}.suggest.waveform`, 'intent.suggest', '"waveform" must be a non-empty id')
          }
          const durationSec = suggestRecord['durationSec']
          if (durationSec !== undefined) {
            if (!isFiniteNumber(durationSec) || durationSec <= 0) {
              error(ctx, file, `${base}.suggest.durationSec`, 'intent.suggest', '"durationSec" must be a positive number')
            } else if (durationSec > 600) {
              warn(ctx, file, `${base}.suggest.durationSec`, 'intent.suggest', '"durationSec" above 600 will be clamped by the policy')
            }
          }
          const strength = suggestRecord['strength']
          if (strength !== undefined && (typeof strength !== 'string' || !STRENGTHS.has(strength))) {
            error(ctx, file, `${base}.suggest.strength`, 'intent.suggest', '"strength" must be one of low, med, high')
          }
        }
      }
      const distribution = record['distribution']
      if (distribution !== undefined && (typeof distribution !== 'string' || !DISTRIBUTIONS.has(distribution))) {
        error(ctx, file, `${base}.distribution`, 'intent.distribution', `"distribution" must be one of ${[...DISTRIBUTIONS].join(', ')} (unknown values are refused)`)
      }
    }
  }

  return { intentIds }
}

/**
 * Validate a parsed pack.
 *
 * @returns every issue found, in a deterministic order. An empty list means
 *   `loadPack` may accept the pack. `error` issues are blocking, `warning`
 *   issues are not.
 */
export function validatePack(input: ValidatePackInput): readonly ValidationIssue[] {
  const ctx: Context = {
    files: new Set(input.files),
    sizes: input.sizes,
    issues: [],
  }

  const manifestResult = validateManifest(ctx, input.manifest, input.engineVersion)
  validateFiles(ctx, manifestResult.mode)

  if (input.scenario === undefined) {
    if (manifestResult.mode === 'scenario') {
      error(ctx, SCENARIO_FILE, '.', 'scenario.required', 'scenario.json is required when mode is "scenario"')
    }
  } else {
    const scenarioResult = validateScenario(ctx, input.scenario)
    // Rule 9: a metaReactions reference to an intent the pack does not define
    // only warns — the tone is still injected, the intent is dropped.
    for (const reference of manifestResult.metaReactionRefs) {
      if (!scenarioResult.intentIds.has(reference.firstIntent)) {
        warn(
          ctx,
          MANIFEST_FILE,
          `metaReactions[${reference.index}].opening.firstIntent`,
          'metaReaction.firstIntent',
          `"${reference.firstIntent}" is not in the pack's intent table; only the tone is injected`,
        )
      }
    }
  }

  return ctx.issues
}
