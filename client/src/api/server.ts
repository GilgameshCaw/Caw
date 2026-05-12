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
import dmGroupsRouter from './routes/dm-groups'
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
import adminUsersRouter from './routes/admin-users'
import adminValidatorRouter from './routes/admin-validator'
import moderationRouter from './routes/moderation'
import ogRouter from './routes/og'
import sitemapRouter from './routes/sitemap'
import rpcProxyRouter from './routes/rpc-proxy'
import { spaPrerender } from './util/spaPrerender'
import { cawPath, parseCawIdSlug } from './util/cawUrl'
import { parseLocaleFromPath, withLocalePrefix } from './util/localePrefix'
import { getSession } from './sessionStore'
import { prisma } from '../prismaClient'
import { Sentry, sentryEnabled } from '../sentry'

/**
 * natstat: build and configure Express app
 */
export function createApp() {
  const app = express()

  // We sit behind nginx on the VPS — trust the X-Forwarded-For from the
  // immediate upstream so express-rate-limit (and any req.ip consumer)
  // sees the real client IP. Without this, every per-IP rate-limiter
  // collapses to a single 127.0.0.1 bucket and emits
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation errors. Audit fix
  // 2026-05-09 (Round 5 VPS H-2). 'loopback' = trust 127.0.0.1, ::1
  // only — safe; the value won't be honored from public clients.
  app.set('trust proxy', 'loopback')

  // Don't advertise Express. Free fingerprinting for attackers
  // otherwise. Audit fix 2026-05-09 (Round 5 VPS M-4).
  app.disable('x-powered-by')

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

  // Security headers for every response (HTML + JSON + everything).
  // CSP is the headline — it makes XSS exploitation much harder by
  // restricting which scripts can run + where the page can connect to
  // for exfiltration. With our localStorage-stored DM keys + session
  // tokens, this is the strongest single defense-in-depth measure.
  // Audit fix 2026-05-10 (Round 7 #3).
  //
  // The inline-script hash covers the theme-flash-prevention block in
  // FrontEnd/index.html (computed via SHA-256 over the literal script
  // content). If that script changes, regenerate the hash:
  //   node -e "require('crypto').createHash('sha256').update(\$SCRIPT).digest('base64')"
  // Builds bundle the same script into dist/index.html, so the same
  // hash works whether we serve via Express prerender or nginx static.
  //
  // 'connect-src' is the most operator-specific knob: it must include
  // every origin the FE talks to (api itself, peer instances, RPC
  // endpoints, X OAuth, Filebase media proxy, etc.). The default
  // values cover the test.caw.social setup; production deploys may
  // need to widen via CSP_ADDITIONAL_CONNECT_SRC env (comma-separated).
  const cspExtra = (process.env.CSP_ADDITIONAL_CONNECT_SRC || '').split(',').map(s => s.trim()).filter(Boolean)
  const connectSrc = [
    "'self'",
    "https://*.caw.social",
    "wss://*.caw.social",
    "https://*.alchemyapi.io",
    "https://*.infura.io",
    "https://*.publicnode.com",
    "https://api.x.com",
    "https://*.filebase.io",
    ...cspExtra,
  ].join(' ')
  const inlineScriptHash = "'sha256-xkVMad1A/6ozRonIOqWni0BBYrgJP5OHmcnrwTlUgGc='"
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHash}`,
    // Tailwind v4 + emotion + react-router etc. produce inline styles
    // at runtime; 'unsafe-inline' for styles is the standard SPA
    // tradeoff. The XSS surface here is "attacker can change CSS"
    // which is much narrower than full script execution.
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    // img-src wide because user-uploaded media legitimately comes
    // from cross-mirror /uploads/ paths AND filebase. The actual
    // shape-validation happens in EncryptedImage / ContentWithHashtags
    // (Round 5 fix). This just says the BROWSER may load such URLs.
    `img-src 'self' data: blob: https:`,
    `media-src 'self' blob: https:`,
    `connect-src ${connectSrc}`,
    // OAuth popup for X verification opens a popup that posts back
    // via localStorage events. No frame-src needed — the popup is
    // top-level, not embedded.
    `frame-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ].join('; ')

  app.use((req, res, next) => {
    // Don't apply security headers to /uploads — that path has its
    // own stricter CSP (default-src 'none') already set by the static
    // handler. Headers set here would compose oddly with that.
    if (req.path.startsWith('/uploads/')) return next()
    res.set('Content-Security-Policy', csp)
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
    // X-Frame-Options is the legacy companion to frame-ancestors.
    // Some old browsers honor only this one.
    res.set('X-Frame-Options', 'DENY')
    next()
  })

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

      // Defense-in-depth: re-validate the stored URL is http(s) before
      // redirecting. Both the create endpoints (POST /api/shorturl and
      // /bulk) gate on this, but legacy rows may exist and storing
      // `javascript:` / `data:` / `file:` here would let a redirect
      // surface the unsafe scheme. Audit fix 2026-05-09 (Round 5 API
      // HIGH-1).
      let safe: URL
      try {
        safe = new URL(shortUrl.originalUrl)
      } catch {
        return res.status(400).send('Invalid stored URL')
      }
      if (safe.protocol !== 'http:' && safe.protocol !== 'https:') {
        return res.status(400).send('Unsupported URL scheme')
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

  // Cross-node DM relay: per-source-IP rate limit. Outer ring against a
  // misbehaving peer node hammering us regardless of which user wallets
  // it claims to be relaying for. The per-(senderId, recipientId)
  // bucket is enforced by the source instance on its send path; this
  // is the receiver's coarse safety net. 1000 req/min covers a busy
  // mirror; bump via env if the threshold becomes real-world tight.
  const dmRelayMax = Number(process.env.DM_RELAY_RATE_LIMIT_PER_MIN) || 1000
  app.use('/api/dm/relay', rateLimit({
    windowMs: 60 * 1000,
    max: dmRelayMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many relay requests, slow down' }
  }))
  // Identity relay: lower cap. A user re-registering 100/min is already
  // anomalous; the steady-state load is "every new DM-enable + every
  // wallet transfer". 60/min per source IP is generous.
  app.use('/api/dm/identity/relay', rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.DM_IDENTITY_RELAY_RATE_LIMIT_PER_MIN) || 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many identity relay requests, slow down' }
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
  // Group-chat sub-router mounted BEFORE the main DM router so its
  // /groups/* paths match before any catchier route in dm.ts.
  app.use('/api/dm', dmGroupsRouter)
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
  app.use('/api/admin/users', adminUsersRouter)
  app.use('/api/admin/validator', adminValidatorRouter)
  app.use('/api/moderation', moderationRouter)
  app.use('/api/og', ogRouter)
  // /sitemap.xml + /robots.txt mounted at root, ahead of the SPA prerender
  // catch-all. Crawler-only surfaces but routed through Express for both
  // crawler and user requests since nginx doesn't gate /sitemap.xml.
  app.use('/', sitemapRouter)
  // FE → backend → upstream RPC. Wagmi config in the FE points at
  // /api/rpc/l1 and /api/rpc/l2; the proxy folds identical reads
  // into one upstream request and caches "latest"-block results for
  // a few seconds across all callers. Keeps the Infura key out of
  // the FE bundle and gives us a single chokepoint for retries,
  // failover, and rate limiting.
  app.use('/api/rpc', rpcProxyRouter)

  app.get('/api/__sentry-test', (_req, _res) => {
    throw new Error('Sentry backend test error')
  })

  // 301 canonical redirects for caw URLs, ahead of the SPA prerender.
  // Drift cases handled:
  //   1. Legacy /caws/:id              → /users/<owner>/caw/<id>-<slug>
  //   2. Stale username on canonical   → /users/<currentOwner>/caw/<id>-<slug>
  //   3. Missing/stale slug            → /users/<owner>/caw/<id>-<currentSlug>
  //   4. /en/... locale prefix         → bare (English is bare-canonical)
  //   5. /<locale>/caws/:id (legacy under locale prefix) → /<locale>/users/...
  //   6. /<locale>/users/.../caw/<id-staleslug> → same with current slug
  // Lookup is by numeric id only — slug is decorative.

  // /en/... explicitly canonicalizes back to bare. English is the bare-URL
  // locale and we don't want both /en/foo and /foo indexed as separate
  // pages. ANY path under /en/ qualifies, not just caws.
  app.get(/^\/en(\/.*)?$/, (req, res, next) => {
    const rest = req.params[0] || '/'
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
    if (rest === req.path) return next()
    res.redirect(301, `${rest}${qs}`)
  })

  // Caw URL redirects — match both bare and locale-prefixed shapes.
  // (?:\/[a-z]{2,3})? is an optional 2-3 char locale segment; we
  // validate it via parseLocaleFromPath rather than matching against
  // the full locale list here.
  app.get(/^((?:\/[a-z]{2,3})?)\/caws\/(\d+)\/?$/, async (req, res, next) => {
    try {
      const localeSegment = req.params[0] || ''
      const id = Number(req.params[1])
      if (!Number.isFinite(id) || id <= 0) return next()
      const locale = localeSegment ? parseLocaleFromPath(localeSegment + '/x').locale : null
      // If the prefix looked like a locale but isn't a real one, fall
      // through — we don't want to invent a redirect for /xx/caws/123.
      if (localeSegment && !locale) return next()
      const caw = await prisma.caw.findUnique({
        where: { id },
        select: { id: true, content: true, user: { select: { username: true } } },
      })
      if (!caw?.user?.username) return next()
      const bare = cawPath({
        id: caw.id,
        username: caw.user.username,
        content: caw.content,
      })
      const target = withLocalePrefix(bare, locale)
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
      res.redirect(301, `${target}${qs}`)
    } catch {
      next()
    }
  })

  app.get(/^((?:\/[a-z]{2,3})?)\/users\/([^/]+)\/caw\/([^/]+)\/?$/, async (req, res, next) => {
    try {
      const localeSegment = req.params[0] || ''
      const idSlug = req.params[2]
      const id = parseCawIdSlug(idSlug)
      if (id == null) return next()
      const locale = localeSegment ? parseLocaleFromPath(localeSegment + '/x').locale : null
      if (localeSegment && !locale) return next()
      const caw = await prisma.caw.findUnique({
        where: { id },
        select: { id: true, content: true, user: { select: { username: true } } },
      })
      if (!caw?.user?.username) return next()
      const bare = cawPath({
        id: caw.id,
        username: caw.user.username,
        content: caw.content,
      })
      const target = withLocalePrefix(bare, locale)
      // Already canonical — pass through to prerender.
      if (target === req.path) return next()
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
      res.redirect(301, `${target}${qs}`)
    } catch {
      next()
    }
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

