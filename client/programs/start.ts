// Load .env into process.env before ANY other code reads it. Prisma has its
// own .env loader (so DATABASE_URL has always worked) but everything else
// in the process — Sentry, OTel, validator key, RPC URLs — reads
// process.env directly, and pm2 doesn't pre-populate it from .env. Without
// this call, OTEL_EXPORTER_OTLP_ENDPOINT etc. silently come back undefined
// and the SDK's "if endpoint" gate skips initialization entirely (no traces,
// no error log, no clue why).
//
// require() instead of import to keep this absolutely first; ESM imports
// hoist but their *side effects* run in module dep-graph order, and we'd
// rather not depend on that ordering being stable across bundlers.
require('dotenv').config()

// OpenTelemetry MUST initialize before any module we want to instrument
// (express, prisma, ioredis, http). Auto-instrumentation patches at import
// time, so anything required before this point won't be traced. Keep this
// the very first import after dotenv — even before the File polyfill below.
import { otelEnabled } from '../src/otel'

// Polyfill File for Node.js 18
if (typeof globalThis.File === 'undefined') {
  (globalThis as any).File = class File {
    constructor(public bits: any[], public name: string, public options?: any) {}
  }
}

import { Sentry, sentryEnabled } from '../src/sentry'
import runServices, { RunServicesConfig } from '../src/runServices'
import fs from 'fs'
import process from 'process'
import 'reflect-metadata'
import { logger } from '../src/utils/logger'

if (sentryEnabled) logger.log('Sentry error reporting enabled')
if (otelEnabled) logger.log('OpenTelemetry tracing enabled')

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
  if (sentryEnabled) Sentry.captureException(error, { tags: { source: 'uncaughtException' } })
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
  if (sentryEnabled) Sentry.captureException(reason, { tags: { source: 'unhandledRejection' } })
  console.log('[Server] Continuing — watchdog will restart any stalled services')
})

runServices(config)

