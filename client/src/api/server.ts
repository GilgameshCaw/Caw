import express from 'express'
import cors, { CorsOptions } from 'cors'
import http from 'http'
import actionsRouter from './routes/actions'
import cawRouter from './routes/caws'
import txRouter  from './routes/txs'

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
  app.use(express.json())
	app.use('/api/actions', actionsRouter)
	app.use('/api/caws', cawRouter)
	app.use('/api/txs',  txRouter)

  return app
}

/**
 * natstat: start the HTTP server
 */
export function startApi(port = Number(process.env.API_PORT) || 4000) {
  const app    = createApp()
  const server = http.createServer(app)
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

