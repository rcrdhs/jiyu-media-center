const { execSync } = require('child_process')

const out = execSync('netstat -ano', { encoding: 'utf8' })
const pids = new Set(
  execSync('wmic process where "name=\'electron.exe\' and ExecutablePath like \'%D:\\\\app%\'" get ProcessId /value', {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .map((l) => l.match(/ProcessId=(\d+)/i)?.[1])
    .filter(Boolean),
)

const remotes = new Set()
for (const line of out.split(/\r?\n/)) {
  if (!/ESTABLISHED/i.test(line)) continue
  const parts = line.trim().split(/\s+/)
  if (parts.length < 5) continue
  const pid = parts[parts.length - 1]
  if (!pids.has(pid)) continue
  const remote = parts[2]
  remotes.add(remote)
}

console.log('electronPids', [...pids])
console.log('remotes', [...remotes].sort())
