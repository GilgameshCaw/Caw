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
import onChainImagesRouter from './routes/on-chain-images'
import clientsRouter from './routes/clients'
import reportsRouter from './routes/reports'
import tipsRouter from './routes/tips'
import bugReportsRouter from './routes/bugReports'
import authRouter from './routes/auth'
import blocksRouter from './routes/blocks'
import sessionsRouter from './routes/sessions'
import pricesRouter from './routes/prices'
import validatorAnalyticsRouter from './routes/validator-analytics'
import marketplaceRouter from './routes/marketplace'
import bookmarksRouter from './routes/bookmarks'
import { getSession } from './sessionStore'
import { prisma } from '../prismaClient'

/**
 * natstat: build and configure Express app
 */
function createApp() {
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

  app.use(cors(corsOpts))
  app.use(express.json({ limit: '50mb' })) // Increase limit for image uploads

  // Serve static uploaded files
  app.use('/uploads', express.static(path.join(process.cwd(), 'public', 'uploads')))

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

  // Short URL: 10/day unauthenticated
  app.use('/api/shorturl', rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 10,
    skip: hasValidSession,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many short URL requests. Verify your wallet to increase your limit.' }
  }))
  // Short URL: 60/15min authenticated
  app.use('/api/shorturl', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    skip: async (req) => !(await hasValidSession(req)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many short URL requests, try again later' }
  }))

  // API routes
  app.use('/api/auth', authRouter)
  app.use('/api/actions', actionsRouter)
  app.use('/api/caws', cawRouter)
  app.use('/api/txs',  txRouter)
  app.use('/api/hashtags', hashtagRouter)
  app.use('/api/upload', uploadRouter)
  app.use('/api/users', usersRouter)
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
  app.use('/api/on-chain-images', onChainImagesRouter)
  app.use('/api/clients', clientsRouter)
  app.use('/api/reports', reportsRouter)
  app.use('/api/tips', tipsRouter)
  app.use('/api/bug-reports', bugReportsRouter)
  app.use('/api/sessions', sessionsRouter)
  app.use('/api/prices', pricesRouter)
  app.use('/api/blocks', blocksRouter)
  app.use('/api/validator-analytics', validatorAnalyticsRouter)
  app.use('/api/marketplace', marketplaceRouter)
  app.use('/api/bookmarks', bookmarksRouter)

  return app
}

/**
 * natstat: start the HTTP server
 */
export function startApi(port = Number(process.env.API_PORT) || 4000) {
  const app    = createApp()
  const server = http.createServer(app)

  // Initialize WebSocket server for DMs
  DmWebSocketService.initialize(server)

  server.listen(port, () =>
    console.log(`API listening on http://localhost:${port}`)
  )
  return server
}

/**
 * natstat: stop the HTTP server
 */
export function stopApi(server: http.Server) {
  return new Promise<void>(res => server.close(() => res()))
}

