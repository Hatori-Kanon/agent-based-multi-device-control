/**
 * Headless console server — the same runtime and the same web console, without
 * Electron.
 *
 * This is for environments where a GPU-backed shell cannot run (this sandbox
 * included) and doubles as the answer to "open the console in a browser". BLE
 * backends are unavailable here; the mock devices exercise every console
 * operation end to end.
 *
 *     pnpm --filter @embodied/desktop exec tsx src/dev-server.ts
 *     pnpm --filter @embodied/desktop dev
 */

import { join } from 'node:path'
import { createHostRuntime } from './main/bootstrap.ts'
import indexHtml from './ui/index.html?text'
import appJs from './ui/app.js?text'

const dataDir = process.env.EMBODIED_DATA_DIR ?? join(process.cwd(), '.dev-data')
const port = Number(process.env.EMBODIED_DASHBOARD_PORT ?? 0)

const runtime = await createHostRuntime({
  dataDir,
  withPanicServer: false,
  withButtplug: false,
  dashboardPort: port,
  // The UI files ride inside this bundle, so the dev server is self-contained
  // and works from any working directory.
  dashboardStaticFiles: {
    'index.html': indexHtml,
    'app.js': appJs,
  },
  onError: error => { console.error('[dev-server]', error) },
})

const address = runtime.dashboardAddress
if (address === undefined) {
  console.error('[dev-server] console did not start')
  process.exit(1)
}
const consoleUrl = `http://${address.host}:${address.port}/?token=${runtime.dashboardToken}`
console.log(`[dev-server] console: ${consoleUrl}`)
console.log(`[dev-server] data: ${dataDir}`)

// Convenience for the one-click batch script; opt-in so embedding the server
// in another host never unexpectedly pops a browser.
if (process.env.EMBODIED_OPEN_BROWSER === '1') {
  const { spawn } = await import('node:child_process')
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32'
    ? ['/c', 'start', '', consoleUrl]
    : [consoleUrl]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
  child.on('error', error => { console.error('[dev-server] could not open browser:', error.message) })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[dev-server] ${signal}, shutting down`)
    void runtime.shutdown().finally(() => { process.exit(0) })
  })
}
