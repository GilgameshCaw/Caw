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
// This prevents the entire server from crashing when a single service fails
process.on('uncaughtException', (error: any) => {
  console.error('==========================================')
  console.error('[Server] Uncaught Exception Handler Called!')
  console.error('[Server] Error:', error.message || error)
  console.error('==========================================')
  logger.log(`Uncaught Exception: ${error.message || JSON.stringify(error)}`)

  // Log the stack trace
  if (error.stack) {
    console.error('[Server] Stack:', error.stack)
  }

  // ALWAYS continue - never let the process crash from uncaught exceptions
  // The individual services have their own retry/recovery logic
  console.log('[Server] Continuing despite uncaught exception - API server remains running')
  logger.log('Uncaught exception handled - API server continuing')
})

console.log('[Server] Uncaught exception handler registered')

process.on('unhandledRejection', (reason, promise) => {
  const reasonStr = reason instanceof Error ? reason.message : String(reason)
  console.error('[Server] Unhandled Rejection:', reasonStr)
  logger.log(`Unhandled Rejection: ${reasonStr}`)

  // Don't crash on unhandled rejections either
  console.log('[Server] Continuing despite unhandled rejection...')
})

runServices(config)

