import * as Sentry from '@sentry/react'

const dsn = import.meta.env.VITE_SENTRY_DSN

if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: import.meta.env.MODE === 'development' ? 1.0 : 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    integrations: [Sentry.replayIntegration()],
  })

  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sentry-test')) {
    setTimeout(() => { throw new Error('Sentry frontend test error') }, 100)
  }
}
