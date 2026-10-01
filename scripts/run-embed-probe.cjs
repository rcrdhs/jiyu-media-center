const { spawn } = require('child_process')
const electron = require('electron')
const path = require('path')

const embed = process.argv[2]
const script = path.join(__dirname, 'probe-embed-electron.cjs')
const args = embed ? [script, embed] : [script]
const child = spawn(electron, args, { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
child.stdout.on('data', (d) => {
  out += d
  process.stdout.write(d)
})
child.stderr.on('data', (d) => {
  out += d
  process.stderr.write(d)
})
child.on('exit', (code) => process.exit(code ?? 1))
setTimeout(() => {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  console.error('TIMEOUT', out.slice(-500))
  process.exit(1)
}, 50000)
