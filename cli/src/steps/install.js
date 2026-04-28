import { execSync, exec, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import ora from 'ora'
import { section, success, warn, err, dim, brand, tipBlock } from '../utils/ui.js'

/**
 * Run a long command without freezing the spinner. execSync blocks the
 * Node event loop for the entire child duration — meaning the ora ticker
 * can't update and the operator stares at a frozen ⠋ for 30+ seconds
 * wondering if the install died. spawn keeps the loop alive so the
 * spinner animates; we still capture stdout/stderr for the error path.
 *
 * Returns when the child exits with code 0. Throws on non-zero exit; the
 * thrown error has .stdout / .stderr / .code populated like execSync's
 * does, so existing catch blocks that surface those fields keep working.
 */
function runStreamed(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks = []
    const stderrChunks = []
    proc.stdout.on('data', d => stdoutChunks.push(d))
    proc.stderr.on('data', d => stderrChunks.push(d))
    proc.on('error', reject)
    proc.on('exit', code => {
      const stdout = Buffer.concat(stdoutChunks).toString()
      const stderr = Buffer.concat(stderrChunks).toString()
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        const e = new Error(`Command failed (exit ${code}): ${command} ${args.join(' ')}`)
        e.stdout = stdout
        e.stderr = stderr
        e.code = code
        reject(e)
      }
    })
  })
}

