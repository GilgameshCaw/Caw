import { spawn, ChildProcess } from 'child_process'
import { Service } from '../../Service'
import path from 'path'
import { z } from 'zod'

const Config = z.object({
  // optional overrides; by default we cd into this folder
  dir: z.string().default('src/services/FrontEnd'),
  cmd: z.string().default('yarn'),
  args: z.array(z.string()).default(['dev'])
})

type Config = z.infer<typeof Config>

/**
 * FrontEnd service
 * @description runs the React dev server in watch mode
 */
export const frontEndService: Service = {
  name: 'FrontEnd',

  validateConfig(cfg: unknown) {
    const res = Config.safeParse(cfg)
    return res.success ? [] : res.error.errors.map(e => new Error(e.message))
  },

  start(configParam: unknown) {
    const { dir, cmd, args } = Config.parse(configParam)
    const cwd = path.resolve(process.cwd(), dir)
    let proc: ChildProcess

    const started = (async () => {
      // spawn the dev server
      proc = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true })
      proc.on('exit', (code, sig) => {
        console.warn(`FrontEnd exited with ${sig ?? code}`)
      })
    })()

    return {
      started,
      async stop() {
        if (proc && !proc.killed) {
          proc.kill('SIGINT')
        }
      },
      stats: async () => proc && !proc.killed
        ? 'running'
        : 'stopped'
    }
  }
}

