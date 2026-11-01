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
      channels: Record<string, { maxPercent: number }>
    }
    expect(file.version).toBe(1)
    expect(file.sessionCeiling).toBe(30)
    expect(file.channels['coyote:a']?.maxPercent).toBe(25)

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
    expect(runtime.policy.ceiling()).toBe(30)
    // The effective cap is the lower of the channel cap and the ceiling.
    expect(runtime.policy.effective('coyote', 'a').maxPercent).toBe(25)
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
