import express from 'express'
import cors, { CorsOptions } from 'cors'
import http from 'http'
import path from 'path'
import XmtpWebSocketService from '../services/XmtpService/websocket'
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
import xmtpRouter from './routes/xmtp'
import xmtpSecureRouter from './routes/xmtp-secure'
import xmtpProxyRouter from './routes/xmtpProxy'
import xmtpIdentityRouter from './routes/xmtp-identity'
import conversationsRouter from './routes/conversations'
import giphyRouter from './routes/giphy'
import statsRouter from './routes/stats'
import shorturlRouter from './routes/shorturl'
import onChainImagesRouter from './routes/on-chain-images'
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
    methods: ['GET','POST','PUT','DELETE'],
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

  // API routes
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
  // Old insecure XMTP routes commented out - using secure routes instead
  // app.use('/api/xmtp', xmtpRouter)
  app.use('/api/xmtp', xmtpSecureRouter)
  app.use('/api/xmtp-identity', xmtpIdentityRouter)
  app.use('/api/conversations', conversationsRouter)
  app.use('/api/giphy', giphyRouter)
  app.use('/api/stats', statsRouter)
  app.use('/api/shorturl', shorturlRouter)
  app.use('/api/on-chain-images', onChainImagesRouter)
  // Temporarily disabled xmtpProxy router due to path-to-regexp issue
  // app.use('/api/xmtp-proxy', xmtpProxyRouter)

  return app
}

/**
 * natstat: start the HTTP server
 */
export function startApi(port = Number(process.env.API_PORT) || 4000) {
  const app    = createApp()
  const server = http.createServer(app)

  // Initialize WebSocket server for XMTP
  XmtpWebSocketService.initialize(server)

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

