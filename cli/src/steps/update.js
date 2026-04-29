// Update an existing install: pull latest code, run pending migrations,
// rebuild the frontend if it changed, restart pm2. The "I just want to
// catch up to upstream" command. Composable: each phase is an exported
// function the top-level orchestrator calls in sequence.

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import inquirer from 'inquirer'
import ora from 'ora'
import { section, success, dim, brand, warn, err } from '../utils/ui.js'

// Subset of SQL keywords that indicate a destructive migration. We refuse
// to auto-apply migrations whose .sql contains any of these without an
// explicit --force flag from the operator. The check is intentionally
// fuzzy (substring) — a regex tighter than this would miss things like
// `DROP    COLUMN` (extra whitespace) or `drop table if exists` (case).
// False positives are operator-friendly: they get a chance to confirm.
const DESTRUCTIVE_PATTERNS = [
  /\bdrop\s+table\b/i,
  /\bdrop\s+column\b/i,
  /\btruncate\b/i,
  /\bdrop\s+schema\b/i,
  /\bdrop\s+database\b/i,
  // ALTER ... DROP CONSTRAINT can lose data integrity — flag it.
  /\balter\s+table\s+\S+\s+drop\s+constraint\b/i,
]

/**
 * Resolve the install directory. Defaults to the CLI's repo root (the
 * convention since `caw install` writes everything under cli/../..). The
 * --dir flag overrides for unusual layouts.
 */
export function resolveInstallDir(opts, fallback) {
  return path.resolve(opts?.dir || fallback)
}

/**
 * Symlink `caw` into /usr/local/bin so operators can run subcommands from
 * anywhere. Idempotent — safe to call from both `install` (first-time
 * setup) and `update` (so existing installs that pre-date this feature
 * pick up the symlink on their next update). Tolerates failure: a
 * non-symlink at the target path is left alone with a warning, and
 * non-root invocations skip silently (no perms to write /usr/local/bin).
 */
export function ensureCliSymlink() {
  if (!process.getuid || process.getuid() !== 0) return // non-root: silent skip
  const cliEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../bin/caw.js')
  const linkPath = '/usr/local/bin/caw'

  // If a symlink already exists, only re-create when it points elsewhere.
  // If a real file lives there, the operator put it there on purpose —
  // refuse to clobber.
  try {
    const existing = fs.readlinkSync(linkPath)
    if (existing === cliEntry) return // already correct, nothing to do
    fs.unlinkSync(linkPath) // points elsewhere; replace it
  } catch (e) {
    if (e.code === 'EINVAL') {
      // It's a real file, not a symlink. Leave it alone but tell the
      // operator so they know why `caw` may not pick up the new install.
      console.log(warn(`  /usr/local/bin/caw exists but isn't a symlink — leaving it alone`))
      return
    }
    if (e.code !== 'ENOENT') {
      console.log(warn(`  Couldn't read /usr/local/bin/caw: ${e.message}`))
      return
    }
    // ENOENT — no existing link, fall through to create.
  }

  try {
    try { fs.chmodSync(cliEntry, 0o755) } catch { /* best effort */ }
    fs.symlinkSync(cliEntry, linkPath)
    console.log(success(`  Linked \`caw\` → ${dim(cliEntry)}`))
  } catch (e) {
    console.log(warn(`  Couldn't symlink \`caw\`: ${e.message}`))
  }
}

/**
 * Tell Git that operating on a repo owned by another user is fine here.
 * Git refuses by default ("dubious ownership") to defend against an
 * attacker writing a malicious .git/hooks into a directory you happen
 * to cd into. In our case the repo is owned by the `caw` user (set by
 * the install's chown step) and we're running as root via sudo, so the
 * concern doesn't apply — the operator already trusts this directory.
 *
 * Adds an entry to root's global git config. Idempotent — re-runs are
 * harmless. Only acts when running as root; non-root invocations don't
 * trip the dubious-ownership check (root running git on a caw-owned
 * dir is the specific case Git 2.35+ flags).
 */
