'use strict'

/**
 * Development-only restart of the Electron process that is already running.
 *
 * This is not a renderer reload. It does not call webContents.reload,
 * location.reload, or the in-app browser's browser:reload IPC. Electron's
 * app.relaunch() with no argument override starts a relauncher helper, waits
 * until this process has exited, and then starts one replacement from the
 * original argv (the dev electron binary, the app path, and any launcher
 * flags such as a remote-debugging port). The helper inherits this process's
 * working directory and environment. Nothing here sets NODE_OPTIONS, a
 * debugging port, or a user-data directory, and nothing deletes the profile.
 *
 * main.cjs wires quit to app.quit(), the same path as Exit, so the window
 * close handler can still flush Continue watching and before-quit can still
 * run its existing child-process cleanup. This module does not call
 * app.exit(), process.kill, or taskkill, and it does not spawn a second
 * Electron while this one is still the live instance. A second request after
 * a relaunch has been accepted is ignored so two helpers are not scheduled
 * (Electron starts one new instance per successful app.relaunch()).
 *
 * The replacement executable is argv[0] of this process. Packaged Jiyu is
 * refused before relaunch or quit: app.isPackaged must be explicitly false,
 * both execPath and argv[0] must be the electron dev binary (not Jiyu.exe),
 * and the app entry must not be an asar or a resources/app directory.
 *
 * Limitations. This repo's dev script and any external launcher are not
 * reimplemented here:
 * - `npm run dev:desktop` is `concurrently -k` around Vite and `electron .`.
 *   When this Electron process exits, concurrently kills the rest of that
 *   session, including Vite on port 5173, and may tree-kill the relauncher
 *   helper before the replacement starts. This menu does not re-run the npm
 *   script and does not start Vite. A direct `electron <app> ...` launch,
 *   with Vite already running on its own, is what comes back to
 *   http://localhost:5173 and the dev profile (user-data-dev).
 * - Flags and environment variables already on this process are kept because
 *   argv is not overridden and the environment is not replaced. A supervisor
 *   that applies a hook only outside this process, and does not put it on
 *   argv or in this process's environment, is not re-run.
 * - A parent that also starts Electron when this process exits can end up
 *   beside the relauncher's replacement. This module schedules at most one
 *   relaunch and does not signal, kill, or detect that parent.
 */

function fileBasename(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return (slash === -1 ? normalized : normalized.slice(slash + 1)).toLowerCase()
}

const DEV_ELECTRON_BASENAMES = new Set(['electron', 'electron.exe'])

function firstPositionalArg(argv) {
  const args = Array.isArray(argv) ? argv : []
  for (let i = 1; i < args.length; i += 1) {
    const arg = String(args[i] ?? '')
    if (arg === '--') {
      const next = args[i + 1]
      return next == null ? '' : String(next)
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return ''
}

function isPackagedAppEntry(entry) {
  const value = String(entry || '').replace(/\\/g, '/')
  if (/\.asar(\.|\/|$)/i.test(value)) return true
  if (/\/resources\/app(\/|$)/i.test(value)) return true
  return false
}

/**
 * @param {object | null | undefined} deps
 * @returns {{ ok: true, reason: 'dev' } | { ok: false, reason: string }}
 */
function evaluateDevRestart(deps) {
  const input = deps && typeof deps === 'object' ? deps : {}
  // Fail closed: only an explicit unpackaged process may continue.
  if (input.isPackaged !== false) {
    return { ok: false, reason: 'packaged' }
  }
  const execPath = typeof input.execPath === 'string' ? input.execPath : ''
  const execBase = fileBasename(execPath)
  if (!DEV_ELECTRON_BASENAMES.has(execBase)) {
    return { ok: false, reason: 'not-dev-electron' }
  }
  const argv = Array.isArray(input.argv) ? input.argv : []
  if (argv.length < 2) {
    return { ok: false, reason: 'missing-app-entry' }
  }
  const argv0 = fileBasename(argv[0])
  if (argv0 !== execBase) {
    return { ok: false, reason: 'argv-exec-mismatch' }
  }
  const entry = firstPositionalArg(argv)
  if (!entry) {
    return { ok: false, reason: 'missing-app-entry' }
  }
  if (isPackagedAppEntry(entry)) {
    return { ok: false, reason: 'packaged-entry' }
  }
  return { ok: true, reason: 'dev' }
}

const RESTART_KIND = 'process-relaunch'

function createDevRestartController() {
  let scheduled = false
  return {
    /**
     * @param {object | null | undefined} deps
     * @param {unknown} [_payload] Renderer arguments are ignored. The
     *   executable and argv always come from the main process.
     */
    request(deps, _payload) {
      void _payload
      const gate = evaluateDevRestart(deps)
      if (!gate.ok) return gate
      if (scheduled) return { ok: false, reason: 'already-scheduled' }
      const input = deps && typeof deps === 'object' ? deps : {}
      if (typeof input.relaunch !== 'function' || typeof input.quit !== 'function') {
        return { ok: false, reason: 'unavailable' }
      }
      let started = false
      try {
        // No execPath and no args. Electron repeats ElectronCommandLine argv,
        // which is the original command line, not switches appended later
        // and not a path chosen by the renderer.
        started = input.relaunch() !== false
      } catch (err) {
        return {
          ok: false,
          reason: 'relaunch-failed',
          error: String(err && err.message ? err.message : err),
        }
      }
      if (!started) return { ok: false, reason: 'relaunch-failed' }
      scheduled = true
      if (typeof input.log === 'function') {
        try {
          input.log('[jiyu] restarting development Electron process')
        } catch {
          /* logging must not block quit */
        }
      }
      try {
        input.quit()
      } catch (err) {
        return {
          ok: false,
          reason: 'quit-failed',
          scheduled: true,
          kind: RESTART_KIND,
          error: String(err && err.message ? err.message : err),
        }
      }
      return { ok: true, scheduled: true, kind: RESTART_KIND }
    },
  }
}

const singleton = createDevRestartController()

function requestDevAppRestart(deps, payload) {
  return singleton.request(deps, payload)
}

module.exports = {
  DEV_APP_RESTART_KIND: RESTART_KIND,
  createDevRestartController,
  evaluateDevRestart,
  requestDevAppRestart,
}
