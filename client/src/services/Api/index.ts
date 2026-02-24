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

  start(cfg: unknown) {
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

    return {
      started: Promise.resolve(),
      async stop() {
        await stopApi(server)
      },
      stats: async () => `listening on port ${port}`
    }
  }
}