export function ensureGitSafeDirectory(installDir) {
  if (!process.getuid || process.getuid() !== 0) return
  try {
    // --add appends without dedup, but git silently ignores duplicates on
    // the active config read, so re-running across many updates is cheap.
    // Could check first with `git config --get-all safe.directory` but
    // that's two calls instead of one; not worth it.
    execSync(`git config --global --add safe.directory ${installDir}`, { stdio: 'pipe' })
  } catch (e) {
    // Best effort — if this fails, the next git command will surface
    // the real "dubious ownership" error to the operator.
    console.log(warn(`  Couldn't mark ${installDir} as a safe git directory: ${e.message?.split('\n')[0]}`))
  }
}

/**
 * Detect the running pm2 app name for this install. Each install uses a
 * domain-based suffix (caw-server-test.caw.social, etc); we read it from
 * the ecosystem.config.cjs that `caw install` wrote.
 */
export function detectAppName(installDir) {
  const ecoPath = path.join(installDir, 'ecosystem.config.cjs')
  if (!fs.existsSync(ecoPath)) return null
  try {
    const txt = fs.readFileSync(ecoPath, 'utf8')
    // Match "name": "caw-server-..." — the first one wins (the API process).
    const m = /"name":\s*"(caw-server-[^"]+)"/.exec(txt)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Run a command, streaming output. Throws on non-zero exit. Wraps execSync
 * with stdio inherited so spinners stay clean (caller stops the spinner
 * before/after).
 */
function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts })
}

/**
 * Run a command capturing output (no streaming). Returns trimmed stdout
 * or throws. For diagnostic reads where we need the result.
 */
function runCapture(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', ...opts }).trim()
}

/**
 * Run a command as the install user (caw) when the CLI itself is running
 * as root. Idempotent for cases where pm2 / nginx / system files need
 * root but git / yarn / prisma should run unprivileged.
 *
 * SUDO_USER tells us who originally ran sudo. If we're running as root and
 * SUDO_USER is set, drop to that user via `sudo -u`. Otherwise just exec.
 */
function runAsInstallUser(cmd, opts = {}) {
  const isRoot = process.getuid && process.getuid() === 0
  const installUser = process.env.SUDO_USER || 'caw'
  if (isRoot && installUser !== 'root') {
    // -E preserves env (so DATABASE_URL flows to prisma); cwd flag still applies.
    return run(`sudo -u ${installUser} -E ${cmd}`, opts)
  }
  return run(cmd, opts)
}

/**
 * Phase 1: fetch from origin, show what's incoming, refuse if working
 * tree is dirty. Returns { incoming: [...commits], dirty: bool }.
 */
export async function previewUpdate(installDir) {
  const spinner = ora('Fetching latest code from origin...').start()
  try {
    runCapture(`git -C ${installDir} fetch origin`, { stdio: 'pipe' })
    spinner.succeed('Fetched origin')
  } catch (e) {
    spinner.fail('git fetch failed')
    throw new Error(`git fetch failed: ${e.message?.split('\n')[0]}`)
  }

  // Working tree status (excluding untracked — operators frequently leave
  // local notes/scratch around; we only care about modifications to
  // tracked files).
  const dirty = runCapture(
    `git -C ${installDir} diff --shortstat`,
    { stdio: 'pipe' },
  )
  const staged = runCapture(
    `git -C ${installDir} diff --cached --shortstat`,
    { stdio: 'pipe' },
  )
  const isDirty = !!(dirty || staged)

  // Inbound commits (HEAD..origin/<branch>). Track whichever upstream
  // branch HEAD is on. For a non-tracking branch, fall back to origin/master.
  let upstream = ''
  try {
    upstream = runCapture(
      `git -C ${installDir} rev-parse --abbrev-ref --symbolic-full-name @{u}`,
      { stdio: 'pipe' },
    )
  } catch {
    upstream = 'origin/master'
  }
  let incoming = []
  try {
    const log = runCapture(
      `git -C ${installDir} log --oneline HEAD..${upstream}`,
      { stdio: 'pipe' },
    )
    incoming = log ? log.split('\n') : []
  } catch {
    incoming = []
  }

  return { incoming, dirty: isDirty, upstream }
}

