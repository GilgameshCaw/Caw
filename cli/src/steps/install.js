import { execSync, exec, spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import ora from 'ora'
import { section, success, warn, err, dim, brand, tipBlock } from '../utils/ui.js'
import { ensureCliSymlink } from './update.js'

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

/**
 * Read total + free RAM (MB) from /proc/meminfo. Returns { totalMb, availMb }.
 * Linux-only; returns zeros elsewhere (the swap/heap logic then no-ops).
 */
function readMemInfoMb() {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8')
    const grab = (k) => {
      const m = txt.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, 'm'))
      return m ? Math.floor(Number(m[1]) / 1024) : 0
    }
    return { totalMb: grab('MemTotal'), availMb: grab('MemAvailable'), swapMb: grab('SwapTotal') }
  } catch {
    return { totalMb: 0, availMb: 0, swapMb: 0 }
  }
}

/**
 * The Vite/Rollup production build of the frontend (wagmi/rainbowkit/viem dep
 * graph + tsc) peaks well above 1 GB of RAM. On a small VPS where Elasticsearch
 * already claimed a chunk, the kernel OOM-killer fires mid-build and `yarn
 * build` dies with "Killed" / exit 137 — exactly the failure operators hit.
 *
 * Two-part mitigation, applied right before the build:
 *   1. Ensure a swapfile exists so a low-RAM box can spill instead of being
 *      killed. We add 2 GB at /swapfile when there's no swap and the box has
 *      under ~4 GB RAM. Idempotent: skips if any swap is already active.
 *   2. Cap Node's heap via NODE_OPTIONS sized to the box, so V8 GCs hard
 *      instead of ballooning past physical RAM.
 *
 * Best-effort: swap setup needs root (the installer runs as root on a VPS). If
 * it fails we log and continue — the NODE_OPTIONS cap still helps.
 */
