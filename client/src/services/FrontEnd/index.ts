import { spawn, ChildProcess, execSync } from 'child_process'
import { Service } from '../../Service'
import path from 'path'
import { z } from 'zod'

const Config = z.object({
  // optional overrides; by default we cd into this folder
  dir: z.string().default('src/services/FrontEnd'),
  cmd: z.string().default('yarn'),
  args: z.array(z.string()).default(['dev']),
  // Vite dev-server port. When the watchdog restarts this service, a zombie
  // vite from the previous instance sometimes outlives its parent (because
  // `yarn → vite` double-forks). Without sweeping the port, the new yarn+vite
  // hits EADDRINUSE, exits 1, heartbeat stops, watchdog restarts, repeat —
  // the classic dev-loop zombie cascade. Sweeping right before spawn is the
  // safest fix: it's idempotent, it only kills things on THIS port, and it
  // runs every restart (not just initial boot).
  port: z.number().int().positive().default(5274),
})

type Config = z.infer<typeof Config>

/**
 * Kill any stale listener on the given port. Quiet success path: no output
 * when nothing's listening (the normal case on first boot). Noisy path when
 * it actually had to kill something — that's diagnostic info the user wants.
 */
function sweepPort(port: number) {
  try {
    const pids = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null`, {
      encoding: 'utf8',
    }).trim()
    if (pids) {
      console.log(`[FrontEnd] Killing stale listener on :${port} (pid ${pids.replace(/\n/g, ', ')})`)
      execSync(`echo "${pids}" | xargs kill -9 2>/dev/null`, { stdio: 'ignore' })
      // Give the OS a beat to release the socket. Not strictly necessary on
      // macOS (which releases immediately on SIGKILL) but cheap insurance.
      execSync('sleep 0.2', { stdio: 'ignore' })
    }
  } catch {
    // lsof returns non-zero when no listener is found — normal.
  }
}

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

  start(configParam: unknown, ctx) {
    const { dir, cmd, args, port } = Config.parse(configParam)
    const cwd = path.resolve(process.cwd(), dir)
    let proc: ChildProcess

    // Sweep BEFORE spawn. yarn → vite double-forks; a previous vite can
    // outlive its yarn parent and hold 5274. Without this, the new yarn
    // spawns vite which fails EADDRINUSE, exits 1, heartbeat stops,
    // watchdog restarts us, same failure — crash loop.
    sweepPort(port)

    const started = (async () => {
      // Scrub inherited USER / LOGNAME so yarn's findRc doesn't try to
      // open /root/.config/yarn (EACCES) when pm2 launched this process
      // with HOME=/home/caw but USER=root / LOGNAME=root left over from
      // pm2's own startup env. Yarn (1.x) resolves rc paths via the
      // username, not HOME, so a mismatched LOGNAME silently routes
      // file reads at the wrong user's home. Setting them explicitly
      // here is independent of how pm2 was started.
      const homeDir = process.env.HOME || '/tmp'
      const userName = homeDir.split('/').filter(Boolean).pop() || 'caw'
      proc = spawn(cmd, args, {
        cwd,
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          HOME: homeDir,
          USER: userName,
          LOGNAME: userName,
          // Drop XDG_RUNTIME_DIR=/run/user/0 (root's runtime dir) that
          // pm2 inherits from its launcher; downstream tools that
          // honor XDG_RUNTIME_DIR otherwise probe a root-only path.
          XDG_RUNTIME_DIR: '',
        },
      })
      proc.on('exit', (code, sig) => {
        console.warn(`FrontEnd exited with ${sig ?? code}`)
      })
    })()

    // Heartbeat as long as the child process is alive. If it exits, the
    // heartbeat stops ticking and the watchdog restarts the service.
    ctx.declareLoop('child', 2 * 60_000)
    const heartbeatTimer = setInterval(() => {
      if (proc && !proc.killed) {
        ctx.heartbeat('child')
      }
    }, 30_000)

    return {
      started,
      async stop() {
        clearInterval(heartbeatTimer)
        if (proc && !proc.killed) {
          // SIGINT is polite to yarn but the spawned vite child is a
          // grandchild and doesn't always receive the signal. Follow with
          // a port sweep to guarantee we don't leave a zombie behind.
          proc.kill('SIGINT')
        }
        // Whether or not proc.kill worked, make sure the port is free so
        // the NEXT start() can bind. This is the belt-and-suspenders piece.
        sweepPort(port)
      },
      stats: async () => proc && !proc.killed
        ? 'running'
        : 'stopped'
    }
  }
}

