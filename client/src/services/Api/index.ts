import { z } from 'zod'
import http from 'http'
import { Service } from '../../Service'
import { startApi, stopApi } from '../../api/server'

const Config = z.object({
  port:            z.number().int().positive().default(4000),
  allowedOrigins:  z.array(z.string().url()).optional()
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
    const { port, allowedOrigins } = Config.parse(cfg)

    // inject allowedOrigins into process.env so server picks it up
    if (allowedOrigins) {
      process.env.ALLOWED_ORIGINS = allowedOrigins.join(',')
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

