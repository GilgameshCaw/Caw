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
import { configureMediaNginx } from './mediaNginx.js'

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

// Author-side migration smells: SQL that's syntactically valid but
// likely to fail or misbehave on real operator boxes. We warn — never
// block — so the deploy still proceeds; the warning gives the author
// (and the operator who reports the failure) a fast pointer to the fix.
//
// Each entry: { pattern, label, hint } where label is shown in the
// "Migration warnings" block and hint is the one-liner remediation.
const RISKY_PATTERNS = [
  {
    // ALTER TYPE ... ADD VALUE without IF NOT EXISTS errors on re-run
    // ("enum label X already exists"). Postgres 9.6+ supports the guard.
    pattern: /\balter\s+type\s+\S+\s+add\s+value\b(?!\s+if\s+not\s+exists)/i,
    label: 'enum ADD VALUE without IF NOT EXISTS',
    hint: 'Add `IF NOT EXISTS` so re-runs against partially-migrated DBs don\'t error.',
  },
  {
    // CREATE TABLE without IF NOT EXISTS — same re-run failure mode.
    pattern: /\bcreate\s+table\s+(?!if\s+not\s+exists)/i,
    label: 'CREATE TABLE without IF NOT EXISTS',
    hint: 'Add `IF NOT EXISTS` for idempotency on partial-apply recovery.',
  },
  {
    // ADD COLUMN without IF NOT EXISTS.
    pattern: /\badd\s+column\s+(?!if\s+not\s+exists)/i,
    label: 'ADD COLUMN without IF NOT EXISTS',
    hint: 'Add `IF NOT EXISTS` so the migration is safe to re-apply.',
  },
  {
    // CREATE INDEX without IF NOT EXISTS (concurrent variant included).
    pattern: /\bcreate\s+(?:unique\s+)?(?:concurrent\s+)?index\s+(?!if\s+not\s+exists)/i,
    label: 'CREATE INDEX without IF NOT EXISTS',
    hint: 'Add `IF NOT EXISTS` so the migration replays cleanly.',
  },
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
 *
 * Why the explicit HOME=: `-E` preserves root's HOME (e.g. /root), and
 * yarn then tries to read /root/.config/yarn as the unprivileged user
 * and fails with EACCES. Look up the target user's real home via getent
 * and override.
 */
function runAsInstallUser(cmd, opts = {}) {
  const isRoot = process.getuid && process.getuid() === 0
  const installUser = process.env.SUDO_USER || 'caw'
  if (isRoot && installUser !== 'root') {
    const home = userHome(installUser)
    // -E preserves env (so DATABASE_URL flows to prisma); HOME= override
    // points yarn / npm / git at the target user's config dir.
    return run(`sudo -u ${installUser} -E env HOME=${home} ${cmd}`, opts)
  }
  return run(cmd, opts)
}

/**
 * Resolve a system user's home directory via getent. Falls back to
 * /home/<user> if getent isn't available or the user has no entry —
 * the latter shouldn't happen for the install user but the fallback
 * keeps the CLI from crashing on exotic environments.
 */
function userHome(user) {
  try {
    const out = execSync(`getent passwd ${user}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const parts = out.split(':')
    if (parts.length >= 6 && parts[5]) return parts[5]
  } catch {}
  return `/home/${user}`
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
  const risky = []
  for (const name of pending) {
    const sqlPath = path.join(migrationsDir, name, 'migration.sql')
    if (!fs.existsSync(sqlPath)) continue
    const sql = fs.readFileSync(sqlPath, 'utf8')
    const matched = DESTRUCTIVE_PATTERNS
      .filter(rx => rx.test(sql))
      .map(rx => rx.source)
    if (matched.length > 0) destructive.push({ name, patterns: matched })

    // Author-side smells are warn-only; they won't block the deploy
    // but the operator (and whoever reads the deploy log) sees a
    // pointer to the missing IF NOT EXISTS guard. Cheaper than a
    // mid-deploy P3018 with no context.
    const riskMatches = RISKY_PATTERNS
      .filter(({ pattern }) => pattern.test(sql))
      .map(({ label, hint }) => ({ label, hint }))
    if (riskMatches.length > 0) risky.push({ name, issues: riskMatches })
  }

  return { pending, destructive, risky }
}

function readDatabaseUrl(installDir) {
  const envPath = path.join(installDir, 'client', '.env')
  if (!fs.existsSync(envPath)) return null
  const txt = fs.readFileSync(envPath, 'utf8')
  const m = /^DATABASE_URL=(.+)$/m.exec(txt)
  if (!m) return null
  // Strip wrapping quotes (operators sometimes quote the value because
  // the URL contains `&`, which would otherwise be treated as a shell
  // operator if .env is sourced via `set -a; source .env`).
  let url = m[1].replace(/^["']|["']$/g, '')
  // Strip Prisma-only query params before handing to psql. Prisma
  // understands connection_limit / pool_timeout / schema etc, but
  // psql rejects them with "invalid URI query parameter". We use psql
  // for migration-status reads (the JS layer never touches these
  // params), so it's safe to drop them.
  //
  // Preserve params libpq DOES understand: sslmode, sslcert, sslkey,
  // sslrootcert, sslcompression, application_name, fallback_application_name,
  // keepalives, keepalives_idle, keepalives_interval, keepalives_count,
  // connect_timeout, tcp_user_timeout, target_session_attrs, gssencmode,
  // krbsrvname, service, options, replication, client_encoding, hostaddr,
  // requirepeer, channel_binding.
  // See https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-PARAMKEYWORDS
  const LIBPQ_KEYS = new Set([
    'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslcompression',
    'application_name', 'fallback_application_name',
    'keepalives', 'keepalives_idle', 'keepalives_interval', 'keepalives_count',
    'connect_timeout', 'tcp_user_timeout', 'target_session_attrs',
    'gssencmode', 'krbsrvname', 'service', 'options', 'replication',
    'client_encoding', 'hostaddr', 'requirepeer', 'channel_binding',
  ])
  const qIdx = url.indexOf('?')
  if (qIdx !== -1) {
    const base = url.slice(0, qIdx)
    const params = url.slice(qIdx + 1)
      .split('&')
      .map(p => p.trim())
      .filter(p => p && LIBPQ_KEYS.has(p.split('=')[0]))
    url = params.length > 0 ? `${base}?${params.join('&')}` : base
  }
  return url
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
  const installUser = process.env.SUDO_USER || 'caw'
  const sudoNeeded = process.getuid && process.getuid() === 0 && installUser !== 'root'
  const cmd = sudoNeeded
    ? `sudo -u ${installUser} -E env HOME=${userHome(installUser)} npx prisma migrate deploy`
    : `npx prisma migrate deploy`
  const out = execSync(cmd, { cwd: clientDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
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
 * Parse schema.prisma into { tableName: [scalarColumnName, ...], ... }.
 *
 * Rules:
 * - Each `model Foo { ... }` block becomes a table named `Foo`. No
 *   @@map in this codebase, so model name == table name; the parser
 *   throws if someone introduces @@map without updating this verifier.
 * - Lines that look like `name Type ...` are scalar fields IFF Type
 *   (after stripping `?` and `[]`) is a primitive or enum. Relation
 *   fields (Type is another model name, line carries @relation, or
 *   Type is `Model[]`) have no DB column — skip them.
 * - We don't try to verify column types or nullability; presence is
 *   enough for the silent-drift case this exists to catch.
 */
function parsePrismaSchemaTables(schemaText) {
  const PRIMITIVE_TYPES = new Set([
    'String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Float',
    'Json', 'Bytes', 'Decimal',
  ])

  const modelNames = new Set()
  for (const m of schemaText.matchAll(/^model\s+(\w+)\s*\{/gm)) modelNames.add(m[1])
  const enumNames = new Set()
  for (const m of schemaText.matchAll(/^enum\s+(\w+)\s*\{/gm)) enumNames.add(m[1])

  const tables = {}
  const blockRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm
  for (const m of schemaText.matchAll(blockRe)) {
    const [, modelName, body] = m
    if (/@@map\s*\(/.test(body)) {
      throw new Error(
        `parsePrismaSchemaTables: model ${modelName} uses @@map — verifier needs an update to honor table-name overrides.`
      )
    }
    const cols = []
    for (const rawLine of body.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').trim()
      if (!line || line.startsWith('@@')) continue
      const fieldMatch = line.match(/^(\w+)\s+(\w+)(\??)(\[\])?\s*(.*)$/)
      if (!fieldMatch) continue
      const [, fieldName, baseType, , isList, rest] = fieldMatch
      if (isList) continue                       // list of relations
      if (modelNames.has(baseType)) continue     // 1:1 / 1:N relation
      if (/@relation\b/.test(rest)) continue     // explicit @relation
      if (!PRIMITIVE_TYPES.has(baseType) && !enumNames.has(baseType)) continue
      cols.push(fieldName)
    }
    tables[modelName] = cols
  }
  return tables
}

/**
 * Compare expected schema (schema.prisma) to live schema
 * (information_schema) and report drift. Run after migrate deploy,
 * before pm2 restart. Catches the silent-drift case where an operator
 * marked migrations applied via `prisma migrate resolve` without
 * actually running their SQL — `_prisma_migrations` says clean but
 * the columns aren't there.
 *
 * Throws on mismatch (caller fails the update before service restart).
 */
export async function verifySchema(installDir) {
  const sp = ora('Verifying database schema matches schema.prisma...').start()
  const schemaPath = path.join(installDir, 'client', 'prisma', 'schema.prisma')
  const dbUrl = readDatabaseUrl(installDir)
  if (!dbUrl) {
    sp.warn('Skipping schema verification (no DATABASE_URL in client/.env)')
    return
  }
  if (!fs.existsSync(schemaPath)) {
    sp.warn(`Skipping schema verification (no ${schemaPath})`)
    return
  }

  let expected
  try {
    expected = parsePrismaSchemaTables(fs.readFileSync(schemaPath, 'utf8'))
  } catch (e) {
    sp.fail(`Could not parse schema.prisma: ${e.message}`)
    throw e
  }

  let live
  try {
    const out = execSync(
      `psql "${dbUrl}" -t -A -F '|' -c ` +
      `"select table_name, column_name from information_schema.columns where table_schema='public' order by table_name, column_name"`,
      { stdio: 'pipe', encoding: 'utf8' },
    )
    live = {}
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const [table, column] = line.split('|')
      if (!table || !column) continue
      ;(live[table] = live[table] || []).push(column)
    }
  } catch (e) {
    sp.fail('Could not read information_schema (psql failed)')
    const msg = (e.stderr || '') + (e.stdout || '') + (e.message || '')
    if (msg) for (const line of msg.split('\n').slice(-10)) console.log(dim(`    ${line}`))
    throw e
  }

  const missingTables = []
  const missingColumns = []
  for (const [table, expectedCols] of Object.entries(expected)) {
    const liveCols = live[table]
    if (!liveCols) {
      missingTables.push(table)
      continue
    }
    const liveSet = new Set(liveCols)
    for (const col of expectedCols) {
      if (!liveSet.has(col)) missingColumns.push({ table, column: col })
    }
  }

  if (missingTables.length === 0 && missingColumns.length === 0) {
    sp.succeed(`Schema verified — ${Object.keys(expected).length} tables match prisma`)
    return
  }

  sp.fail('Database schema does NOT match schema.prisma')
  console.log()
  if (missingTables.length) {
    console.log(err('  Missing tables:'))
    for (const t of missingTables) console.log(err(`    - ${t}`))
  }
  if (missingColumns.length) {
    console.log(err('  Missing columns:'))
    for (const { table, column } of missingColumns) {
      console.log(err(`    - ${table}.${column}`))
    }
  }
  console.log()
  console.log(warn('  This usually means a migration was marked applied via'))
  console.log(warn('  `prisma migrate resolve` without actually running its SQL.'))
  console.log(dim('  To recover:'))
  console.log(dim('    1. Identify which migration adds the missing column/table:'))
  console.log(dim('         grep -lr "<missing-name>" client/prisma/migrations/'))
  console.log(dim('    2. Apply its SQL by hand (idempotent if it uses IF NOT EXISTS):'))
  console.log(dim('         psql "$DATABASE_URL" -f client/prisma/migrations/<name>/migration.sql'))
  console.log(dim('    3. Re-run `caw update` to confirm.'))
  throw new Error(
    `Schema verification failed: ${missingTables.length} missing table(s), ${missingColumns.length} missing column(s)`
  )
}

/**
 * Phase 5: yarn build for the production frontend. Skipped when the FE
 * didn't change in this update; nginx serves dist/ directly so no
 * service restart is needed for FE-only changes.
 */
/**
 * Free memory check + optional-container shutdown for the FE build.
 *
 * vite + rollup hold the entire dep graph in memory during the build; on
 * a constrained VPS (~6 GB total) it can spike to 1-2 GB resident, which
 * stacks badly with anything else memory-heavy. test.caw.social ran out
 * of headroom mid-build with signoz + ES + clickhouse all running and
 * thrashed for minutes. The fix that worked: stop the observability
 * stack, build, restart.
 *
 * This automates that. We check available memory; if below threshold we
 * stop a configurable list of "optional" containers (default: signoz
 * family — observability, no user impact when paused), build, then
 * restart them in a finally block so they come back even if the build
 * crashes.
 *
 * Operator overrides:
 *   CAW_PREBUILD_STOP_CONTAINERS=name1,name2  (comma-sep; "" disables)
 *   CAW_PREBUILD_MEM_THRESHOLD_MB=2048         (skip stop above this)
 *
 * Silent on systems without docker. Errors stopping containers are
 * non-fatal — the build proceeds and may still succeed.
 */
const DEFAULT_OPTIONAL_CONTAINERS = [
  'signoz',
  'signoz-otel-collector',
  'signoz-clickhouse',
  'signoz-zookeeper-1',
]

function availableMemoryMb() {
  try {
    const out = execSync(`grep '^MemAvailable:' /proc/meminfo`, { encoding: 'utf8' })
    const m = out.match(/MemAvailable:\s+(\d+)\s+kB/)
    if (!m) return null
    return Math.round(Number(m[1]) / 1024)
  } catch {
    return null  // not Linux / no /proc — skip the gate
  }
}

function dockerAvailable() {
  try {
    execSync(`docker --version`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function listRunningOptionalContainers(names) {
  if (!names.length || !dockerAvailable()) return []
  try {
    const out = runCapture(`docker ps --format '{{.Names}}'`, { stdio: 'pipe' })
    const running = new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
    return names.filter(n => running.has(n))
  } catch {
    return []
  }
}

async function withMemoryHeadroom(fn) {
  const overrideRaw = process.env.CAW_PREBUILD_STOP_CONTAINERS
  const names = overrideRaw === ''
    ? []
    : overrideRaw
      ? overrideRaw.split(',').map(s => s.trim()).filter(Boolean)
      : DEFAULT_OPTIONAL_CONTAINERS
  const thresholdMb = Number(process.env.CAW_PREBUILD_MEM_THRESHOLD_MB) || 2048

  const availMb = availableMemoryMb()
  const stopped = []
  if (availMb !== null && availMb < thresholdMb) {
    const candidates = listRunningOptionalContainers(names)
    if (candidates.length > 0) {
      console.log(dim(`  Available memory ${availMb}MB < ${thresholdMb}MB — pausing optional containers for the build:`))
      for (const name of candidates) console.log(dim(`    • ${name}`))
      try {
        execSync(`docker stop ${candidates.join(' ')}`, { stdio: 'ignore' })
        stopped.push(...candidates)
      } catch (e) {
        console.log(warn(`  Failed to stop containers (continuing): ${e.message}`))
      }
    }
  }

  try {
    return await fn()
  } finally {
    if (stopped.length > 0) {
      // Restart in dependency order: zookeeper → clickhouse → otel → signoz
      // (the order in DEFAULT_OPTIONAL_CONTAINERS reverses naturally if the
      // operator follows the default; for custom lists it's their problem
      // to order correctly).
      const restartOrder = [...stopped].reverse()
      try {
        execSync(`docker start ${restartOrder.join(' ')}`, { stdio: 'ignore' })
        console.log(dim(`  Restarted ${stopped.length} optional container(s).`))
      } catch (e) {
        console.log(warn(`  Failed to restart containers: ${e.message}`))
        console.log(warn(`  Restart manually: docker start ${restartOrder.join(' ')}`))
      }
    }
  }
}

export async function buildFrontend(installDir) {
  await withMemoryHeadroom(async () => {
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
  })
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

    if (postMigPlan.risky.length > 0) {
      console.log()
      console.log(warn('  Migration warnings (will still apply):'))
      for (const { name, issues } of postMigPlan.risky) {
        console.log(warn(`    ${name}`))
        for (const { label, hint } of issues) {
          console.log(dim(`      • ${label}`))
          console.log(dim(`        ${hint}`))
        }
      }
    }

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

  // Schema-drift guard. Runs even when no migrations were applied this
  // pass — drift can predate the current update (e.g. a prior `prisma
  // migrate resolve` left _prisma_migrations clean while the SQL was
  // never actually executed).
  if (!opts.skipVerifySchema) {
    await verifySchema(installDir)
  } else {
    console.log(warn('  Skipping schema verification per --skip-verify-schema.'))
  }

  if (codeResult.feChanged) {
    await buildFrontend(installDir)
  } else {
    console.log(dim('  Frontend unchanged — skipping build.'))
  }

  // Pick up media-storage config changes (Filebase reverse-proxy vhost).
  // Silent no-op when MEDIA_STORAGE_BACKEND isn't 'filebase' or when not
  // running as root. Idempotent — if the config is already in place this
  // is effectively free.
  try {
    await configureMediaNginx(installDir)
  } catch (e) {
    console.log(warn(`  Media nginx setup failed: ${e.message}`))
    console.log(warn('  Continuing with the rest of the update — fix and re-run later.'))
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
