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
import styleCss from './ui/style.css?text'
// B2-T12: the play page is part of the same in-memory bundle, so start-dev.bat
// reaches /play without Electron and without a disk lookup.
import playHtml from './ui/play.html?text'
import playJs from './ui/play.js?text'
// The phone stop page is the third static file; keeping it in the map means the
// bundle really is self-contained (no disk lookup for a page that must work
// when the operator's phone is the only client).
import phoneHtml from './ui/phone.html?text'

const dataDir = process.env.EMBODIED_DATA_DIR ?? join(process.cwd(), '.dev-data')
const port = Number(process.env.EMBODIED_DASHBOARD_PORT ?? 0)
// UI iteration switch: read index/play/style straight from `src/ui` on every
// request instead of the copies baked into this bundle. Only useful while
// developing the pages; the default stays self-contained so start-dev.bat
// works from any working directory.
const uiFromDisk = process.env.EMBODIED_UI_FROM_DISK === '1'

const runtime = await createHostRuntime({
  dataDir,
  withPanicServer: false,
  withButtplug: false,
  dashboardPort: port,
  // The UI files ride inside this bundle, so the dev server is self-contained
  // and works from any working directory. `EMBODIED_UI_FROM_DISK=1` drops that
  // map so every request re-reads `src/ui/` — that is the switch for iterating
  // on the pages without rebuilding.
  ...(uiFromDisk
    ? {}
    : {
        dashboardStaticFiles: {
          'index.html': indexHtml,
          'app.js': appJs,
          'style.css': styleCss,
          'play.html': playHtml,
          'play.js': playJs,
          'phone.html': phoneHtml,
        },
      }),
  onError: error => { console.error('[dev-server]', error) },
})

const address = runtime.dashboardAddress
if (address === undefined) {
  console.error('[dev-server] console did not start')
  process.exit(1)
}
const consoleUrl = `http://${address.host}:${address.port}/?token=${runtime.dashboardToken}`
console.log(`[dev-server] console: ${consoleUrl}`)
// Same token-in-query convention; opening the console URL and swapping the
// path would work too, but printing it means nobody has to.
console.log(`[dev-server] play: http://${address.host}:${address.port}/play?token=${runtime.dashboardToken}`)
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