export async function runInstall(nodeType, config, installDir) {
  section('Installing Dependencies')

  const clientDir = path.join(installDir, 'client')

  // Create logs directory
  fs.mkdirSync(path.join(installDir, 'logs'), { recursive: true })

  // 1. Docker (if selected)
  if (config.useDocker === 'docker') {
    const spinner = ora('Starting Docker containers (PostgreSQL + Redis)...').start()
    try {
      execSync('docker compose up -d', { cwd: installDir, stdio: 'pipe' })
      spinner.succeed('Docker containers running')
      // Wait for PostgreSQL to be ready
      await waitForPostgres(config.dbUrl)
    } catch (e) {
      spinner.fail('Failed to start Docker containers')
      console.log(err(`  ${e.message}`))
      console.log(warn('  Make sure Docker is installed: https://docs.docker.com/get-docker/'))
      console.log(warn('  Or choose "existing instances" and configure manually.'))
      throw e
    }
  }

  // 2. Install Node.js dependencies. We pass --legacy-peer-deps because
  // typeorm peer-depends on redis@^3||^4 but the project pins redis@^5; npm
  // 9+ enforces peers strictly and refuses, while older npm/yarn just
  // shrug. legacy-peer-deps gets us back to the permissive behavior that
  // matches what the dev environment uses.
  const spinner2 = ora('Installing Node.js dependencies...').start()
  try {
    await runStreamed('npm', ['install', '--legacy-peer-deps'], { cwd: clientDir })
    spinner2.succeed('Node.js dependencies installed')
  } catch (e) {
    spinner2.fail('Failed to install dependencies')
    throw e
  }

  verifySignatures(clientDir, 'backend')

  // 3. Install frontend dependencies + (production) build
  if (['full', 'frontend-api', 'frontend-only'].includes(nodeType)) {
    const frontendDir = path.join(clientDir, 'src/services/FrontEnd')

    const spinner3 = ora('Installing frontend dependencies...').start()
    try {
      // --ignore-platform lets yarn skip platform-incompatible optional
      // packages (e.g. @rollup/rollup-darwin-x64 if someone pinned it).
      // Drop --frozen-lockfile because the lockfile is generated on a Mac
      // and re-resolves on Linux — strict mode rejects legitimate platform
      // differences.
      await runStreamed('yarn', ['install', '--ignore-platform'], { cwd: frontendDir })
      spinner3.succeed('Frontend dependencies installed')
    } catch (e) {
      spinner3.fail('Failed to install frontend dependencies')
      // Surface the actual yarn error rather than just the spinner state.
      console.log(err(`  ${e?.stderr?.toString?.() || e?.stdout?.toString?.() || e?.message || e}`))
      throw e
    }

    verifySignatures(frontendDir, 'frontend')

    // For production deployments, build the static bundle once. Nginx serves
    // dist/ directly — no need for vite to keep running. Dev mode skips the
    // build and runs vite under pm2 like before.
    if (config.deployment === 'production') {
      const spinner3b = ora('Building frontend (production)...').start()
      try {
        await runStreamed('yarn', ['build'], { cwd: frontendDir })
        spinner3b.succeed('Frontend built — dist/ ready for nginx')
      } catch (e) {
        spinner3b.fail('Frontend build failed')
        // Surface what tsc / vite actually said. With stdio: 'pipe' we
        // get the captured streams on the error object; without printing
        // them the operator sees only "Command failed: yarn build" and
        // has no actionable signal.
        const out = (e?.stdout?.toString?.() || '').trim()
        const errOut = (e?.stderr?.toString?.() || '').trim()
        if (out) {
          console.log(err('  yarn build stdout:'))
          for (const line of out.split('\n').slice(-60)) console.log(dim('    ' + line))
        }
        if (errOut) {
          console.log(err('  yarn build stderr:'))
          for (const line of errOut.split('\n').slice(-60)) console.log(dim('    ' + line))
        }
        throw e
      }

      // Replace the __CAW_PUBLIC_URL__ sentinel in dist/index.html with the
      // operator's actual public URL. The static index.html ships sentinels
      // so the homepage's default OG/Twitter card has correct absolute URLs
      // (og:url, og:image) without needing the API in the loop. Crawlers
      // hitting per-URL routes get fully-prerendered tags from the API
      // (see client/src/api/util/spaPrerender.ts) — this is the fallback.
      try {
        const distIndex = path.join(frontendDir, 'dist', 'index.html')
        if (fs.existsSync(distIndex)) {
          const publicUrl = config.domain
            ? `https://${config.domain}`
            : 'http://local.caw.com:5274'
          const html = fs.readFileSync(distIndex, 'utf8')
          fs.writeFileSync(distIndex, html.replace(/__CAW_PUBLIC_URL__/g, publicUrl))
          console.log(dim(`  Wrote public URL into dist/index.html OG tags: ${publicUrl}`))
        }
      } catch (e) {
        console.log(warn(`  Could not substitute public URL into dist/index.html: ${e.message}`))
      }
    }
  }

  // 4. Push database schema
  if (nodeType !== 'frontend-only') {
    // Ensure the Postgres database exists. prisma db push only creates
    // schema, not the database. With multi-install we derive a per-domain
    // DB name (caw_test1_caw_social, etc.) — first install creates it,
    // subsequent installs find it. We connect to the default 'postgres'
    // database to issue CREATE DATABASE IF NOT EXISTS.
    const spinnerDb = ora('Ensuring database exists...').start()
    try {
      const dbName = config.dbUrl?.split('/').pop()?.split('?')[0]
      if (dbName && dbName !== 'postgres') {
        // psql -tc returns "1" if the DB exists, blank otherwise.
        const adminUrl = config.dbUrl.replace(/\/[^/?]+(\?|$)/, '/postgres$1')
        const exists = execSync(
          `psql "${adminUrl}" -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`,
          { stdio: 'pipe' }
        ).toString().trim()
        if (!exists) {
          execSync(`psql "${adminUrl}" -c "CREATE DATABASE \\"${dbName}\\""`, { stdio: 'pipe' })
          spinnerDb.succeed(`Created database "${dbName}"`)
        } else {
          spinnerDb.succeed(`Database "${dbName}" already exists`)
        }
      } else {
        spinnerDb.succeed('Database check skipped (default postgres DB)')
      }
    } catch (e) {
      spinnerDb.warn('Could not verify/create database — prisma push may fail')
      // Don't throw — let prisma try anyway. If the DB really doesn't exist
      // and the operator hasn't configured psql access, prisma will surface
      // a clear connection error.
    }

    const spinner4 = ora('Setting up database schema...').start()
    try {
      await runStreamed('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: clientDir })
      await runStreamed('npx', ['prisma', 'generate'], { cwd: clientDir })
      spinner4.succeed('Database schema ready')
    } catch (e) {
      spinner4.fail('Failed to set up database')
      console.log(err(`  ${e.message}`))
      console.log(warn('  Make sure PostgreSQL is running and the DATABASE_URL is correct.'))
      throw e
    }
  }

  // 5. Install pm2 globally if not present
  const spinner5 = ora('Checking pm2...').start()
  try {
    execSync('pm2 --version', { stdio: 'pipe' })
    spinner5.succeed('pm2 already installed')
  } catch {
    spinner5.text = 'Installing pm2...'
    try {
      execSync('npm install -g pm2', { stdio: 'pipe' })
      spinner5.succeed('pm2 installed')
    } catch (e) {
      spinner5.fail('Failed to install pm2')
      console.log(warn('  Try: sudo npm install -g pm2'))
      throw e
    }
  }

  console.log()
  console.log(success.bold('  All dependencies installed!'))
}

export async function startServices(nodeType, installDir) {
  section('Starting Services')

  // The CLI runs as root (see install.sh's exec env ... node ...), so files
  // it created during install (logs/, .env, dist/, etc.) end up root-owned.
  // pm2 launches the apps as the caw user (via the ecosystem's `user:`
  // directive), and those apps need to write to logs/ and read from .env.
  // Chown the install dir to caw:caw so the running services have access.
  // Skip when not running as root (dev / non-sudo invocation).
  const runAsUser = process.env.SUDO_USER
  if (runAsUser && process.getuid && process.getuid() === 0) {
    const spinner0 = ora(`Chowning ${installDir} to ${runAsUser}...`).start()
    try {
      execSync(`chown -R ${runAsUser}:${runAsUser} ${installDir}`, { stdio: 'pipe' })
      spinner0.succeed(`Files now owned by ${runAsUser}`)
    } catch (e) {
      spinner0.warn(`Couldn't chown — pm2 apps may have permission issues: ${e.message}`)
    }
  }

  const ecosystemPath = path.join(installDir, 'ecosystem.config.cjs')

  const spinner = ora('Starting CAW services with pm2...').start()
  try {
    execSync(`pm2 start ${ecosystemPath}`, { cwd: installDir, stdio: 'pipe' })
    spinner.succeed('Services started')
  } catch (e) {
    spinner.fail('Failed to start services')
    console.log(err(`  ${e.message}`))
    throw e
  }

  // Set up pm2 to start on boot
  console.log()
  const spinner2 = ora('Configuring auto-start on boot...').start()
  try {
    execSync('pm2 save', { stdio: 'pipe' })
    spinner2.succeed('pm2 state saved')
  } catch {
    spinner2.warn('Could not save pm2 state — run `pm2 save` manually')
  }

  // Symlink the `caw` command into /usr/local/bin so operators can run
  // `caw update`, `caw logs`, etc. from anywhere instead of typing
  // `node /var/www/<domain>/cli/bin/caw.js update`. Skip on non-root
  // installs (no perms to write /usr/local/bin) and tolerate failure —
  // it's a convenience, not a correctness requirement.
  if (process.getuid && process.getuid() === 0) {
    const spinner3 = ora('Linking `caw` command into /usr/local/bin...').start()
    try {
      // Resolve the target path relative to install.js. cli/src/steps/install.js
      // → cli/bin/caw.js is one up + bin/.
      const cliEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../bin/caw.js')
      const linkPath = '/usr/local/bin/caw'
      // Force-replace any existing symlink (covers the "operator updated
      // their install dir layout" case). Resolve readlink first to avoid
      // unlinking a real binary the operator dropped there themselves.
      try {
        const existing = fs.readlinkSync(linkPath)
        if (existing && existing !== cliEntry) fs.unlinkSync(linkPath)
        else if (existing === cliEntry) {
          spinner3.succeed('`caw` already linked to this install')
        }
      } catch (e) {
        // ENOENT = no existing link, proceed. EINVAL = it's a real file
        // (not a symlink), don't touch.
        if (e.code === 'EINVAL') {
          spinner3.warn(`/usr/local/bin/caw exists but isn't a symlink — leaving it alone`)
          throw e
        }
      }
      // Create only if we didn't already report "already linked"
      if (!fs.existsSync(linkPath)) {
        // chmod the target to executable in case the package was unpacked
        // without preserved bits.
        try { fs.chmodSync(cliEntry, 0o755) } catch { /* best effort */ }
        fs.symlinkSync(cliEntry, linkPath)
        spinner3.succeed(`\`caw\` now runs from anywhere → ${dim(cliEntry)}`)
      }
    } catch (e) {
      if (!spinner3.isSpinning) {
        // Already terminated above (warn or succeed); nothing to do.
      } else {
        spinner3.warn(`Couldn't symlink \`caw\`: ${e.message}`)
      }
    }
  }

  console.log()
  tipBlock([
    'To auto-start on system boot, run:',
    '  pm2 startup',
    '  (follow the instructions it prints)',
    '',
    `${brand('CAW commands')} (from anywhere):`,
    '  caw update            — pull latest code, run migrations, restart',
    '  caw status            — show running services',
    '  caw logs [service]    — tail logs',
    '  caw restart [service] — restart services',
    '  caw migrate           — run pending DB migrations only',
    '  caw build             — rebuild the frontend bundle only',
  ])
}

// Verify every installed package's tarball was signed by its npm publisher.
// This catches the "compromised maintainer account" supply-chain vector —
// an attacker pushing a malicious version under a legit package name will
// fail registry-signature validation. Registry signatures are the strong
// check; "attestations" (SLSA build provenance) are a newer, opt-in layer
// that frequently false-positives on older npm CLIs, so we only escalate
// on signature mismatches.
//
// Treated as a warning, not a hard failure: stale npm CLIs sometimes
// reject otherwise-valid tarballs, and corp/private registries don't
// sign. We surface real problems loudly without refusing to proceed.
function verifySignatures(cwd, label) {
  const spinner = ora(`Verifying ${label} package signatures...`).start()
  let out = ''
  try {
    out = execSync('npm audit signatures', { cwd, stdio: 'pipe' }).toString()
  } catch (e) {
    out = (e?.stdout?.toString?.() || '') + (e?.stderr?.toString?.() || '')
  }
  const sigBad = /invalid signatures?|missing signatures?|tampered/i.test(out)
  const attBad = /invalid attestations?/i.test(out)
  if (sigBad) {
    spinner.fail(`${label} has tampered/invalid registry signatures — DO NOT deploy`)
    const lines = out.split('\n').filter(l =>
      /(missing|invalid|tampered|unsigned)/i.test(l) && !/attestation/i.test(l)
    ).slice(0, 30)
    for (const l of lines) console.log(err(`  ${l.trim()}`))
    throw new Error(`${label} signature verification failed`)
  } else if (attBad) {
    spinner.warn(`${label} has invalid SLSA attestations (likely npm-CLI false-positive)`)
    console.log(dim('  Registry signatures verified ✓ (the strong supply-chain check).'))
    console.log(dim('  Attestation mismatches usually mean the npm CLI is older than the'))
    console.log(dim('  attestations it\'s verifying — try `npm install -g npm@latest` to clear.'))
  } else {
    spinner.succeed(`${label} package signatures verified`)
  }
}

async function waitForPostgres(dbUrl, maxWaitMs = 30000) {
  const spinner = ora('Waiting for PostgreSQL to be ready...').start()
  const start = Date.now()

  while (Date.now() - start < maxWaitMs) {
    try {
      execSync(`pg_isready -h 127.0.0.1 -p 5432 -q`, { stdio: 'pipe' })
      spinner.succeed('PostgreSQL is ready')
      return
    } catch {
      await new Promise(r => setTimeout(r, 1000))
    }
  }

  spinner.warn('PostgreSQL may not be ready yet — continuing anyway')
}
