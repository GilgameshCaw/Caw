import * as fs from 'fs'
import * as path from 'path'

class ScheduledPostLogger {
  private logStream: fs.WriteStream | null = null
  private logsDir: string
  private logDate = ''
  private enableConsole: boolean

  constructor(enableConsole = false) {
    this.enableConsole = enableConsole

    // Create logs directory if it doesn't exist
    this.logsDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true })
    }

    this.rollover()
  }

  // The file is named after the UTC date of the lines it holds. The instance
  // is a module-level singleton, so the date used to be fixed at process start
  // and a long-running process kept appending to that one file. Reopen when
  // the date changes instead.
  private rollover() {
    const date = new Date().toISOString().split('T')[0]
    if (date === this.logDate) return
    this.logStream?.end()
    this.logDate = date
    const stream = fs.createWriteStream(path.join(this.logsDir, `scheduled-posts-${date}.log`), { flags: 'a' })
    // Without a listener, a write error (disk full, permissions) surfaces as
    // an unhandled 'error' event and takes the whole process down. Stop
    // writing for the rest of the day instead; the next date reopens.
    stream.on('error', (err) => {
      console.error(`[ScheduledPost] log file write failed, dropping file logging until the date changes: ${err.message}`)
      if (this.logStream === stream) this.logStream = null
    })
    this.logStream = stream
  }

  private formatMessage(level: string, message: string): string {
    this.rollover()
    const timestamp = new Date().toISOString()
    return `[${timestamp}] [${level}] ${message}\n`
  }

  log(message: string) {
    const formatted = this.formatMessage('INFO', message)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.log(`[ScheduledPost] ${message}`)
    }
  }

  error(message: string, err?: any) {
    const errorMsg = err ? `${message}: ${err.message || err}` : message
    const formatted = this.formatMessage('ERROR', errorMsg)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.error(`[ScheduledPost] ${errorMsg}`)
    }
  }

  warn(message: string) {
    const formatted = this.formatMessage('WARN', message)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.warn(`[ScheduledPost] ${message}`)
    }
  }

  close() {
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
  }
}

// Export singleton instance
export const scheduledPostLogger = new ScheduledPostLogger(true) // Enable console logging for visibility