/**
 * Phase 2: list pending Prisma migrations and check each for destructive
 * SQL. Returns { pending: [migrationName...], destructive: [{name, patterns: [...]}] }.
 *
 * We don't trust prisma's own "needs apply" detection — it requires a DB
 * connection and reflects state, not intent. Reading the filesystem tells
 * us what migrations *exist* in the new code; comparing against the
 * `_prisma_migrations` table tells us which need to be applied.
 */
export async function planMigrations(installDir) {
  const migrationsDir = path.join(installDir, 'client', 'prisma', 'migrations')
  if (!fs.existsSync(migrationsDir)) return { pending: [], destructive: [] }

  const allMigrations = fs.readdirSync(migrationsDir)
    .filter(name => fs.statSync(path.join(migrationsDir, name)).isDirectory())
    .sort()

  // Read what the DB already has applied. We use psql directly to avoid
  // requiring a working prisma client at this point in the upgrade. If
  // psql isn't available, fall back to "trust prisma migrate deploy" and
  // just return the full list as pending — operator gets to decide.
  let applied = new Set()
  try {
    const dbUrl = readDatabaseUrl(installDir)
    if (dbUrl) {
      const out = runCapture(
        `psql "${dbUrl}" -t -A -c 'select migration_name from "_prisma_migrations" where rolled_back_at is null'`,
        { stdio: 'pipe' },
      )
      applied = new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
    }
  } catch {
    // Couldn't reach DB or table doesn't exist (fresh install) — fall
    // through, prisma migrate deploy will handle it.
  }

  const pending = allMigrations.filter(m => !applied.has(m))
  const destructive = []
  for (const name of pending) {
    const sqlPath = path.join(migrationsDir, name, 'migration.sql')
    if (!fs.existsSync(sqlPath)) continue
    const sql = fs.readFileSync(sqlPath, 'utf8')
    const matched = DESTRUCTIVE_PATTERNS
      .filter(rx => rx.test(sql))
      .map(rx => rx.source)
    if (matched.length > 0) destructive.push({ name, patterns: matched })
  }

  return { pending, destructive }
}

