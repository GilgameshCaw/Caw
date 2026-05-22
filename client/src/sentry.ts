import * as Sentry from '@sentry/node'

const REDACTED = '[REDACTED]'
const SENSITIVE_HEADER = /(token|password|signature)/i
const ALWAYS_SCRUB = new Set(['x-session-token', 'authorization', 'cookie'])

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend(event) {
      const headers = event.request?.headers
      if (headers && typeof headers === 'object') {
        for (const key of Object.keys(headers)) {
          if (ALWAYS_SCRUB.has(key.toLowerCase()) || SENSITIVE_HEADER.test(key)) {
            headers[key] = REDACTED
          }
        }
      }
      return event
    },
  })
}

export { Sentry }
export const sentryEnabled = Boolean(dsn)
