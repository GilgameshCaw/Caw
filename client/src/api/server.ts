import express from 'express'
import cors, { CorsOptions } from 'cors'
import rateLimit from 'express-rate-limit'
import http from 'http'
import path from 'path'
import DmWebSocketService from '../services/DmService/websocket'
import actionsRouter from './routes/actions'
import cawRouter from './routes/caws'
import txRouter  from './routes/txs'
import hashtagRouter from './routes/hashtags'
import uploadRouter from './routes/upload'
import usersRouter from './routes/users'
import txQueueRouter from './routes/txqueue'
import viewsRouter from './routes/views'
import searchRouter from './routes/search'
import scheduledRouter from './routes/scheduled'
import notificationsRouter from './routes/notifications'
import withdrawalsRouter from './routes/withdrawals'
import dmRouter from './routes/dm'
import dmRelayRouter from './routes/dm-relay'
import giphyRouter from './routes/giphy'
import statsRouter from './routes/stats'
import shorturlRouter from './routes/shorturl'
import instancesRouter from './routes/instances'
import reportsRouter from './routes/reports'
import tipsRouter from './routes/tips'
import bugReportsRouter from './routes/bugReports'
import authRouter from './routes/auth'
import blocksRouter from './routes/blocks'
import sessionsRouter from './routes/sessions'
import pricesRouter from './routes/prices'
import validatorAnalyticsRouter from './routes/validator-analytics'
import cawActivityRouter from './routes/caw-activity'
import marketplaceRouter from './routes/marketplace'
import bookmarksRouter from './routes/bookmarks'
import pinsRouter from './routes/pins'
import meRouter from './routes/me'
import verifyRouter from './routes/verify'
import adminDbRouter from './routes/admin-db'
import ogRouter from './routes/og'
import { spaPrerender } from './util/spaPrerender'
import { getSession } from './sessionStore'
import { prisma } from '../prismaClient'
import { Sentry, sentryEnabled } from '../sentry'

/**
 * natstat: build and configure Express app
 */