function readDatabaseUrl(installDir) {
  const envPath = path.join(installDir, 'client', '.env')
  if (!fs.existsSync(envPath)) return null
  const txt = fs.readFileSync(envPath, 'utf8')
  const m = /^DATABASE_URL=(.+)$/m.exec(txt)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

/**
 * Phase 3: pull, then run yarn install if package.json or yarn.lock changed
 * in the pull. Returns { feChanged } so the caller can decide about the FE
 * build step.
 *
 * `rebuild`: bypass the change-detection skips. Forces yarn install in both
 * the API dir and the FE dir, treats FE as changed, and re-runs prisma
 * generate. Used for recovering from a partial failure where a previous
 * `caw update` got far enough to git-pull but bailed before yarn / build /
 * restart finished.
 */
export async function applyCodeUpdate(installDir, prevHead, { rebuild = false } = {}) {
  const spinner = ora('Fast-forwarding to origin...').start()
  try {
    run(`git -C ${installDir} pull --ff-only`, { stdio: 'pipe' })
    spinner.succeed('Pulled latest code')
  } catch (e) {
    spinner.fail('git pull failed (non-fast-forward?)')
    throw new Error(`git pull failed: ${e.message?.split('\n')[0]}`)
  }

  const newHead = runCapture(`git -C ${installDir} rev-parse HEAD`, { stdio: 'pipe' })

  // Detect what changed in this pull. Used to decide whether to rebuild
  // FE / re-yarn-install / re-generate prisma client.
  let changed = []
  try {
    const out = runCapture(
      `git -C ${installDir} diff --name-only ${prevHead} ${newHead}`,
      { stdio: 'pipe' },
    )
    changed = out.split('\n').filter(Boolean)
  } catch {
    // Couldn't diff — assume everything changed and rebuild the lot.
    changed = ['package.json', 'client/src/services/FrontEnd/_changed_']
  }

  // Detect changes that gate the heavier rebuild steps. Look at BOTH the
  // API package.json/yarn.lock AND the FE one — they're separate trees.
  // Earlier versions only checked the API dir, so a FE-only dep change
  // (e.g. adding @emoji-mart/react) silently skipped FE yarn install
  // and the next FE build failed to resolve the new import.
  const apiYarnChanged = changed.some(f =>
    f === 'client/yarn.lock' || f === 'client/package.json'
  )
  const feYarnChanged = changed.some(f =>
    f === 'client/src/services/FrontEnd/yarn.lock' ||
    f === 'client/src/services/FrontEnd/package.json'
  )
  const prismaChanged = changed.some(f => f.startsWith('client/prisma/'))
  const feChanged = rebuild || changed.some(f => f.startsWith('client/src/services/FrontEnd/'))

  if (apiYarnChanged || rebuild) {
    const sp = ora('Installing API dependencies...').start()
    try {
      sp.stop()
      runAsInstallUser(`yarn install --frozen-lockfile`, { cwd: path.join(installDir, 'client') })
      console.log(success('  API dependencies up to date'))
    } catch (e) {
      sp.fail('yarn install (API) failed')
      throw e
    }
  } else {
    console.log(dim('  API dependencies unchanged — skipping yarn install'))
  }

  if (feYarnChanged || rebuild) {
    const sp = ora('Installing frontend dependencies...').start()
    try {
      sp.stop()
      runAsInstallUser(`yarn install --frozen-lockfile`, {
        cwd: path.join(installDir, 'client/src/services/FrontEnd'),
      })
      console.log(success('  Frontend dependencies up to date'))
    } catch (e) {
      sp.fail('yarn install (FE) failed')
      throw e
    }
  } else {
    console.log(dim('  Frontend dependencies unchanged — skipping yarn install'))
  }

  if (prismaChanged || rebuild) {
    const sp = ora('Regenerating Prisma client...').start()
    try {
      sp.stop()
      runAsInstallUser(`npx prisma generate`, { cwd: path.join(installDir, 'client') })
      console.log(success('  Prisma client regenerated'))
    } catch (e) {
      sp.fail('prisma generate failed')
      throw e
    }
  }

  return { feChanged, prismaChanged, newHead, changed }
}

/**
 * Phase 4: prisma migrate deploy. Idempotent — no-op if no pending
 * migrations. Caller has already screened destructive ones.
 *
 * Auto-baselines on the specific case we keep hitting: a DB created
 * directly from the squashed init migration's SQL (without going
 * through prisma migrate) has no `_prisma_migrations` row, so deploy
 * errors with P3005 ("schema is not empty"). We detect that exact
 * shape, mark the init migration applied via `migrate resolve`, and
 * retry deploy. Any other P3005 (real schema drift) still surfaces
 * the original error so the operator can investigate.
 */
export async function applyMigrations(installDir) {
  const clientDir = path.join(installDir, 'client')
  const sp = ora('Applying database migrations...').start()
  sp.stop()
  try {
    deployMigrations(clientDir)
    console.log(success('  Migrations applied'))
    return
  } catch (e) {
    // Only auto-baseline when the error is the specific P3005 shape AND
    // the DB looks unbaselined (no _prisma_migrations table or it's
    // empty). For any other failure mode, fall through to the throw.
    const msg = (e.stdout || '') + (e.stderr || '') + (e.message || '')
    const isP3005 = /P3005/.test(msg) || /schema is not empty/i.test(msg)
    if (!isP3005) {
      console.log(err('  Migration apply failed — service NOT restarted'))
      console.log(dim('  Error output:'))
      if (msg) for (const line of msg.split('\n').slice(-15)) console.log(dim(`    ${line}`))
      throw e
    }

    if (!isUnbaselined(installDir)) {
      console.log(err('  Migration apply failed (P3005 but DB has migration history) — service NOT restarted'))
      throw e
    }

    // Auto-baseline path. The squashed init's directory name is the
    // first lexicographic entry under prisma/migrations/.
    const initName = findInitMigrationName(installDir)
    if (!initName) {
      console.log(err('  Migration apply failed and no init migration found to baseline against'))
      throw e
    }
    console.log(warn(`  P3005 detected — DB schema exists but no migration history.`))
    console.log(dim(`  Auto-baselining against ${initName} and retrying...`))
    try {
      runAsInstallUser(`npx prisma migrate resolve --applied ${initName}`, { cwd: clientDir })
    } catch (resolveErr) {
      console.log(err('  Auto-baseline failed — service NOT restarted'))
      throw resolveErr
    }
    try {
      deployMigrations(clientDir)
      console.log(success('  Migrations applied (after auto-baseline)'))
    } catch (retryErr) {
      console.log(err('  Migration retry after baseline still failed — service NOT restarted'))
      throw retryErr
    }
  }
}

function deployMigrations(clientDir) {
  // Capture stdout/stderr so we can pattern-match P3005 above. We still
  // print the output to the operator on success so they see what got
  // applied — not silent.
  const out = execSync(
    process.getuid && process.getuid() === 0 && (process.env.SUDO_USER || 'caw') !== 'root'
      ? `sudo -u ${process.env.SUDO_USER || 'caw'} -E npx prisma migrate deploy`
      : `npx prisma migrate deploy`,
    { cwd: clientDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  )
  if (out) for (const line of out.split('\n')) if (line.trim()) console.log(dim(`    ${line}`))
}

function isUnbaselined(installDir) {
  // Read DATABASE_URL and probe the migrations table. "Unbaselined" =
  // either the table doesn't exist or has zero non-rolled-back rows.
  const dbUrl = readDatabaseUrl(installDir)
  if (!dbUrl) return false // Can't verify — be conservative, don't auto-baseline.
  try {
    const out = execSync(
      `psql "${dbUrl}" -t -A -c 'select count(*) from "_prisma_migrations" where rolled_back_at is null'`,
      { stdio: 'pipe', encoding: 'utf8' },
    ).trim()
    return out === '0'
  } catch (e) {
    // Table likely doesn't exist (`relation "_prisma_migrations" does not exist`).
    if (/_prisma_migrations.*does not exist/i.test((e.stderr || '') + e.message)) return true
    return false
  }
}

function findInitMigrationName(installDir) {
  const dir = path.join(installDir, 'client', 'prisma', 'migrations')
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir)
    .filter(name => fs.statSync(path.join(dir, name)).isDirectory())
    .sort()
  return names[0] || null
}

/**
 * Phase 5: yarn build for the production frontend. Skipped when the FE
 * didn't change in this update; nginx serves dist/ directly so no
 * service restart is needed for FE-only changes.
 */
export async function buildFrontend(installDir) {
  const sp = ora('Building frontend...').start()
  try {
    sp.stop()
    runAsInstallUser(`yarn build`, {
      cwd: path.join(installDir, 'client', 'src', 'services', 'FrontEnd'),
    })
    console.log(success('  Frontend built — dist/ ready'))
  } catch (e) {
    sp.fail('Frontend build failed')
    throw e
  }
}

/**
 * Phase 6: pm2 restart with health check. We restart, wait 3 seconds,
 * then check the process is `online` and the restart counter didn't
 * jump (indicating a crash loop). Failure dumps the last 30 lines of
 * pm2 log so the operator sees why immediately.
 */
export async function restartAndVerify(appName) {
  const before = pm2State(appName)
  const sp = ora(`Restarting ${appName}...`).start()
  try {
    runCapture(`pm2 restart ${appName} --update-env`, { stdio: 'pipe' })
    sp.text = 'Restart issued — waiting 3s for health check...'
    await new Promise(r => setTimeout(r, 3000))
    const after = pm2State(appName)
    if (after.status !== 'online') {
      sp.fail(`Process ${appName} is ${after.status} after restart`)
      dumpRecentLogs(appName)
      throw new Error('Restart failed: process not online')
    }
    if (before && after.restarts > before.restarts + 1) {
      // +1 for the restart we just issued; >+1 means it's looping.
      sp.fail(`Process ${appName} appears to be in a restart loop`)
      dumpRecentLogs(appName)
      throw new Error('Restart loop detected')
    }
    sp.succeed(`${appName} restarted cleanly`)
  } catch (e) {
    sp.fail(`Restart failed: ${e.message?.split('\n')[0]}`)
    throw e
  }
}

function pm2State(appName) {
  try {
    const out = runCapture(`pm2 jlist`, { stdio: 'pipe' })
    const list = JSON.parse(out)
    const found = list.find(p => p.name === appName)
    if (!found) return null
    return {
      status: found.pm2_env?.status || 'unknown',
      restarts: found.pm2_env?.restart_time ?? 0,
    }
  } catch {
    return null
  }
}

function dumpRecentLogs(appName) {
  try {
    console.log(dim('  Last 30 log lines:'))
    run(`pm2 logs ${appName} --lines 30 --nostream`, { stdio: 'inherit' })
  } catch { /* best effort */ }
}

/**
 * Top-level update orchestrator. Composes the phases above and handles
 * the confirmation flow. Called from cli/bin/caw.js as `caw update`.
 */
export async function runUpdate(installDir, opts = {}) {
  section(`Updating install at ${dim(installDir)}`)

  // The install dir is owned by `caw` (set by startServices' chown) but the
  // CLI runs as root via sudo. Modern Git refuses to operate on repos owned
  // by other users unless the path is in safe.directory. Add it for root's
  // global config — idempotent, cheap, and saves the operator a googling
  // detour the first time they run `caw update`.
  ensureGitSafeDirectory(installDir)

  const appName = detectAppName(installDir)
  if (!appName && !opts.skipRestart) {
    console.log(warn('  Could not find ecosystem.config.cjs — skipping pm2 restart.'))
    console.log(warn('  This is normal for a partially-installed environment; run `caw install` first.'))
  }

  const prevHead = runCapture(`git -C ${installDir} rev-parse HEAD`, { stdio: 'pipe' })
  const { incoming, dirty, upstream } = await previewUpdate(installDir)

  // --rebuild: re-run the full post-pull pipeline (yarn install, prisma
  // generate, FE build, pm2 restart) even when there are no new commits.
  // Recovers from a previous run that pulled the code but bailed before
  // the dependent steps finished — common when the first run fails
  // mid-deploy and the second sees "Already at latest" and short-circuits.
  if (incoming.length === 0 && !opts.rebuild) {
    console.log(success(`  Already at latest (${dim(upstream)})`))
    return
  }
  if (incoming.length === 0 && opts.rebuild) {
    console.log(dim(`  Already at latest (${upstream}) — re-running post-pull steps anyway (--rebuild)`))
  }

  if (incoming.length > 0) {
    console.log()
    console.log(brand(`  ${incoming.length} commit${incoming.length === 1 ? '' : 's'} to apply:`))
    for (const line of incoming.slice(0, 20)) console.log(dim(`    ${line}`))
    if (incoming.length > 20) console.log(dim(`    ... +${incoming.length - 20} more`))
    console.log()
  }

  if (dirty) {
    console.log(warn('  ⚠ Working tree has uncommitted changes to tracked files.'))
    console.log(warn('     `git pull --ff-only` may fail or conflict.'))
    if (!opts.yes) {
      const { proceed } = await inquirer.prompt([{
        type: 'confirm', name: 'proceed',
        message: 'Continue anyway?',
        default: false,
      }])
      if (!proceed) {
        console.log(dim('  Update cancelled.'))
        return
      }
    }
  }

  // Plan migrations BEFORE pulling so we can warn about destructive
  // SQL before the operator commits to the update. Note: this only sees
  // migrations *currently* on disk — new migrations from the pull won't
  // be visible yet. We re-check post-pull with a destructive guard.
  const preMigPlan = await planMigrations(installDir)

  // Confirmation gate. --yes skips for headless runs.
  if (!opts.yes) {
    const message = incoming.length > 0
      ? 'Apply these updates?'
      : 'Re-run yarn install + build + restart?'
    const { confirm } = await inquirer.prompt([{
      type: 'confirm', name: 'confirm',
      message,
      default: true,
    }])
    if (!confirm) {
      console.log(dim('  Update cancelled.'))
      return
    }
  }

  // ---- Apply phase ----
  const codeResult = await applyCodeUpdate(installDir, prevHead, { rebuild: !!opts.rebuild })

  // Re-plan migrations: the pull may have added new ones we haven't seen.
  // We don't currently surface "new since the pull" separately — the
  // destructive-pattern guard runs against everything pending — but the
  // pre-pull plan stays useful for the destructive prompt's wording.
  void preMigPlan
  const postMigPlan = await planMigrations(installDir)

  if (postMigPlan.pending.length > 0) {
    console.log()
    console.log(brand(`  ${postMigPlan.pending.length} migration${postMigPlan.pending.length === 1 ? '' : 's'} to apply:`))
    for (const name of postMigPlan.pending) console.log(dim(`    ${name}`))

    if (postMigPlan.destructive.length > 0) {
      console.log()
      console.log(err('  ⚠ DESTRUCTIVE migrations detected:'))
      for (const { name, patterns } of postMigPlan.destructive) {
        console.log(err(`    ${name}: matched ${patterns.join(', ')}`))
      }
      if (!opts.force) {
        console.log()
        console.log(warn('  Refusing to auto-apply destructive migrations.'))
        console.log(warn('  Re-run with `caw update --force` to override, or apply manually:'))
        console.log(dim(`    cd ${installDir}/client && npx prisma migrate deploy`))
        throw new Error('Destructive migration without --force')
      }
      // --force was given; explicit confirmation prompt unless --yes too.
      if (!opts.yes) {
        const { ack } = await inquirer.prompt([{
          type: 'confirm', name: 'ack',
          message: 'Proceed with destructive migrations? This may LOSE DATA.',
          default: false,
        }])
        if (!ack) throw new Error('Destructive migration declined')
      }
    }

    if (!opts.skipMigrations) {
      await applyMigrations(installDir)
    } else {
      console.log(warn('  Skipping migrations per --no-migrations.'))
    }
  } else {
    console.log(dim('  No pending migrations.'))
  }

  if (codeResult.feChanged) {
    await buildFrontend(installDir)
  } else {
    console.log(dim('  Frontend unchanged — skipping build.'))
  }

  if (appName && !opts.skipRestart) {
    await restartAndVerify(appName)
  }

  // Re-establish the /usr/local/bin/caw symlink. Bootstraps operators who
  // installed before the symlink was added, and re-points it if the
  // install dir moved. Idempotent + silent when nothing needs doing.
  ensureCliSymlink()

  console.log()
  console.log(success(`  Update complete (${codeResult.newHead.slice(0, 7)})`))
}
