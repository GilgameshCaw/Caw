import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(import.meta.url)
const files = ['client/.env', 'docker-compose.yml']

// Under the installer lock, recover the last committed pair before reading
// saved credentials. A rollback snapshot stays available until both target
// renames finish. Recovery can itself be interrupted and repeated.
export function updatePair(dir, values) {
  const pending = path.join(dir, '.caw-db-pending')
  function replace(name, content) {
    const dest = path.join(dir, name)
    if (content === null) {
      fs.rmSync(dest, { force: true })
      return
    }
    const tmp = fs.mkdtempSync(path.join(path.dirname(dest), '.caw-db-write-'))
    try {
      const file = path.join(tmp, 'new')
      fs.writeFileSync(file, content, { mode: 0o600 })
      fs.renameSync(file, dest)
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
  function restore() {
    if (!fs.existsSync(pending)) return
    const previous = JSON.parse(fs.readFileSync(pending, 'utf8'))
    if (!Array.isArray(previous) || previous.length !== 2 ||
        !previous.every(v => v === null || typeof v === 'string')) throw Error('Invalid database configuration recovery file.')
    const decoded = previous.map(value => {
      if (value === null) return null
      const bytes = Buffer.from(value, 'base64')
      if (bytes.toString('base64') !== value) throw Error('Invalid database configuration recovery file.')
      return bytes
    })
    files.forEach((name, i) => replace(name, decoded[i]))
    fs.unlinkSync(pending)
  }
  restore()
  if (!values) return
  const previous = files.map(name => {
    try { return fs.readFileSync(path.join(dir, name)).toString('base64') }
    catch (e) { if (e.code === 'ENOENT') return null; throw e }
  })
  replace('.caw-db-pending', JSON.stringify(previous))
  try {
    files.forEach((name, i) => replace(name, values[i]))
    fs.unlinkSync(pending)
  } catch (e) {
    restore()
    throw e
  }
}

export function dockerConfigPair(dir, values) {
  if (process.platform === 'linux') {
    // util-linux flock releases its advisory directory lock on process exit.
    execFileSync('flock', ['-x', path.resolve(dir), process.execPath, worker, path.resolve(dir)], {
      input: JSON.stringify(values ?? null), stdio: ['pipe', 'ignore', 'inherit'],
    })
  } else updatePair(dir, values)
}

if (process.argv[1] && path.resolve(process.argv[1]) === worker) {
  updatePair(process.argv[2], JSON.parse(fs.readFileSync(0, 'utf8')))
}