async function ensureBuildMemoryHeadroom() {
  const { totalMb, swapMb } = readMemInfoMb()
  if (!totalMb) return ''  // not Linux / can't read — leave NODE_OPTIONS unset

  // 1. Swap: only add when there's none and the box is small enough to need it.
  if (swapMb === 0 && totalMb < 4096) {
    const spinner = ora('Low RAM detected — adding 2 GB swap so the build doesn’t OOM...').start()
    try {
      // fallocate is fast; dd is the portable fallback for filesystems that
      // reject fallocate (e.g. some overlay/ZFS setups).
      execSync(
        'swapon --show=NAME --noheadings | grep -q . || ' +
        '{ ( fallocate -l 2G /swapfile 2>/dev/null || ' +
        '    dd if=/dev/zero of=/swapfile bs=1M count=2048 ) && ' +
        '  chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile; }',
        { stdio: 'pipe', shell: '/bin/bash' },
      )
      spinner.succeed('2 GB swap active for the build')
    } catch (e) {
      spinner.warn('Could not add swap automatically — build may still OOM on a tiny box')
      console.log(dim(`    ${(e?.stderr?.toString?.() || e?.message || e).toString().trim().split('\n').slice(-2).join(' ')}`))
    }
  }

  // 2. Heap cap. Leave ~25% headroom under total RAM, clamp to [1536, 4096] MB.
  // Build wants ≥1.5 GB; more than 4 GB rarely helps and risks crowding ES.
  let heapMb = Math.floor(totalMb * 0.75)
  if (heapMb < 1536) heapMb = 1536
  if (heapMb > 4096) heapMb = 4096
  return `--max-old-space-size=${heapMb}`
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
      // Add swap + a sized Node heap so the Vite/Rollup build doesn't get
      // OOM-killed (exit 137 / "Killed") on a small VPS where ES already took
      // a chunk of RAM. Returns the --max-old-space-size flag to apply.
      const nodeHeapFlag = await ensureBuildMemoryHeadroom()

      const spinner3b = ora('Building frontend (production)...').start()
      try {
        await runStreamed('yarn', ['build'], {
          cwd: frontendDir,
          env: {
            ...process.env,
            // Preserve any operator-supplied NODE_OPTIONS, append our heap cap.
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${nodeHeapFlag}`.trim(),
          },
        })
        spinner3b.succeed('Frontend built — dist/ ready for nginx')
      } catch (e) {
        spinner3b.fail('Frontend build failed')
        // Surface what tsc / vite actually said. With stdio: 'pipe' we
        // get the captured streams on the error object; without printing
        // them the operator sees only "Command failed: yarn build" and
        // has no actionable signal.
        const out = (e?.stdout?.toString?.() || '').trim()
        const errOut = (e?.stderr?.toString?.() || '').trim()

        // exit 137 = SIGKILL, almost always the kernel OOM-killer on a small
        // box. The build's own output ("Killed") is unhelpful, so call it out
        // explicitly with the one remedy that reliably works.
        const looksOOM = e?.code === 137 ||
          /\bKilled\b/.test(out) || /\bKilled\b/.test(errOut)
        if (looksOOM) {
          const { totalMb, swapMb } = readMemInfoMb()
          console.log(err('  The build was killed — the box ran out of memory (exit 137).'))
          console.log(dim(`    RAM: ${totalMb || '?'} MB total, swap: ${swapMb || 0} MB.`))
          console.log(dim('    Fixes: add more RAM/swap, or move Elasticsearch off-box'))
          console.log(dim('    (set CAW_ES_URL — see docs/SCALING.md) to free heap for the build.'))
        }

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

    // Setup schema with up to 3 retries — even with waitForPostgres
    // upstream, there's still a small window where Postgres accepts
    // TCP but rejects auth or queries (initdb finalizing, default
    // role not yet created). A handful of retries with backoff costs
    // nothing on the happy path and converts an unrecoverable
    // installer failure into a 10-second pause for slow boxes.
    const spinner4 = ora('Setting up database schema...').start()
    const maxAttempts = 3
    let lastErr = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await runStreamed('npx', ['prisma', 'db', 'push', '--skip-generate'], { cwd: clientDir })
        await runStreamed('npx', ['prisma', 'generate'], { cwd: clientDir })
        spinner4.succeed(attempt === 1 ? 'Database schema ready' : `Database schema ready (attempt ${attempt})`)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        if (attempt < maxAttempts) {
          spinner4.text = `Database schema setup failed, retrying (${attempt}/${maxAttempts})...`
          await new Promise(r => setTimeout(r, 5000))
        }
      }
    }
    if (lastErr) {
      spinner4.fail('Failed to set up database after 3 attempts')
      console.log(err(`  ${lastErr.message}`))
      console.log(warn('  Common causes:'))
      console.log(warn('    1. Postgres still initializing — wait a minute and re-run `caw install`.'))
      console.log(warn('    2. DATABASE_URL credentials don\'t match the running Postgres.'))
      console.log(warn('    3. Database name mismatch — check `docker compose logs postgres` for the actual init db.'))
      throw lastErr
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

  // 5b. Install + configure pm2-logrotate so caw-server logs don't grow
  // unbounded. Operators on small VPSes (5.9GB-RAM, 0-swap test box)
  // had multi-hundred-MB out.log + error.log files surfaced by the
  // 2026-05-09 audit. Idempotent: pm2 install of a module is a no-op
  // when already installed; pm2 set commits the keep/size knobs every
  // time so config drift gets re-corrected on each `caw install` run.
  const spinner5b = ora('Configuring pm2-logrotate...').start()
  try {
    execSync('pm2 install pm2-logrotate', { stdio: 'pipe' })
    // Knobs:
    //   max_size    — rotate at 10MB (default 10K is too aggressive,
    //                 100MB too lax for a 5.9GB-RAM box).
    //   retain      — keep 7 rotated files (≈70MB headroom per stream
    //                 at 10MB cap).
    //   compress    — gzip rotated files.
    //   rotateInterval — daily at midnight as a fallback when files
    //                 stay under max_size.
    execSync('pm2 set pm2-logrotate:max_size 10M', { stdio: 'pipe' })
    execSync('pm2 set pm2-logrotate:retain 7', { stdio: 'pipe' })
    execSync('pm2 set pm2-logrotate:compress true', { stdio: 'pipe' })
    execSync('pm2 set pm2-logrotate:rotateInterval "0 0 * * *"', { stdio: 'pipe' })
    spinner5b.succeed('pm2-logrotate configured (10MB cap, retain 7, gzip)')
  } catch (e) {
    spinner5b.warn(`pm2-logrotate setup non-fatal: ${e.message}`)
    console.log(warn('  Run manually: pm2 install pm2-logrotate'))
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

  // Symlink `caw` into /usr/local/bin so operators can run subcommands
  // from anywhere. The shared helper (also called from `caw update`) is
  // idempotent + silent on no-op, so it's safe to invoke unconditionally.
  ensureCliSymlink()

  // Drift-protection cron for the StakeLedger snapshotter. Runs every 3h:
  // reseed StakeLedgerState + CawOwnershipCurrent from chain, restart pm2
  // so the in-memory `halted` flag clears. Without this, cross-client
  // chain activity inflates rewardMultiplier faster than the local
  // indexer ingests it; verifyMultiplier halts on the first mismatch and
  // the Activity charts go flat. Frontend-only nodes don't run the
  // snapshotter, so skip there.
  if (nodeType !== 'frontend-only') {
    setupStakeLedgerCron(installDir)
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

/**
 * Install the StakeLedger drift-protection cron. Writes a wrapper script
 * into ${installDir}/scripts/ that re-anchors the snapshotter state from
 * chain, then adds a 3-hourly entry to root's crontab. Idempotent: a
 * second invocation overwrites the wrapper and replaces only the matching
 * crontab line (other entries are preserved).
 *
 * The wrapper is parameterized on installDir so multiple installs (e.g.
 * staging + prod on the same VM) each manage their own cursor without
 * stomping each other.
 */
function setupStakeLedgerCron(installDir) {
  const spinner = ora('Installing StakeLedger drift-protection cron...').start()
  try {
    const scriptsDir = path.join(installDir, 'scripts')
    fs.mkdirSync(scriptsDir, { recursive: true })
    const scriptPath = path.join(scriptsDir, 'reseed-stake-ledger.sh')

    // Resolve the pm2 app name from the ecosystem file that generate.js
    // wrote earlier in this same install. Falls back to 'all' so the
    // restart still works on weird configs; that's safe because the only
    // pm2 process this install owns is the caw-server one (no per-install
    // collisions — the suffix scheme is exactly to keep them disjoint).
    const ecoPath = path.join(installDir, 'ecosystem.config.cjs')
    let pm2Name = 'all'
    try {
      const eco = fs.readFileSync(ecoPath, 'utf8')
      const m = eco.match(/"name":\s*"(caw-server-[^"]+)"/)
      if (m) pm2Name = m[1]
    } catch {}

    const wrapper = `#!/usr/bin/env bash
# Cron-driven StakeLedger re-anchor. Runs every 3h; reseeds chain state
# (StakeLedgerState + CawOwnershipCurrent) then pm2 restarts so the
# in-memory \`halted\` flag clears and the snapshotter resumes from the
# freshly-seeded multiplier/totalCaw/lastBlock.
#
# Symptom this mitigates: cross-client chain activity inflates
# rewardMultiplier faster than the local snapshotter ingests it;
# verifyMultiplier halts on the first mismatch and recordAction silently
# early-returns thereafter, leaving the Activity chart frozen.
#
# Generated by 'caw install' — re-running install regenerates this file.
set -euo pipefail
cd ${installDir}/client
LOG_DIR=${installDir}/logs
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/reseed-stake-ledger.log"
{
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) reseed start ===="
  /usr/bin/env npx tsx scripts/seed-stake-ledger.ts
  echo "-- restarting pm2 process: ${pm2Name}"
  /usr/bin/pm2 restart ${pm2Name}
  echo "==== $(date -u +%Y-%m-%dT%H:%M:%SZ) reseed done ===="
} >> "$LOG" 2>&1
`
    fs.writeFileSync(scriptPath, wrapper, { mode: 0o755 })

    // Crontab: read existing lines (or empty), drop any prior entry for
    // this exact script path (idempotent reinstall), append the new line.
    let existing = ''
    try {
      existing = execSync('crontab -l 2>/dev/null', { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    } catch {
      // "no crontab for X" exits non-zero — treat as empty.
      existing = ''
    }
    const filtered = existing
      .split('\n')
      .filter(line => !line.includes(scriptPath))
      .filter(line => line.length > 0)
    filtered.push(`0 */3 * * * ${scriptPath}`)
    const newCron = filtered.join('\n') + '\n'
    execSync('crontab -', { input: newCron, stdio: ['pipe', 'pipe', 'pipe'] })

    spinner.succeed(`Drift-protection cron installed (${scriptPath}, every 3h)`)
  } catch (e) {
    spinner.warn(`Could not install StakeLedger cron — Activity charts may freeze on drift: ${e.message}`)
    spinner.warn(`  To install manually later: see ${path.join(installDir, 'scripts', 'reseed-stake-ledger.sh')}`)
  }
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

/**
 * Wait for Postgres to be reachable on its TCP port, then for it to
 * actually accept SQL via a SELECT 1 probe. Robust against:
 *
 *   - Operators without `pg_isready` / `psql` installed (the old
 *     check silently degraded to "not ready" → 30s warn → fail).
 *   - Slow Docker cold-starts on low-spec laptops (Postgres can
 *     take 45-60s to finish initdb on first run).
 *   - Postgres briefly accepting TCP before it's ready for SQL (the
 *     startup window between listener-up and "database ready to
 *     accept connections").
 *
 * Strategy:
 *   1. Parse host/port from DATABASE_URL.
 *   2. Open a raw TCP socket — works on every box with no deps.
 *   3. Once the port is open, try a SELECT 1 via docker exec (if
 *      compose is around) OR via a Prisma raw query — either way
 *      using tools the install path already requires.
 *
 * Fails LOUD on timeout instead of warn-and-continue. The next step
 * (prisma db push) will hit the same broken Postgres in 2 seconds
 * anyway and produce a less actionable error; better to surface it
 * here with a clear remediation message.
 */
async function waitForPostgres(dbUrl, maxWaitMs = 90000) {
  const spinner = ora('Waiting for PostgreSQL to be ready...').start()
  const start = Date.now()

  let host = '127.0.0.1', port = 5432
  try {
    const u = new URL(dbUrl)
    if (u.hostname) host = u.hostname
    if (u.port) port = Number(u.port)
  } catch { /* fall back to defaults */ }

  // Phase 1: TCP port reachable.
  const net = await import('net')
  const tcpOpen = () => new Promise(resolve => {
    const s = net.default.connect({ host, port, timeout: 2000 })
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.once('timeout', () => done(false))
  })

  while (Date.now() - start < maxWaitMs) {
    if (await tcpOpen()) break
    spinner.text = `Waiting for PostgreSQL (TCP) — ${Math.round((Date.now() - start) / 1000)}s elapsed...`
    await new Promise(r => setTimeout(r, 1000))
  }
  if (Date.now() - start >= maxWaitMs) {
    spinner.fail(`PostgreSQL not reachable on ${host}:${port} after ${Math.round(maxWaitMs / 1000)}s`)
    console.log(err('  Check that Postgres started successfully:'))
    console.log(dim('    docker compose ps          # see container status'))
    console.log(dim('    docker compose logs postgres   # see startup errors'))
    throw new Error(`PostgreSQL not reachable on ${host}:${port}`)
  }

  // Phase 2: Postgres accepting SQL. TCP open ≠ "ready for queries"
  // — there's a several-second window during initdb where the
  // listener is bound but startup is still running. We probe with a
  // SELECT 1; first via docker exec if compose is in use (zero deps),
  // otherwise via a TCP write of a Postgres startup message (raw
  // protocol; we don't need to fully implement it, just see what
  // error code comes back).
  //
  // Easier: just retry the whole TCP-connect-and-disconnect-cleanly
  // pattern — a healthy Postgres responds to the connection with a
  // proper auth challenge, an initdb-pending one resets the
  // connection mid-handshake. The 'error' event vs clean 'close' is
  // the distinguishing signal.
  let sqlReady = false
  while (Date.now() - start < maxWaitMs) {
    try {
      // Try a Prisma raw query — uses the bundled pg connector, no
      // external dependency on `psql` or `pg_isready`. The first
      // failure will retry; once Postgres is fully up, this succeeds.
      // Suppress output entirely — we only care about exit status.
      execSync(`echo "SELECT 1;" | docker compose exec -T postgres psql -U postgres -d postgres 2>/dev/null`, { stdio: 'pipe' })
      sqlReady = true
      break
    } catch {
      // Either docker compose isn't on PATH (non-docker install) or
      // postgres-in-container isn't ready yet. Fall through to the
      // bare-TCP heuristic: a clean reconnect implies the server is
      // past startup.
      if (await tcpOpen()) {
        // For non-docker installs, accept TCP-open as ready. Prisma
        // db push will produce a clean error if the DB still isn't
        // accepting SQL, with a much better message than ours.
        sqlReady = true
        break
      }
    }
    spinner.text = `Waiting for PostgreSQL (SQL) — ${Math.round((Date.now() - start) / 1000)}s elapsed...`
    await new Promise(r => setTimeout(r, 1500))
  }

  if (!sqlReady) {
    spinner.fail(`PostgreSQL did not accept SQL within ${Math.round(maxWaitMs / 1000)}s`)
    throw new Error('PostgreSQL did not become SQL-ready in time')
  }
  spinner.succeed('PostgreSQL is ready')
}
