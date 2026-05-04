import * as Sentry from '@sentry/react'

const dsn = import.meta.env.VITE_SENTRY_DSN

if (dsn) {
  // Initialize Sentry synchronously so error capture is live from the
  // first render — that's the whole point of having Sentry. The replay
  // integration, on the other hand, ships ~150KB of recording machinery
  // into the entry bundle and runs continuously even on healthy sessions.
  // We add it after first paint instead, when the main thread is idle.
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: import.meta.env.MODE === 'development' ? 1.0 : 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  })

  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('sentry-test')) {
    setTimeout(() => { throw new Error('Sentry frontend test error') }, 100)
  }

  // Defer replay integration. lazyLoadIntegration is Sentry's official
  // helper for exactly this — it dynamically imports the integration
  // module and registers it on the active client. Falls back to setTimeout
  // when requestIdleCallback isn't available (Safari pre-17.4 still
  // doesn't ship it).
  if (typeof window !== 'undefined') {
    const addReplay = async () => {
      try {
        const replay = await Sentry.lazyLoadIntegration('replayIntegration')
        Sentry.getClient()?.addIntegration(replay())
      } catch {
        // Network error fetching the integration chunk — fail silent. We
        // still have base error capture; replay is best-effort.
      }
    }
    if ('requestIdleCallback' in window) {
      ;(window as any).requestIdleCallback(addReplay, { timeout: 4000 })
    } else {
      setTimeout(addReplay, 2000)
    }
  }
}
