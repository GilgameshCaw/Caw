// Polyfill File for Node.js 18
if (typeof globalThis.File === 'undefined') {
  (globalThis as any).File = class File {
    constructor(public bits: any[], public name: string, public options?: any) {}
  }
}

import runServices, { RunServicesConfig } from '../src/runServices'
import fs from 'fs'
import process from 'process'
import 'reflect-metadata'
import { logger } from '../src/utils/logger'

if (!fs.existsSync('config.json')) {
  console.error('config.json not found; copy from template')
  process.exit(1)
}

const config = RunServicesConfig.parse(
  JSON.parse(fs.readFileSync('config.json', 'utf8'))
)

// Use the logger to log startup
logger.log('CAW API Server Starting...')
logger.log('Configuration loaded from config.json')

// Add process-level error handlers to prevent crashes
// This prevents the entire server from crashing when a single service fails.
// The service-level watchdog (runServices.ts) is responsible for restarting
// individual services whose heartbeats go stale — these handlers just keep
// the process alive and capture as much context as possible for debugging.
process.on('uncaughtException', (error: any) => {
  const ts = new Date().toISOString()
  console.error('==========================================')
  console.error(`[Server ${ts}] UNCAUGHT EXCEPTION`)
  console.error(`[Server] Message: ${error?.message || error}`)
  if (error?.stack) {
    console.error(`[Server] Stack:\n${error.stack}`)
  }
  console.error('==========================================')
  logger.log(`Uncaught Exception: ${error?.message || JSON.stringify(error)}`)
  if (error?.stack) logger.log(`Stack: ${error.stack}`)
  console.log('[Server] Continuing — watchdog will restart any stalled services')
})

console.log('[Server] Uncaught exception handler registered')

process.on('unhandledRejection', (reason: any, _promise) => {
  const ts = new Date().toISOString()
  const reasonStr = reason instanceof Error ? reason.message : String(reason)
  console.error('==========================================')
  console.error(`[Server ${ts}] UNHANDLED REJECTION`)
  console.error(`[Server] Reason: ${reasonStr}`)
  if (reason instanceof Error && reason.stack) {
    console.error(`[Server] Stack:\n${reason.stack}`)
  }
  console.error('==========================================')
  logger.log(`Unhandled Rejection: ${reasonStr}`)
  if (reason instanceof Error && reason.stack) logger.log(`Stack: ${reason.stack}`)
  console.log('[Server] Continuing — watchdog will restart any stalled services')
})

runServices(config)

