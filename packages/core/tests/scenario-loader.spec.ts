import { describe, expect, it } from 'vitest'
import { MemoryContentSource } from '../src/ports/content-source.ts'
import { ContentPackError, loadPack } from '../src/scenario/loader.ts'
import { ENGINE_VERSION } from '../src/version.ts'

const FREEFORM_MANIFEST = {
  id: 'low-tide',
  name: '轻潮',
  version: '0.1.0',
  engine: '>=0.2 <1.0',
  mode: 'freeform',
  rating: 'all',
  boundaries: ['不得出现疼痛描写'],
  aftercare: { text: '慢一点，喝口水。' },
}

const SCENARIO_MANIFEST = {
  id: 'tentacle-pure',
  name: '触手 · 纯爱',
  version: '0.2.0',
  engine: '>=0.2 <1.0',
  mode: 'scenario',
  rating: '18+',
  boundaries: ['不得出现不可逆伤害'],
  aftercare: { text: '抱着，慢慢缓过来。' },
  history: { read: true, lastN: 1 },
  metaReactions: [{ when: { endReason: ['left_early'] }, opening: { tone: 'cold', firstIntent: 'soothe' } }],
}

const SCENARIO_JSON = {
  host: 'host.md',
  session: {
    plannedMinutes: 45,
    phaseWindows: [
      { phase: 'probe', from: 0, to: 0.2 },
      { phase: 'resolve', from: 0.8, to: 1 },
    ],
    aftercareMin: 5,
  },
  regions: [
    { id: 'chest', label: '胸口' },
    { id: 'whole-body', label: '全身' },
  ],
  phases: [
    { id: 'probe', goal: '试探与观察', next: ['resolve'] },
    { id: 'resolve', goal: '收束与事后照顾', next: [] },
  ],
  feedbackIntents: [
    {
      id: 'probe-touch',
      meaning: '短促试探',
      regions: ['chest'],
      suggest: { preset: 'pulse', waveform: 'builtin:tide', durationSec: 2, strength: 'low' },
    },
    { id: 'soothe', meaning: '安抚', regions: ['whole-body'], suggest: { preset: 'wave', durationSec: 10, strength: 'low' } },
  ],
  opening: '建立：时间、地点、玩家当前处境、第一个可察觉的异常',
  npcs: [{ id: 'tentacle-lv20', name: '触手小怪物 Lv.20', goals: ['试探与捉弄'] }],
  secrets: ['小怪物畏光'],
}

const PERSONA = '# 角色\n\n温柔而克制的引导者。\n\n## 导演摘要\n\n行动倾向：先观察再靠近；称呼：你。\n'

function scenarioFiles(): Record<string, string> {
  return {
    'pack.json': JSON.stringify(SCENARIO_MANIFEST),
    'persona.md': PERSONA,
    'host.md': '# 主持\n\n节奏：慢。收尾：先归零，再给一句话。\n',
    'scenario.json': JSON.stringify(SCENARIO_JSON),
    'phases/probe.md': '只观察，不主动加码。',
    'phases/resolve.md': '先归零，再问一句"还好吗"。',
    'waveforms/gentle.json': JSON.stringify({
      id: 'gentle',
      name: '轻柔',
      sensation: '细密',
      tags: ['soft'],
      loop: true,
      frames: ['0A0A0A0A00000000', '0A0A0A0A0A0A0A0A'],
    }),
  }
}

async function failure(promise: Promise<unknown>): Promise<ContentPackError> {
  try {
    await promise
    throw new Error('loadPack should have rejected')
  } catch (error) {
    expect(error).toBeInstanceOf(ContentPackError)
    return error as ContentPackError
  }
}

