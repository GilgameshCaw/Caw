// Only initialize file logging if not in browser environment
const isBrowser = typeof window !== 'undefined'
let logStream: any = null
let logFile: string | null = null

if (!isBrowser) {
  // Lazy load Node.js modules only when not in browser
  const fs = require('fs')
  const path = require('path')

  // Debug output to understand path resolution
  console.log('[LOGGER DEBUG] __dirname:', __dirname)
  console.log('[LOGGER DEBUG] process.cwd():', process.cwd())

  // Create logs directory if it doesn't exist
  // Use process.cwd() which is more reliable than __dirname for finding project root
  const logsDir = path.join(process.cwd(), 'logs')
  console.log('[LOGGER DEBUG] Logs directory path:', logsDir)

  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
      console.log(`[LOGGER] Created logs directory at: ${logsDir}`)
    } else {
      console.log(`[LOGGER] Logs directory already exists at: ${logsDir}`)
    }

    // Log file path with timestamp
    logFile = path.join(logsDir, `caw-client-${new Date().toISOString().split('T')[0]}.log`)
    console.log('[LOGGER DEBUG] Log file path:', logFile)

    // Create a write stream for the log file
    logStream = fs.createWriteStream(logFile, { flags: 'a' })
    console.log(`[LOGGER] Initialized successfully. Writing to: ${logFile}`)

    // Write a test message immediately
    logStream.write(`[${new Date().toISOString()}] Logger initialized successfully\n`)
  } catch (err) {
    console.error('[LOGGER ERROR] Failed to initialize logger:', err)
    console.error('[LOGGER ERROR] Attempted logs directory:', logsDir)
    // Logger will work without file output if initialization fails
  }
}

// Custom logger that writes to both console and file
export const logger = {
  log: (...args: any[]) => {
    const timestamp = new Date().toISOString()
    const message = `[${timestamp}] INFO: ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`

    console.log(...args)
    if (logStream) logStream.write(message)
  },

  error: (...args: any[]) => {
    const timestamp = new Date().toISOString()
    const message = `[${timestamp}] ERROR: ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`

    console.error(...args)
    if (logStream) logStream.write(message)
  },

  warn: (...args: any[]) => {
    const timestamp = new Date().toISOString()
    const message = `[${timestamp}] WARN: ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`

    console.warn(...args)
    if (logStream) logStream.write(message)
  },

  debug: (...args: any[]) => {
    const timestamp = new Date().toISOString()
    const message = `[${timestamp}] DEBUG: ${args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`

    if (process.env.DEBUG) {
      console.debug(...args)
    }
    if (logStream) logStream.write(message)
  },

  getLogPath: () => logFile || 'No log file (browser mode)'
}

// Log startup only if not in browser
if (!isBrowser && logFile) {
  logger.log('='.repeat(80))
  logger.log('CAW Client Logger Started')
  logger.log(`Log file: ${logFile}`)
  logger.log('='.repeat(80))
}

// Handle process termination only if not in browser
if (!isBrowser && logStream) {
  process.on('exit', () => {
    logStream?.end()
  })

  process.on('SIGINT', () => {
    logger.log('Process terminated by user')
    logStream?.end()
    process.exit(0)
  })

  process.on('uncaughtException', (error: any) => {
    const msg = error?.message || String(error)
    const code = error?.code || ''
    const innerCode = error?.error?.code

    // Transient network errors (DNS failure, connection refused, socket hang up)
    // should NOT kill the process — services have their own retry loops.
    const isTransientNetwork =
      code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'EAI_AGAIN' ||
      msg.includes('socket hang up') || msg.includes('ENOTFOUND') ||
      msg.includes('getaddrinfo') || msg.includes('ECONNREFUSED')

    // RPC-layer errors (rate limits, malformed responses, missing response,
    // ethers' 'could not coalesce error') should also NOT kill the process.
    // These bubble up from WebSocket subscribe failures and provider retries;
    // the service-level retry loops handle them.
    const isTransientRpc =
      code === 'UNKNOWN_ERROR' || code === 'BAD_DATA' || code === 'SERVER_ERROR' ||
      innerCode === -32005 /* Infura: Too Many Requests */ ||
      msg.includes('Too Many Requests') || msg.includes('429') ||
      msg.includes('could not coalesce error') || msg.includes('missing response for request') ||
      msg.includes('ERR_MODULE_NOT_FOUND')

    if (isTransientNetwork || isTransientRpc) {
      logger.error(`Uncaught transient error (non-fatal, services will retry): ${msg.slice(0, 200)}`)
      return
    }

    logger.error('Uncaught Exception:', error)
    logStream?.end()
    process.exit(1)
  })

  process.on('unhandledRejection', (reason: any, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
}