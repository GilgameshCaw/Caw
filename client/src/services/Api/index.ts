import { z } from 'zod'
import http from 'http'
import { Service } from '../../Service'
import { startApi, stopApi } from '../../api/server'

const Config = z.object({
  port:            z.number().int().positive().default(4000),
  allowedOrigins:  z.array(z.string().url()).optional(),
  shortUrlDomain:  z.string().url().optional() // Domain for short URLs (e.g., https://caw.is)
})

type Config = z.infer<typeof Config>

export const apiService: Service = {
  name: 'Api',

  validateConfig(cfg: unknown) {
    const res = Config.safeParse(cfg)
    return res.success
      ? []
      : res.error.errors.map(e => new Error(e.message))
  },

  start(cfg: unknown, ctx) {
    const { port, allowedOrigins, shortUrlDomain } = Config.parse(cfg)

    // inject allowedOrigins into process.env so server picks it up
    if (allowedOrigins) {
      process.env.ALLOWED_ORIGINS = allowedOrigins.join(',')
    }

    // inject shortUrlDomain into process.env
    if (shortUrlDomain) {
      process.env.SHORTURL_DOMAIN = shortUrlDomain
    }

    const server = startApi(port)

    // Heartbeat via actual HTTP probe, not just the `listening` flag.
    // A server can have listening=true but be unable to serve requests
    // (e.g. event loop blocked, socket backlog full after network outage).
    ctx.declareLoop('listening', 60_000)
    const heartbeatTimer = setInterval(() => {
      if (!(server as any).listening) return
      const req = http.get(`http://127.0.0.1:${port}/api/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) ctx.heartbeat('listening')
      })
      req.on('error', () => {})
      req.setTimeout(5000, () => req.destroy())
    }, 15_000)

    return {
      started: Promise.resolve(),
      async stop() {
        clearInterval(heartbeatTimer)
        await stopApi(server)
      },
      stats: async () => `listening on port ${port}`
    }
  }
}