describe('content-pack loader', () => {
  it('loads a freeform pack from persona.md and pack.json only', async () => {
    const source = new MemoryContentSource({
      'pack.json': JSON.stringify(FREEFORM_MANIFEST),
      'persona.md': PERSONA,
      'setting.md': '# 世界\n\n海边小镇。',
      'corpus.md': '# 语料\n\n潮声。',
    })
    const pack = await loadPack(source)

    expect(pack.manifest.id).toBe('low-tide')
    expect(pack.manifest.mode).toBe('freeform')
    expect(pack.persona).toContain('温柔而克制')
    expect(pack.setting).toContain('海边小镇')
    expect(pack.corpus).toContain('潮声')
    expect(pack.scenario).toBeUndefined()
    expect(pack.host).toBeUndefined()
    expect(pack.waveforms).toEqual([])
    expect(pack.phaseNotes.size).toBe(0)
    expect(pack.warnings).toEqual([])
    // Builtins are always resolvable; a bare id only looks at the pack.
    expect(pack.resolveWaveform('builtin:tide')?.id).toBe('tide')
    expect(pack.resolveWaveform('tide')).toBeUndefined()
  })

  it('loads a scenario pack with host, phase notes and namespaced waveforms', async () => {
    const pack = await loadPack(new MemoryContentSource(scenarioFiles()))

    expect(pack.manifest.id).toBe('tentacle-pure')
    expect(pack.host).toContain('节奏：慢')
    expect(pack.phaseNotes.get('probe')).toContain('只观察')
    expect(pack.phaseNotes.get('resolve')).toContain('先归零')
    expect(pack.scenario?.phases.map(phase => phase.id)).toEqual(['probe', 'resolve'])
    // The compatibility fields are preserved for the writing prompt.
    expect(pack.scenario?.opening).toContain('第一个可察觉的异常')
    expect(pack.scenario?.npcs?.[0]?.id).toBe('tentacle-lv20')
    expect(pack.scenario?.secrets).toEqual(['小怪物畏光'])

    expect(pack.waveforms).toHaveLength(1)
    expect(pack.waveforms[0]!.id).toBe('tentacle-pure:gentle')
    expect(pack.waveforms[0]!.name).toBe('轻柔')
    // `sensation` travels as a tag so the writer can read it.
    expect(pack.waveforms[0]!.tags).toContain('细密')
    expect(pack.warnings).toEqual([])
  })

  it('reports a pack error with the offending file path', async () => {
    const broken = scenarioFiles()
    broken['scenario.json'] = '{ "phases": ['
    const malformed = await failure(loadPack(new MemoryContentSource(broken)))
    expect(malformed.file).toBe('scenario.json')
    expect(malformed.message).toContain('scenario.json')
    expect(malformed.issues.some(issue => issue.rule === 'scenario.json')).toBe(true)

    const missing = scenarioFiles()
    delete missing['scenario.json']
    const absent = await failure(loadPack(new MemoryContentSource(missing)))
    expect(absent.file).toBe('scenario.json')
    expect(absent.issues.some(issue => issue.rule === 'scenario.required')).toBe(true)

    // Structurally wrong JSON must become a pack error too, never a TypeError.
    const wrongShape = scenarioFiles()
    wrongShape['scenario.json'] = JSON.stringify({ ...SCENARIO_JSON, phases: 42 })
    const shape = await failure(loadPack(new MemoryContentSource(wrongShape)))
    expect(shape.file).toBe('scenario.json')
    expect(shape.issues.some(issue => issue.rule === 'scenario.phases')).toBe(true)
  })

  it('refuses a pack whose engine range excludes ENGINE_VERSION', async () => {
    const source = new MemoryContentSource({
      'pack.json': JSON.stringify({ ...FREEFORM_MANIFEST, engine: '>=0.9 <1.0' }),
      'persona.md': PERSONA,
    })
    const error = await failure(loadPack(source))
    expect(error.file).toBe('pack.json')
    expect(error.message).toContain('0.2.0')
    expect(ENGINE_VERSION).toBe('0.2.0')
    expect(error.issues.some(issue => issue.rule === 'manifest.engine')).toBe(true)

    // The same pack loads once the engine version is inside the range; this is
    // also how tests exercise a future engine without editing package.json.
    const upgraded = await loadPack(source, { engineVersion: '0.9.5' })
    expect(upgraded.manifest.engine).toBe('>=0.9 <1.0')
  })

  it('warns instead of failing on the documented degradations', async () => {
    const files = scenarioFiles()
    files['pack.json'] = JSON.stringify({ ...SCENARIO_MANIFEST, boundaries: undefined, history: undefined, metaReactions: undefined })
    delete files['host.md']
    delete files['phases/resolve.md']
    const scenario = JSON.parse(JSON.stringify(SCENARIO_JSON)) as Record<string, unknown>
    scenario['feedbackIntents'] = [
      { id: 'probe-touch', meaning: '短促试探', regions: ['chest'], suggest: { waveform: 'bubble' } },
    ]
    files['scenario.json'] = JSON.stringify(scenario)
    files['persona.md'] = '# 角色\n\n没有导演摘要的人设。\n'

    const pack = await loadPack(new MemoryContentSource(files))
    const warnings = pack.warnings.join('\n')
    expect(warnings).toContain('no boundaries declared')
    expect(warnings).toContain('导演摘要')
    expect(warnings).toContain('host file "host.md" does not exist')
    expect(warnings).toContain('phases/resolve.md')
    expect(warnings).toContain('suggest.waveform "bubble"')
    expect(pack.phaseNotes.has('probe')).toBe(true)
  })

  it('rejects an out-of-range pack waveform and names the frame', async () => {
    const files = scenarioFiles()
    files['waveforms/gentle.json'] = JSON.stringify({
      id: 'gentle',
      frames: ['0A0A0A0A00000000', '050505050A0A0A0A'],
    })
    const error = await failure(loadPack(new MemoryContentSource(files)))
    expect(error.file).toBe('waveforms/gentle.json')
    expect(error.message).toMatch(/frame 1 slot 0/u)
    expect(error.issues.some(issue => issue.rule === 'waveform.bounds')).toBe(true)
  })

  it('loads a waveform authored as a DSL script', async () => {
    const files = scenarioFiles()
    files['waveforms/climb.json'] = JSON.stringify({
      id: 'climb',
      name: '攀爬',
      loop: false,
      segments: [{ ms: 1000, freq: { from: 20, to: 60 }, intensity: { from: 0, to: 50 }, curve: 'easeIn' }],
    })
    const pack = await loadPack(new MemoryContentSource(files))
    const ids = pack.waveforms.map(waveform => waveform.id).sort()
    expect(ids).toEqual(['tentacle-pure:climb', 'tentacle-pure:gentle'])
    const climb = pack.waveforms.find(waveform => waveform.id === 'tentacle-pure:climb')
    expect(climb?.frames).toHaveLength(10)
    expect(climb?.loop).toBe(false)
  })

  it('resolves pack-local, namespaced and builtin waveform references', async () => {
    const pack = await loadPack(new MemoryContentSource(scenarioFiles()))

    expect(pack.waveforms.map(waveform => waveform.id)).toEqual(['tentacle-pure:gentle'])
    // Local id (what a `suggest.waveform` in the pack usually writes).
    expect(pack.resolveWaveform('gentle')?.id).toBe('tentacle-pure:gentle')
    // Already namespaced id — the form the waveform library hands out.
    expect(pack.resolveWaveform('tentacle-pure:gentle')?.id).toBe('tentacle-pure:gentle')
    // `builtin:` points at the engine library.
    expect(pack.resolveWaveform('builtin:tide')?.id).toBe('tide')
    // The frozen spec requires `builtin:` for engine assets, so a bare builtin
    // id is only ever looked up in the pack namespace.
    expect(pack.resolveWaveform('tide')).toBeUndefined()
    expect(pack.resolveWaveform('bubble')).toBeUndefined()
    expect(pack.resolveWaveform('other-pack:gentle')).toBeUndefined()
    expect(pack.resolveWaveform('')).toBeUndefined()
    expect(pack.resolveWaveform('  ')).toBeUndefined()
  })

  it('guarantees that every accepted suggest.waveform resolves at runtime', async () => {
    const files = scenarioFiles()
    const scenario = JSON.parse(JSON.stringify(SCENARIO_JSON)) as Record<string, unknown>
    const accepted = ['gentle', 'tentacle-pure:gentle', 'builtin:tide']
    const intentIds = ['probe-touch', 'ambient-field', 'soothe']
    scenario['feedbackIntents'] = accepted.map((reference, index) => ({
      id: intentIds[index],
      meaning: reference,
      regions: ['chest'],
      suggest: { waveform: reference },
    }))
    files['scenario.json'] = JSON.stringify(scenario)

    const pack = await loadPack(new MemoryContentSource(files))
    // Validation passed, therefore every reference must resolve (S5 closure).
    expect(pack.warnings).toEqual([])
    for (const reference of accepted) expect(pack.resolveWaveform(reference), reference).toBeDefined()

    // An unknown reference is warning-only and stays unresolvable; the engine
    // falls back to a default waveform instead of failing the pack.
    ;(scenario['feedbackIntents'] as unknown[]).push({
      id: 'breach',
      meaning: '未知波形引用',
      regions: ['chest'],
      suggest: { waveform: 'bubble' },
    })
    files['scenario.json'] = JSON.stringify(scenario)
    const warned = await loadPack(new MemoryContentSource(files))
    expect(warned.warnings.join('\n')).toContain('suggest.waveform "bubble"')
    expect(warned.resolveWaveform('bubble')).toBeUndefined()
    for (const reference of accepted) expect(warned.resolveWaveform(reference), reference).toBeDefined()
  })
})
