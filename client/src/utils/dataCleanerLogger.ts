import * as fs from 'fs'
import * as path from 'path'

class DataCleanerLogger {
  private logStream: fs.WriteStream | null = null
  private logFile: string
  private enableConsole: boolean

  constructor(enableConsole = false) {
    this.enableConsole = enableConsole

    // Create logs directory if it doesn't exist
    const logsDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }

    // Create log file with current date
    const date = new Date().toISOString().split('T')[0]
    this.logFile = path.join(logsDir, `data-cleaner-${date}.log`)

    // Create write stream with append flag
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'a' })
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString()
    return `[${timestamp}] [${level}] ${message}\n`
  }

  log(message: string) {
    const formatted = this.formatMessage('INFO', message)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.log(`[DataCleaner] ${message}`)
    }
  }

  error(message: string, err?: any) {
    const errorMsg = err ? `${message}: ${err.message || err}` : message
    const formatted = this.formatMessage('ERROR', errorMsg)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.error(`[DataCleaner] ${errorMsg}`)
    }
  }

  warn(message: string) {
    const formatted = this.formatMessage('WARN', message)
    this.logStream?.write(formatted)

    if (this.enableConsole) {
      console.warn(`[DataCleaner] ${message}`)
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
export const dataCleanerLogger = new DataCleanerLogger(false) // Set to true to also log to console