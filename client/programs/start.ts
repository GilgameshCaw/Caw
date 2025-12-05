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
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  logger.log(`Uncaught Exception: ${error.message}`)
  logger.log(`Stack: ${error.stack}`)

  // Log but don't exit - let the service continue running
  // The individual services should handle their own errors
  console.log('Service continuing despite uncaught exception...')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
  logger.log(`Unhandled Rejection: ${reason}`)

  // Log but don't exit
  console.log('Service continuing despite unhandled rejection...')
})

runServices(config)

