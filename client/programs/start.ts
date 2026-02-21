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

  // Special handling for WebSocket/network errors - don't crash the server
  const errorStr = error.message || JSON.stringify(error)
  const errorCode = error.code || ''

  if (errorStr.includes('429') ||
      errorStr.includes('Unexpected server response') ||
      errorStr.includes('WebSocket') ||
      errorCode === 'ECONNREFUSED' ||
      errorCode === 'ETIMEDOUT' ||
      errorCode === 'ENOTFOUND' ||
      errorCode === 'ENETUNREACH' ||
      errorStr.includes('rate limit')) {
    console.log('[Server] Network/rate limit error detected - services will retry')
    logger.log('Network error detected - API server continuing with degraded functionality')
    // Explicitly prevent exit - services have retry logic
    return
  }

  // For other errors, log but don't crash
  console.error('[Server] Error stack:', error.stack)
  logger.log(`Stack: ${error.stack || 'No stack trace'}`)
  console.log('[Server] Continuing despite uncaught exception - check logs')
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