export function createApp() {
  const app = express()

  const raw = process.env.ALLOWED_ORIGINS ?? ''
  const allowed = raw
    ? raw.split(',').map(s => s.trim())
    : process.env.NODE_ENV === 'development'
      ? ['*']
      : []

  console.log("PROCESS:", process.env.NODE_ENV)
  const corsOpts: CorsOptions = {
    origin:
      (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
        if (!origin || allowed.includes('*') || allowed.includes(origin))
          return cb(null, true)
        cb(new Error(`Origin ${origin} not allowed by CORS`))
      },
    methods: ['GET','POST','PUT','PATCH','DELETE'],
    credentials: true
  }

  // Public-read cross-origin endpoints. Two routes today:
  //   /api/shorturl/:code  — short-URL metadata, read by sibling nodes
  //                          when a post embeds /s/CODE from another
  //                          instance. The /s/ 302 already exposes the
  //                          same data publicly.
  //   /api/instances       — peer registry list, read by static-hosted
  //                          frontends that need to bootstrap from any
  //                          CAW node regardless of origin. Same data
  //                          as the on-chain registry.
  //
  // Both have NO auth state to leak (no cookies, no tokens, no per-user
  // payloads), so wildcarding them is safe. `credentials: false` is
  // critical: combining `*` with credentials is invalid per spec, so
  // the browser would reject the response.
  //
  // The permissive cors middleware mounts on each path AND the strict
  // global cors below SKIPS them — otherwise the global allow-list
  // would error on foreign origins and short-circuit the request
  // before our permissive handler runs.
  const permissiveCors = cors({ origin: '*', credentials: false, methods: ['GET'] })
  app.use('/api/shorturl/:code', permissiveCors)
  app.use('/api/instances', permissiveCors)

  // Strict global cors. Skipped for the public-read routes above.
  app.use((req, res, next) => {
    if (/^\/api\/shorturl\/[^/]+\/?$/.test(req.path)) return next()
    if (/^\/api\/instances\/?$/.test(req.path)) return next()
    return cors(corsOpts)(req, res, next)
  })
  app.use(express.json({ limit: '50mb' })) // Increase limit for image uploads

  // Serve static uploaded files with security headers
  app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads'), {
    setHeaders: (res) => {
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Security-Policy', "default-src 'none'")
    }
  }))

  // Short URL redirect handler (before API routes)
  app.get('/s/:code', async (req, res) => {
    try {
      const { code } = req.params
      const shortUrl = await prisma.shortUrl.findUnique({
        where: { code }
      })

      if (!shortUrl) {
        return res.status(404).send('Short URL not found')
      }

      // Increment click count (fire and forget)
      prisma.shortUrl.update({
        where: { code },
        data: { clickCount: { increment: 1 } }
      }).catch(err => console.error('Failed to update click count:', err))

      // Redirect to original URL
      return res.redirect(302, shortUrl.originalUrl)
    } catch (error) {
      console.error('GET /s/:code error:', error)
      return res.status(500).send('Server error')
    }
  })

  // Rate limiters — tiered by auth status
  // Unauthenticated: strict daily limit. Authenticated: generous 15-min window.
  const hasValidSession = async (req: express.Request) => {
    const token = req.headers['x-session-token'] as string | undefined
    if (!token) return false
    const session = await getSession(token)
    return session !== null && session.authorizedTokenIds.length > 0
  }

  // Upload: 10/day unauthenticated
  app.use('/api/upload', rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 10,
    skip: hasValidSession,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads. Verify your wallet to increase your limit.' }
  }))
  // Upload: 30/15min authenticated
  app.use('/api/upload', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    skip: async (req) => !(await hasValidSession(req)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads, try again later' }
  }))

  // Short URL creation: 10/day unauthenticated (POST only — GET metadata reads are unlimited)
  const shorturlCreateLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 10,
    skip: hasValidSession,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many short URL requests. Verify your wallet to increase your limit.' }
  })
  // Short URL creation: 60/15min authenticated
  const shorturlCreateLimiterAuth = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    skip: async (req) => !(await hasValidSession(req)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many short URL requests, try again later' }
  })
  app.post('/api/shorturl', shorturlCreateLimiter, shorturlCreateLimiterAuth)

  // Marketplace sold: rate limit to prevent spam (5 per minute per IP)
  app.post('/api/marketplace/listings/:id/sold', rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' }
  }))

  // Health check — used by the watchdog's HTTP probe
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok' }) })

  // API routes
  app.use('/api/auth', authRouter)
  app.use('/api/actions', actionsRouter)
  app.use('/api/caws', cawRouter)
  app.use('/api/txs',  txRouter)
  app.use('/api/hashtags', hashtagRouter)
  app.use('/api/upload', uploadRouter)
  app.use('/api/users', usersRouter)
  app.use('/api/users', cawActivityRouter) // Mounts GET /:tokenId/caw-activity under /api/users
  app.use('/api/system', cawActivityRouter) // Mounts GET /caw-activity-all under /api/system
  app.use('/api/txqueue', txQueueRouter)
  app.use('/api/views', viewsRouter)
  app.use('/api/search', searchRouter)
  app.use('/api/scheduled', scheduledRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/withdrawals', withdrawalsRouter)
  app.use('/api/dm', dmRouter)
  app.use('/api/dm/relay', dmRelayRouter)
  app.use('/api/giphy', giphyRouter)
  app.use('/api/stats', statsRouter)
  app.use('/api/shorturl', shorturlRouter)
  app.use('/api/instances', instancesRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/tips', tipsRouter)
  app.use('/api/bug-reports', bugReportsRouter)
  app.use('/api/sessions', sessionsRouter)
  app.use('/api/prices', pricesRouter)
  app.use('/api/blocks', blocksRouter)
  app.use('/api/validator-analytics', validatorAnalyticsRouter)
  app.use('/api/marketplace', marketplaceRouter)
  app.use('/api/bookmarks', bookmarksRouter)
  app.use('/api/pins', pinsRouter)
  app.use('/api/me', meRouter)
  app.use('/api/verify', verifyRouter)
  app.use('/api/admin/db', adminDbRouter)
  app.use('/api/og', ogRouter)

  app.get('/api/__sentry-test', (_req, _res) => {
    throw new Error('Sentry backend test error')
  })

  // SPA prerender for crawler User-Agents (Twitterbot, Slackbot, Discordbot,
  // facebookexternalhit, etc.). nginx routes only matching UAs through to
  // this catch-all; real users get the static dist/index.html from nginx
  // directly. The handler mirrors React Router's path patterns and injects
  // per-URL og:* / twitter:* meta tags into the SPA shell.
  // Express 5: a regex catches everything that didn't match an /api/*
  // route above without tripping path-to-regexp on the literal '*'.
  app.get(/.*/, spaPrerender)

  if (sentryEnabled) Sentry.setupExpressErrorHandler(app)

  return app
}

/**
 * natstat: start the HTTP server
 */
export function startApi(port = Number(process.env.API_PORT) || 4000) {
  const app    = createApp()
  const server = http.createServer(app)

  // Bind localhost-only by default. nginx (the production fronting layer)
  // talks to this via proxy_pass http://127.0.0.1:<port>, which means
  // there's no reason for the API socket to be reachable from outside the
  // box. Listening on 0.0.0.0 was the Express default and let the API be
  // hit directly over plaintext HTTP, bypassing nginx-level rate limits,
  // CORS, TLS, and any access controls. Operators who genuinely need
  // a non-localhost bind (multi-host deploys, container networking that
  // doesn't pass through localhost) set BIND_HOST explicitly.
  // Reported by Zin.
  const bindHost = process.env.BIND_HOST || '127.0.0.1'

  // Initialize WebSocket server for DMs
  DmWebSocketService.initialize(server)

  // EADDRINUSE: retry a few times with short backoff for the common race
  // where a previous child is still releasing the socket. If after
  // MAX_RETRIES the port is still busy, throw — letting the watchdog
  // restart us, or in the worst case the dev-api-runner respawn.
  //
  // Why bounded: a previous version retried FOREVER in-process. When the
  // watchdog's stale-heartbeat restart then called start() again in the
  // SAME process, a second http.Server would try to bind the same port,
  // EADDRINUSE against the first, retry forever too, and the watchdog
  // would keep restarting — spawning a growing pile of zombie servers
  // all inside one Node process.
  //
  // Retry timer is tracked on the server instance so stopApi() can cancel
  // it — prevents a stopped service's retry from firing after teardown.
  const MAX_RETRIES = 3
  let retryAttempt = 0
  let retryTimer: NodeJS.Timeout | null = null
  ;(server as any).__retryTimer = null

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      retryAttempt++
      if (retryAttempt > MAX_RETRIES) {
        console.error(
          `[API] Port ${port} still busy after ${MAX_RETRIES} retries. ` +
          `Kill the stale listener: lsof -iTCP:${port} -sTCP:LISTEN -t | xargs kill -9`
        )
        // Emit 'error' synchronously to signal failure to the service layer.
        // Throwing here would bubble as an uncaught exception; instead we
        // process.exit so dev-api-runner respawns us cleanly (and its port
        // sweep kills the zombie before the new process starts).
        process.exit(1)
      }
      const delayMs = 1_000 * retryAttempt
      console.warn(`[API] Port ${port} busy (attempt ${retryAttempt}/${MAX_RETRIES}), retrying in ${delayMs / 1000}s…`)
      retryTimer = setTimeout(() => {
        retryTimer = null
        ;(server as any).__retryTimer = null
        server.listen(port, bindHost)
      }, delayMs)
      ;(server as any).__retryTimer = retryTimer
      return
    }
    throw err
  })

  server.listen(port, bindHost, () =>
    console.log(`API listening on http://${bindHost}:${port}`)
  )
  return server
}

/**
 * natstat: stop the HTTP server
 */
export function stopApi(server: http.Server) {
  // Cancel any pending EADDRINUSE retry so a stopped server doesn't
  // wake up later and try to listen again in a recycled process.
  const pending = (server as any).__retryTimer
  if (pending) {
    clearTimeout(pending)
    ;(server as any).__retryTimer = null
  }
  return new Promise<void>(res => server.close(() => res()))
}

