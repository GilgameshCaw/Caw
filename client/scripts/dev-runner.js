#!/usr/bin/env node
// Dev runner — auto-restarts crashed services via concurrently.
// Type "stop" or "quit" to shut down. Ctrl+C also works (once = graceful, twice = force).

const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const PIDFILE = '/tmp/caw-dev-runner.pid'
const CLIENT_DIR = path.resolve(__dirname, '..')

let child = null
let stopping = false
let ctrlCCount = 0

function sweepStaleListeners() {
  // Free ports 4000 (API) and 5274 (vite) from any process that outlived
  // a previous session. start-dev.sh runs stop-dev.sh once at launch,
  // but that doesn't cover ctrl+c exits (common during dev) where the
  // old vite/API processes were orphaned and kept running.
  //
  // Narrow scope: only port-level kills. We can't invoke stop-dev.sh
  // directly because it contains `pkill -f dev-runner.js` which would
  // kill this very process mid-sweep.
  for (const port of [4000, 5274]) {
    try {
      const pids = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, {
        encoding: 'utf8',
      }).trim()
      if (pids) {
        console.log(`[dev-runner] Killing stale listener on :${port} (pid ${pids.replace(/\n/g, ', ')})`)
        execSync(`echo "${pids}" | xargs kill -9 2>/dev/null`, { stdio: 'ignore' })
      }
    } catch {
      // lsof exits non-zero when no listener is found — not an error.
    }
  }
}

function startConcurrently() {
  if (stopping) return

  sweepStaleListeners()

  // NOTE: `npm run web` is intentionally NOT in this list. The FrontEnd
  // service inside programs/start.ts (via config.json's "FrontEnd" entry)
  // already spawns `yarn dev` in src/services/FrontEnd/. Running both
  // supervisors launched TWO vites that fought over port 5274, each one's
  // failure cascading back through concurrently/watchdog/dev-api-runner
  // into a stack-wide restart storm. If you need vite without the full
  // server stack, run `npm run web` standalone in a separate terminal.
  child = spawn('npx', [
    'concurrently',
    '--restart-tries', '-1',
    '--restart-after', 'exponential',
    'npm run postgres',
    'npm run elasticsearch',
    'npm run redis',
    'npm run dev:api',
  ], {
    cwd: CLIENT_DIR,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  })

  child.on('exit', (code) => {
    child = null
    if (stopping) return
    console.log(`[dev-runner] concurrently exited (code ${code}), restarting in 3s...`)
    setTimeout(startConcurrently, 3000)
  })
}

function killProcessGroup(pid) {
  try { process.kill(-pid, 'SIGTERM') } catch {}
}

function killByPattern() {
  const patterns = ['concurrently.*restart-tries', 'programs/start.ts', 'nodemon.*--watch', 'vite.*FrontEnd']
  for (const p of patterns) {
    try { execSync(`pkill -f '${p}' 2>/dev/null`, { stdio: 'ignore' }) } catch {}
  }
}

function forceKillByPattern() {
  const patterns = ['concurrently.*restart-tries', 'programs/start.ts', 'nodemon.*--watch', 'vite.*FrontEnd']
  for (const p of patterns) {
    try { execSync(`pkill -9 -f '${p}' 2>/dev/null`, { stdio: 'ignore' }) } catch {}
  }
}

function stopAll() {
  if (stopping) return
  stopping = true
  console.log('\nShutting down...')

  // 1. Detach the exit handler so we don't respawn
  if (child) {
    child.removeAllListeners('exit')
    // 2. Kill the entire process group (concurrently + all its children)
    killProcessGroup(child.pid)
    child = null
  }

  // 3. Sweep anything that survived
  killByPattern()

  // 4. Wait, then force-kill stragglers and exit
  setTimeout(() => {
    forceKillByPattern()
    try { fs.unlinkSync(PIDFILE) } catch {}
    console.log('All services stopped.')
    process.exit(0)
  }, 2000)
}

// Ctrl+C: first = graceful stop, second = force kill
process.on('SIGINT', () => {
  ctrlCCount++
  if (ctrlCCount >= 2) {
    console.log('\nForce killing...')
    if (child) killProcessGroup(child.pid)
    forceKillByPattern()
    try { fs.unlinkSync(PIDFILE) } catch {}
    process.exit(1)
  }
  stopAll()
})

// dev:stop sends SIGTERM
process.on('SIGTERM', stopAll)

// Write PID file
fs.writeFileSync(PIDFILE, String(process.pid))

console.log('======================================')
console.log('  CAW Dev Server')
console.log('  Type "stop" or "quit" to shut down')
console.log('  Ctrl+C to stop (twice to force)')
console.log('======================================')
console.log('')

startConcurrently()

// Interactive input
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const cmd = line.trim().toLowerCase()
  switch (cmd) {
    case 'stop':
    case 'quit':
    case 'exit':
      stopAll()
      break
    case 'status':
      console.log(`[dev-runner] PID: ${process.pid}, child PID: ${child?.pid || 'none'}`)
      try {
        const out = execSync(
          "ps aux | grep -E 'concurrently|nodemon|vite|redis-server|elasticsearch|programs/start' | grep -v grep",
          { encoding: 'utf8' }
        )
        console.log(out)
      } catch { console.log('  (no matching processes)') }
      break
    case 'restart':
      console.log('[dev-runner] Restarting...')
      if (child) {
        child.removeAllListeners('exit')
        killProcessGroup(child.pid)
        child = null
      }
      killByPattern()
      setTimeout(startConcurrently, 1000)
      break
    default:
      if (cmd) console.log(`[dev-runner] Unknown: '${cmd}' (try: stop, quit, status, restart)`)
  }
})
