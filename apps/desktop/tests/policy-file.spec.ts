import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeClock } from '@embodied/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostRuntime, type HostRuntime } from '../src/main/bootstrap.ts'

let root: string
let runtime: HostRuntime | undefined

beforeEach(async () => {
  await mkdir(join(process.cwd(), '.test-tmp'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-tmp', 'policy-'))
})

afterEach(async () => {
  await runtime?.shutdown()
  runtime = undefined
  await rm(root, { recursive: true, force: true })
})

async function start(): Promise<HostRuntime> {
  return createHostRuntime({
    dataDir: root,
    clock: new FakeClock(),
    withPanicServer: false,
    withDashboard: false,
  })
}

describe('policy persistence', () => {
  it('writes policy.json without touching the audit log', async () => {
    runtime = await start()
    runtime.policy.setByHuman('coyote', 'a', { maxPercent: 25 })
    runtime.policy.setSessionCeilingByHuman(30)
    await runtime.savePolicy()

    const raw = await readFile(join(root, 'state', 'policy.json'), 'utf8')
    const file = JSON.parse(raw) as {
      version: number
      sessionCeiling: number
      channels: Record<string, { maxPercent: number; minPercent: number; minFreq: number; maxFreq: number }>
    }
    // v3 (the min/max + frequency-band model) writes snapshot version 2.
    expect(file.version).toBe(2)
    expect(file.sessionCeiling).toBe(30)
    expect(file.channels['coyote:a']?.maxPercent).toBe(25)
    expect(file.channels['coyote:a']?.minPercent).toBe(0)
    expect(file.channels['coyote:a']?.minFreq).toBe(10)
    expect(file.channels['coyote:a']?.maxFreq).toBe(240)

    // Persisting a cap is not a device action: no audit record may appear.
    await expect(access(join(root, 'audit', 'device.jsonl'))).rejects.toThrow()
  })

  it('reloads persisted caps after a restart', async () => {
    runtime = await start()
    runtime.policy.setByHuman('coyote', 'a', { maxPercent: 25 })
    runtime.policy.setSessionCeilingByHuman(30)
    await runtime.savePolicy()
    await runtime.shutdown()
    runtime = undefined

    runtime = await start()
    expect(runtime.policy.get('coyote', 'a').maxPercent).toBe(25)
    // v3 folds a legacy ceiling into the per-channel cap and releases it: the
    // global X is no longer a UI concept, so it must not keep squeezing later
    // per-channel edits.
    expect(runtime.policy.ceiling()).toBe(100)
    expect(runtime.policy.effective('coyote', 'a').maxPercent).toBe(25)
  })

  it('folds a legacy session ceiling into per-channel caps on boot', async () => {
    // v3 removes the global ceiling from the UI; a ceiling persisted by an older
    // build must not silently squeeze the new per-channel ranges forever.
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      join(root, 'state', 'policy.json'),
      JSON.stringify({
        version: 2,
        sessionCeiling: 20,
        channels: {
          'coyote:a': { minPercent: 0, maxPercent: 60, maxWaveIntensity: 80, minFreq: 10, maxFreq: 240, maxDurationSec: 60 },
        },
      }),
      'utf8',
    )

    runtime = await start()
    expect(runtime.policy.get('coyote', 'a').maxPercent).toBe(20)
    expect(runtime.policy.ceiling()).toBe(100)
    // The migration is persisted, so the next start sees a released ceiling.
    const raw = JSON.parse(await readFile(join(root, 'state', 'policy.json'), 'utf8')) as {
      sessionCeiling: number
      channels: Record<string, { maxPercent: number }>
    }
    expect(raw.channels['coyote:a']?.maxPercent).toBe(20)
    expect(raw.sessionCeiling).toBe(100)
    // It is audited as a system policy change, not as a device action.
    const audit = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    expect(audit).toContain('ceiling-migration')
  })

  it('keeps the conservative default when the persisted file is corrupt', async () => {
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(
      join(root, 'state', 'policy.json'),
      JSON.stringify({
        version: 1,
        sessionCeiling: 100,
        channels: { 'coyote:a': { maxPercent: 999, maxWaveIntensity: 80, maxDurationSec: 60 } },
      }),
      'utf8',
    )

    runtime = await start()
    // A hand-edited cap above the absolute bound must not take effect.
    expect(runtime.policy.get('coyote', 'a').maxPercent).toBe(20)
    expect(runtime.policy.ceiling()).toBe(100)
  })
})

describe('policy restore is auditable', () => {
  it('records a policy_change with scope "restore" when the persisted file is not default', async () => {
    runtime = await start()
    runtime.policy.setByHuman('coyote', 'a', { maxPercent: 25 })
    await runtime.savePolicy()
    await runtime.shutdown()
    runtime = undefined

    runtime = await start()
    const raw = await readFile(join(root, 'audit', 'device.jsonl'), 'utf8')
    const records = raw
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line) as { action: string; actor: string; detail?: { scope?: string } })
    const restored = records.find(record => record.action === 'policy_change' && record.detail?.scope === 'restore')
    // A hand-edited file must leave a trace even though restoring it is not a
    // cap change: this is the only record that says what came back from disk.
    expect(restored?.actor).toBe('system')
  })
})
