#!/usr/bin/env node
/**
 * Watches source files and runs the API server.
 * Restarts on file changes (like nodemon) AND on crashes (unlike nodemon).
 */
const { spawn } = require('child_process')
const { watch } = require('fs')
const path = require('path')

const SRC_DIR = path.join(__dirname, '..', 'src')
const FRONTEND_DIR = path.join(SRC_DIR, 'services', 'FrontEnd', 'src')
const RESTART_DELAY_MS = 3000
const DEBOUNCE_MS = 500

let child = null
let restartTimer = null
let stopping = false

function startServer() {
  if (stopping) return
  if (child) return // already running

  console.log('[dev-api] Starting server...')
  child = spawn('node', ['-r', './file-polyfill.js', '-r', 'tsx/cjs', 'programs/start.ts'], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopping) return
    if (signal === 'SIGTERM' || signal === 'SIGINT') return // intentional kill (file change restart)
    if (code !== 0) {
      console.error(`[dev-api] Server crashed (code=${code}), restarting in ${RESTART_DELAY_MS / 1000}s...`)
      setTimeout(startServer, RESTART_DELAY_MS)
    }
  })
}

function restartServer() {
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    console.log('[dev-api] File change detected, restarting...')
    if (child) {
      child.once('exit', () => { child = null; startServer() })
      child.kill('SIGTERM')
      // Force kill after 5s if graceful shutdown hangs
      setTimeout(() => { if (child) { child.kill('SIGKILL'); child = null; startServer() } }, 5000)
    } else {
      startServer()
    }
  }, DEBOUNCE_MS)
}

// Watch source files (excluding frontend)
function watchDir(dir) {
  try {
    watch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return
      const full = path.join(dir, filename)
      // Skip frontend source, node_modules, and non-source files
      if (full.startsWith(FRONTEND_DIR)) return
      if (full.includes('node_modules')) return
      if (!/\.(ts|js|json)$/.test(filename)) return
      restartServer()
    })
  } catch (e) {
    console.warn(`[dev-api] Could not watch ${dir}:`, e.message)
  }
}

watchDir(SRC_DIR)

// Graceful shutdown
process.on('SIGINT', () => { stopping = true; if (child) child.kill('SIGTERM'); process.exit(0) })
process.on('SIGTERM', () => { stopping = true; if (child) child.kill('SIGTERM'); process.exit(0) })

startServer()
