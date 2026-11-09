/**
 * Dev-only Electron restart: menu visibility, packaged refusal, and the
 * relaunch/quit lifecycle. Does not start Electron or touch a profile.
 *
 * Run: node --experimental-strip-types --test scripts/dev-restart.test.ts
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { devRestartFailureNote, shouldOfferDevAppRestart } from '../src/lib/devRestartMenu.ts'

const require = createRequire(import.meta.url)
const {
  DEV_APP_RESTART_KIND,
  createDevRestartController,
  requestDevAppRestart,
} = require('../electron/devRestart.cjs') as {
  DEV_APP_RESTART_KIND: string
  createDevRestartController: () => {
    request: (deps: Record<string, unknown>, payload?: unknown) => {
      ok: boolean
      reason?: string
      kind?: string
      scheduled?: boolean
      error?: string
    }
  }
  requestDevAppRestart: (deps: Record<string, unknown>, payload?: unknown) => {
    ok: boolean
    reason?: string
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const devExe = 'D:\\app\\node_modules\\electron\\dist\\electron.exe'
const linuxExe = '/work/jiyu/node_modules/electron/dist/electron'

function devDeps(
  over: Record<string, unknown> = {},
): Record<string, unknown> & {
  relaunch: (...args: unknown[]) => boolean
  quit: () => void
} {
  return {
    isPackaged: false,
    execPath: devExe,
    argv: [devExe, 'D:\\app', '--remote-debugging-port=9333'],
    relaunch: () => true,
    quit: () => {},
    ...over,
  }
}

test('menu is offered only for an unpackaged desktop dev build', () => {
  assert.equal(
    shouldOfferDevAppRestart({ devBuild: true, androidShell: false, desktopBridge: true }),
    true,
  )
  assert.equal(
    shouldOfferDevAppRestart({ devBuild: false, androidShell: false, desktopBridge: true }),
    false,
  )
  assert.equal(
    shouldOfferDevAppRestart({ devBuild: true, androidShell: true, desktopBridge: true }),
    false,
  )
  assert.equal(
    shouldOfferDevAppRestart({ devBuild: true, androidShell: false, desktopBridge: false }),
    false,
  )
})

test('failure copy does not describe a page reload', () => {
  for (const reason of ['packaged', 'relaunch-failed', 'quit-failed', undefined] as const) {
    assert.equal(/reload/i.test(devRestartFailureNote(reason)), false)
  }
  assert.match(devRestartFailureNote('already-scheduled'), /already in progress/i)
})

test('packaged build cannot schedule a relaunch or a quit', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  let quits = 0
  const result = controller.request({
    isPackaged: true,
    execPath: 'C:\\Program Files\\Jiyu\\Jiyu.exe',
    argv: ['C:\\Program Files\\Jiyu\\Jiyu.exe', 'C:\\Program Files\\Jiyu\\resources\\app.asar'],
    relaunch: () => {
      relaunches += 1
      return true
    },
    quit: () => {
      quits += 1
    },
  })
  assert.deepEqual(result, { ok: false, reason: 'packaged' })
  assert.equal(relaunches, 0)
  assert.equal(quits, 0)
})

test('missing isPackaged fails closed', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  const result = controller.request(
    devDeps({
      isPackaged: undefined,
      relaunch: () => {
        relaunches += 1
        return true
      },
    }),
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'packaged')
  assert.equal(relaunches, 0)
})

test('installed Jiyu.exe is refused even if isPackaged is false', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  const exe = 'D:\\Jiyu\\Jiyu.exe'
  const result = controller.request({
    isPackaged: false,
    execPath: exe,
    argv: [exe, 'D:\\app'],
    relaunch: () => {
      relaunches += 1
      return true
    },
    quit: () => {},
  })
  assert.equal(result.reason, 'not-dev-electron')
  assert.equal(relaunches, 0)
})

test('refuses when argv[0] is not the dev electron binary', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  const result = controller.request(
    devDeps({
      argv: ['C:\\Program Files\\Jiyu\\Jiyu.exe', 'D:\\app'],
      relaunch: () => {
        relaunches += 1
        return true
      },
    }),
  )
  assert.equal(result.reason, 'argv-exec-mismatch')
  assert.equal(relaunches, 0)
})

test('refuses an asar or resources/app entry so the dev binary cannot open installed Jiyu', () => {
  const controller = createDevRestartController()
  for (const entry of [
    'C:\\Program Files\\Jiyu\\resources\\app.asar',
    '/opt/Jiyu/resources/app',
    '/opt/Jiyu/resources/app.asar.unpacked',
  ]) {
    let relaunches = 0
    const result = controller.request(
      devDeps({
        execPath: linuxExe,
        argv: [linuxExe, entry],
        relaunch: () => {
          relaunches += 1
          return true
        },
      }),
    )
    assert.equal(result.reason, 'packaged-entry', entry)
    assert.equal(relaunches, 0, entry)
  }
})

test('refuses a switch-only command line that would open Electron default_app', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  const result = controller.request(
    devDeps({
      argv: [devExe, '--remote-debugging-port=9333'],
      relaunch: () => {
        relaunches += 1
        return true
      },
    }),
  )
  assert.equal(result.reason, 'missing-app-entry')
  assert.equal(relaunches, 0)
})

test('schedules one same-argv relaunch then quits, for either flag order', () => {
  for (const argv of [
    [devExe, 'D:\\app', '--remote-debugging-port=9333'],
    [devExe, '--remote-debugging-port=9333', 'D:\\app'],
    [linuxExe, '.'],
    [linuxExe, '--inspect=0', '.'],
  ]) {
    const controller = createDevRestartController()
    const calls: string[] = []
    const env = { NODE_OPTIONS: '--require ./hook.js' }
    const result = controller.request(
      {
        isPackaged: false,
        execPath: argv[0],
        argv,
        env,
        relaunch: function relaunch() {
          calls.push(`relaunch:${arguments.length}`)
          return true
        },
        quit: () => {
          calls.push('quit')
        },
        log: (line: unknown) => {
          calls.push(String(line))
        },
      },
      { execPath: 'C:\\Program Files\\Jiyu\\Jiyu.exe', args: ['--user-data-dir=C:\\cleared'] },
    )
    assert.equal(result.ok, true, argv.join(' '))
    assert.equal(result.kind, DEV_APP_RESTART_KIND)
    assert.equal(result.kind, 'process-relaunch')
    assert.deepEqual(calls, [
      'relaunch:0',
      '[jiyu] restarting development Electron process',
      'quit',
    ])
    assert.deepEqual(env, { NODE_OPTIONS: '--require ./hook.js' })
  }
})

test('a second request does not schedule another relaunch', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  let quits = 0
  const deps = devDeps({
    relaunch: () => {
      relaunches += 1
      return true
    },
    quit: () => {
      quits += 1
    },
  })
  assert.equal(controller.request(deps).ok, true)
  const again = controller.request(deps)
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already-scheduled')
  assert.equal(relaunches, 1)
  assert.equal(quits, 1)
})

test('a failed relaunch does not quit and can be retried', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  let quits = 0
  let fail = true
  const deps = devDeps({
    relaunch: () => {
      relaunches += 1
      if (fail) return false
      return true
    },
    quit: () => {
      quits += 1
    },
  })
  const failed = controller.request(deps)
  assert.equal(failed.reason, 'relaunch-failed')
  assert.equal(quits, 0)
  fail = false
  assert.equal(controller.request(deps).ok, true)
  assert.equal(relaunches, 2)
  assert.equal(quits, 1)
})

test('a thrown relaunch does not quit or stick the scheduled flag', () => {
  const controller = createDevRestartController()
  let quits = 0
  let blowUp = true
  const deps = devDeps({
    relaunch: () => {
      if (blowUp) throw new Error('helper failed')
      return true
    },
    quit: () => {
      quits += 1
    },
  })
  const failed = controller.request(deps)
  assert.equal(failed.reason, 'relaunch-failed')
  assert.match(failed.error || '', /helper failed/)
  assert.equal(quits, 0)
  blowUp = false
  assert.equal(controller.request(deps).ok, true)
  assert.equal(quits, 1)
})

test('quit failure after a successful relaunch does not schedule a second one', () => {
  const controller = createDevRestartController()
  let relaunches = 0
  const deps = devDeps({
    relaunch: () => {
      relaunches += 1
      return true
    },
    quit: () => {
      throw new Error('quit aborted')
    },
  })
  const failed = controller.request(deps)
  assert.equal(failed.reason, 'quit-failed')
  assert.equal(failed.scheduled, true)
  const again = controller.request(deps)
  assert.equal(again.reason, 'already-scheduled')
  assert.equal(relaunches, 1)
})

test('the shared handler refuses a packaged call and does not relaunch twice', () => {
  let relaunches = 0
  const packaged = requestDevAppRestart({
    isPackaged: true,
    execPath: devExe,
    argv: [devExe, 'D:\\app'],
    relaunch: () => {
      relaunches += 1
      return true
    },
    quit: () => {},
  })
  assert.equal(packaged.reason, 'packaged')
  const dev = devDeps({
    relaunch: () => {
      relaunches += 1
      return true
    },
  })
  assert.equal(requestDevAppRestart(dev).ok, true)
  assert.equal(requestDevAppRestart(dev).reason, 'already-scheduled')
  assert.equal(relaunches, 1)
})

test('main and preload gate the capability and do not reload the renderer', () => {
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const moduleSource = fs
    .readFileSync(path.join(root, 'electron', 'devRestart.cjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const sidebar = fs.readFileSync(path.join(root, 'src', 'components', 'Sidebar.tsx'), 'utf8')

  const handlerStart = main.indexOf("ipcMain.handle('app:restartDevApp'")
  const handlerEnd = main.indexOf("ipcMain.handle('app:exitFullScreen'")
  assert.ok(handlerStart > 0)
  assert.ok(handlerEnd > handlerStart)
  const handler = main.slice(handlerStart, handlerEnd)
  assert.match(handler, /ipcMain\.handle\('app:restartDevApp',\s*\(\)\s*=>/)
  assert.match(handler, /relaunch:\s*\(\)\s*=>\s*app\.relaunch\(\)/)
  assert.match(handler, /quit:\s*\(\)\s*=>\s*app\.quit\(\)/)
  assert.equal(handler.includes('app.relaunch({'), false)
  assert.equal(handler.includes('app.exit('), false)
  assert.equal(handler.includes('webContents.reload'), false)
  assert.equal(handler.includes('location.reload'), false)
  assert.equal(main.includes('app.relaunch({'), false)
  assert.equal(main.includes('app.exit('), false)

  assert.match(preload, /restartDevApp:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('app:restartDevApp'\)/)
  assert.equal(/restartDevApp:\s*\([^)]+\)/.test(preload), false)

  assert.equal(moduleSource.includes('webContents.reload'), false)
  assert.equal(moduleSource.includes('location.reload'), false)
  assert.equal(moduleSource.includes('app.exit'), false)
  assert.equal(moduleSource.includes('process.kill'), false)
  assert.equal(moduleSource.includes('clearStorageData'), false)
  assert.equal(moduleSource.includes("require('child_process')"), false)
  assert.equal(moduleSource.includes("require('fs')"), false)

  assert.match(sidebar, /Restart dev app/)
  assert.match(sidebar, /shouldOfferDevAppRestart/)
  assert.equal(sidebar.includes('webContents.reload'), false)
  assert.equal(sidebar.includes('location.reload'), false)
  const androidAppGroup = sidebar.slice(
    sidebar.indexOf('<p className="side-nav-label">App</p>'),
    sidebar.indexOf('</nav>'),
  )
  assert.equal(androidAppGroup.includes('Restart dev app'), false)
})
