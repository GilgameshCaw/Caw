// cli/src/steps/ensureManualSql.js
//
// `prisma db push` materializes plain columns/indexes from schema.prisma
// but does NOT create partial expression indexes (a UNIQUE index with a
// WHERE clause, or one over an expression like COALESCE(...)) -- those
// only exist as hand-rolled migration.sql files, and db push never runs
// migrations. installRunInstall already created these once (see the
// "Ensuring notification-group index" step), but that only runs on
// `caw install`. Anyone who runs `npm run prisma:reset` / `prisma db
// push --force-reset` directly bypasses that step, and every partial
// index created there is silently lost.
//
// Discovered 2026-08-20: a live V2 node had been through prisma:reset
// (via CawProfileLedger wiring-bug recovery) without ever going through
// install.js's index step, and had zero rows in _prisma_migrations --
// meaning it had never been under normal `prisma migrate deploy`
// management at all. Two partial indexes were missing as a result:
//   - NotificationGroup's open-bucket uniqueness (crash-loops
//     createNotificationWithGroup's ON CONFLICT with 42P10 on every
//     notification -- 5000+ failures/4 days on that node)
//   - TxQueue's active-cawonce uniqueness (silently disables the
//     duplicate-in-flight-transaction guard)
//
// This module is the single place both gaps (and any future ones of
// the same shape) are defined, so it can be:
//   1. Called automatically right after `prisma db push` in both
//      install.js and a wrapped prisma:reset path, so this can't
//      silently regress again.
//   2. Run standalone as a recovery/doctor command for nodes that are
//      already in this state (like the one that surfaced this).
//
// Each entry checks for pre-existing duplicate rows before creating its
// index -- a partial unique index over data that already violates it
// will fail to create, so we check first and report rather than
// attempting a CREATE that would just error out uglier.

import { execFileSync } from 'child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MANUAL_SQL_INDEXES = [
  {
    name: 'NotificationGroup_open_bucket_key',
    table: 'NotificationGroup',
    // Mirrors NotificationService.ts's ON CONFLICT target exactly.
    duplicateCheckSql: `
      SELECT "userId", type, COALESCE("targetKey", '') AS bucket, COUNT(*)
      FROM "NotificationGroup"
      WHERE "isRead" = false
      GROUP BY "userId", type, COALESCE("targetKey", '')
      HAVING COUNT(*) > 1;
    `,
    createSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS "NotificationGroup_open_bucket_key"
        ON "NotificationGroup" ("userId", "type", (COALESCE("targetKey", '')))
        WHERE "isRead" = false;
    `,
  },
  {
    name: 'TxQueue_senderId_cawonce_active_unique',
    table: 'TxQueue',
    // Mirrors the active-status list from
    // 20260429100000_add_txqueue_cawonce_unique/migration.sql exactly.
    duplicateCheckSql: `
      SELECT "senderId", "cawonce", COUNT(*)
      FROM "TxQueue"
      WHERE status IN ('pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit')
        AND "cawonce" IS NOT NULL
      GROUP BY "senderId", "cawonce"
      HAVING COUNT(*) > 1;
    `,
    createSql: `
      CREATE UNIQUE INDEX IF NOT EXISTS "TxQueue_senderId_cawonce_active_unique"
        ON "TxQueue" ("senderId", "cawonce")
        WHERE status IN ('pending', 'processing', 'awaiting_indexer', 'waiting_for_deposit')
          AND "cawonce" IS NOT NULL;
    `,
  },
]

// Query params that Prisma understands but libpq/psql rejects with
// 'invalid URI query parameter'. Anything NOT in this set is passed through
// to psql -- crucially the libpq-valid ones (sslmode, sslrootcert, sslcert,
// sslkey, connect_timeout, application_name, ...) MUST be preserved, since
// stripping the whole query string breaks psql on any SSL-required database
// (i.e. production).
const PRISMA_ONLY_PARAMS = new Set([
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'schema',
  'statement_cache_size',
  'sslidentity',
])

function stripPrismaOnlyParams(dbUrl) {
  if (!dbUrl || !dbUrl.includes('?')) return dbUrl
  const start = dbUrl.indexOf('?')
  const base = dbUrl.slice(0, start)
  const query = dbUrl.slice(start + 1)
  const kept = query
    .split('&')
    .filter(Boolean)
    .filter((kv) => !PRISMA_ONLY_PARAMS.has(kv.split('=')[0].toLowerCase()))
  return kept.length ? `${base}?${kept.join('&')}` : base
}

// Split out secrets while retaining libpq routing and option precedence.
function databaseConnection(dbUrl) {
  const parts = /^(postgres(?:ql)?:\/\/)(?:([^/?#@]*)@)?([^/?#@]*)(?:\/([^?#]*))?(?:\?([^#]*))?$/.exec(stripPrismaOnlyParams(dbUrl))
  if (!parts) throw new Error('Expected a PostgreSQL connection URI')
  const [, scheme, userInfo = '', hosts, path = '', query = ''] = parts
  const separator = userInfo.indexOf(':')
  const user = separator < 0 ? userInfo : userInfo.slice(0, separator)
  let password = separator < 0 ? undefined : decodeURIComponent(userInfo.slice(separator + 1))
  let database = decodeURIComponent(path)
  const adminOptions = []
  for (const option of query.split('&').filter(Boolean)) {
    const split = option.indexOf('=')
    const key = split < 0 ? '' : decodeURIComponent(option.slice(0, split))
    // libpq applies query options after credentials and the database path.
    if (key === 'dbname') database = decodeURIComponent(option.slice(split + 1))
    else if (key === 'password') password = decodeURIComponent(option.slice(split + 1))
    else adminOptions.push(option)
  }
  if (password !== undefined && (process.env.PGSERVICE || adminOptions.some(option =>
    decodeURIComponent(option.split('=')[0]) === 'service'))) {
    throw Object.assign(new Error('Configure the password in the PostgreSQL service or use a direct connection without a service'), { code: 'CAW_DB_CONFIG' })
  }

  const adminQuery = adminOptions.length ? `?${adminOptions.join('&')}` : ''
  const adminUrl = `${scheme}${user ? user + '@' : ''}${hosts}/postgres${adminQuery}`
  const env = password === undefined ? process.env : { ...process.env, PGPASSWORD: password }
  const queryWithoutPassword = query.split('&').filter(option =>
    option && decodeURIComponent(option.split('=')[0]) !== 'password').join('&')
  const targetUrl = scheme + (user ? user + '@' : '') + hosts + '/' + path +
    (queryWithoutPassword ? '?' + queryWithoutPassword : '')
  return { adminUrl, targetUrl, database, env }
}

export function ensurePostgresDatabase(dbUrl, run = execFileSync) {
  if (!dbUrl) return { status: 'skipped' }
  const { adminUrl, database, env } = databaseConnection(dbUrl)
  if (!database || database === 'postgres') return { status: 'skipped' }
  // Standard PostgreSQL identifiers are limited to 63 bytes, including for
  // quoted names. Reject longer names before the server silently shortens one.
  if (Buffer.byteLength(database, 'utf8') > 63) {
    throw Object.assign(new Error('Database name exceeds the supported 63-byte limit'), { code: 'CAW_DB_CONFIG' })
  }
  const args = ['-X', '-w', '-tA', '-v', 'ON_ERROR_STOP=1', '-v', `target_db=${database}`,
    '--dbname']
  // psql expands quoted variables in scripts read from stdin. Its literal
  // and identifier forms supply the appropriate quoting for each statement.
  const execute = input => withTlsOptions(adminUrl, env, (url, childEnv) =>
    run('psql', [...args, url], { env: childEnv, input, encoding: 'utf8', stdio: 'pipe' }))
  const exists = execute("SELECT 1 FROM pg_database WHERE datname = :'target_db';\n").trim()
  if (exists === '1') return { status: 'present', database }
  if (exists !== '') throw new Error('Unexpected database existence result')
  execute('CREATE DATABASE :"target_db";\n')
  return { status: 'created', database }
}

// A successful authenticated query to the configured database is the readiness signal.
export function probeDatabase(dbUrl, dir, timeout, run = execFileSync) {
  const { targetUrl, env } = databaseConnection(dbUrl)
  return withTlsOptions(targetUrl, env, (url, childEnv) => {
    const args = ['-X', '-w', '-tA', '-v', 'ON_ERROR_STOP=1', '--dbname', url, '-c', 'SELECT 1']
    const options = { cwd: dir, env: childEnv, timeout, encoding: 'utf8', stdio: 'pipe' }
    let out
    try { out = run('psql', args, options) }
    catch (e) {
      if (e.code !== 'ENOENT') return false
      // Only an unambiguous local Compose endpoint can use the container's
      // client. Host services, TLS material and managed routes require host psql.
      const local = /^postgres(?:ql)?:\/\/(?:[^@/?]+@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::5432)?\/[^?#]*(?:\?port=5432)?$/.test(url)
      if (!local || Object.keys(childEnv).some(k => k.startsWith('PG') && k !== 'PGPASSWORD')) {
        throw Object.assign(new Error('Install the PostgreSQL client on this host for the configured database route.'), { code: 'CAW_DB_CONFIG' })
      }
      if (process.platform !== 'linux' || childEnv.DOCKER_HOST || childEnv.DOCKER_CONTEXT) return false
      // Resolve the active project (including overrides) and check its running
      // container. A local-looking URI alone does not identify that service.
      const docker = (...command) => run('docker', ['--host', 'unix:///var/run/docker.sock', ...command], options)
      const hostname = new URL(url).hostname
      const families = hostname === 'localhost' ? ['127.0.0.1', '::1'] :
        [hostname === '[::1]' ? '::1' : hostname]
      const covers = (ip, address) => ip === address || ip === (address === '::1' ? '::' : '0.0.0.0')
      try {
        const model = JSON.parse(docker('compose', 'config', '--format', 'json', 'postgres'))
        const ports = model.services?.postgres?.ports
        if (!Array.isArray(ports) || !families.every(address => ports.some(p =>
          Number(p.target) === 5432 && String(p.published) === '5432' && (p.protocol ?? 'tcp') === 'tcp' &&
          (!p.host_ip || covers(p.host_ip, address))))) return false
        const id = docker('compose', 'ps', '-q', 'postgres').trim()
        if (!/^[0-9a-f]{64}$/.test(id)) return false
        const bindings = JSON.parse(docker('inspect', '--format', '{{json (index .NetworkSettings.Ports "5432/tcp")}}', id))
        if (!Array.isArray(bindings) || !families.every(address => bindings.some(p =>
          p.HostPort === '5432' && covers(p.HostIp, address)))) return false
        // PostgreSQL can apply different authentication rules to container
        // loopback. Use its installed client image on the local host network
        // so the query actually crosses the application's published port.
        const image = docker('inspect', '--format', '{{.Image}}', id).trim()
        if (!/^sha256:[0-9a-f]{64}$/.test(image)) return false
        out = docker('run', '--rm', '--pull=never', '--network=host', '--read-only',
          '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'PGPASSWORD',
          '--entrypoint', 'psql', image, ...args)
      } catch { return false }
    }
    return out.trim() === '1'
  })
}

// libpq has no environment variable for sslpassword. Keep its value out of
// the process list using a private, short-lived service definition.
function withTlsOptions(url, env, invoke) {
  const start = url.indexOf('?')
  if (start < 0) return invoke(url, env)
  let secret, named = Boolean(env.PGSERVICE)
  const kept = []
  for (const field of url.slice(start + 1).split('&')) {
    const i = field.indexOf('=')
    const key = i < 0 ? '' : decodeURIComponent(field.slice(0, i))
    if (key === 'sslpassword') secret = decodeURIComponent(field.slice(i + 1))
    else {
      if (key === 'service') named = true
      kept.push(field)
    }
  }
  if (secret === undefined) return invoke(url, env)
  if (named || /[\r\n\0]/.test(secret) || secret.trim() !== secret) {
    throw Object.assign(new Error('Set this TLS passphrase directly in a private PostgreSQL service file.'), { code: 'CAW_DB_CONFIG' })
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caw-pg-tls-'))
  try {
    const file = path.join(dir, 'pg_service.conf')
    fs.writeFileSync(file, '[caw_tls]\nsslpassword=' + secret + '\n', { mode: 0o600 })
    return invoke(url.slice(0, start) + '?' + [...kept, 'service=caw_tls'].join('&'), { ...env, PGSERVICEFILE: file })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runPsql(dbUrl, sql) {
  // Strip Prisma-specific query params (e.g. ?connection_limit=40&pool_timeout=30)
  // that cause psql to fail with 'invalid URI query parameter', while KEEPING
  // libpq-valid ones like sslmode so psql can still connect to a TLS-required DB.
  const cleanUrl = stripPrismaOnlyParams(dbUrl)
  // execFileSync with an argv array: no shell is involved, so a DATABASE_URL
  // whose password contains `$`, `"`, backticks or `;` is passed to psql
  // verbatim instead of being interpreted (or executed) by /bin/sh. The SQL
  // itself is a fixed string from MANUAL_SQL_INDEXES, never caller input.
  return withTlsOptions(cleanUrl, process.env, (url, env) => execFileSync(
    'psql',
    [url, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ))
}

function indexExists(dbUrl, indexName, table) {
  const out = runPsql(
    dbUrl,
    `SELECT 1 FROM pg_indexes WHERE tablename = '${table}' AND indexname = '${indexName}';`,
  )
  return out.trim().length > 0
}

/**
 * Ensures every index in MANUAL_SQL_INDEXES exists, creating it if
 * missing. Returns a per-index result so callers (install.js's spinner,
 * or a standalone doctor command) can report specifics rather than a
 * single pass/fail.
 *
 * Never touches data -- if an index is missing AND duplicates exist
 * that would violate it, that entry is reported as 'blocked' with the
 * duplicate rows rather than silently skipped or force-created.
 */
/**
 * Read-only variant of ensureManualSqlIndexes -- reports which indexes
 * are missing without creating anything. Used by `caw doctor` without
 * --fix, which promises never to write.
 */
export function checkManualSqlIndexes(dbUrl) {
  return MANUAL_SQL_INDEXES.map(entry => ({
    name: entry.name,
    status: indexExists(dbUrl, entry.name, entry.table) ? 'already-present' : 'missing',
  }))
}

export function ensureManualSqlIndexes(dbUrl) {
  const results = []
  for (const entry of MANUAL_SQL_INDEXES) {
    try {
      if (indexExists(dbUrl, entry.name, entry.table)) {
        results.push({ name: entry.name, status: 'already-present' })
        continue
      }
      const duplicates = runPsql(dbUrl, entry.duplicateCheckSql).trim()
      if (duplicates.length > 0) {
        results.push({ name: entry.name, status: 'blocked', duplicates })
        continue
      }
      runPsql(dbUrl, entry.createSql)
      results.push({ name: entry.name, status: 'created' })
    } catch (e) {
      results.push({ name: entry.name, status: 'error', error: e.message })
    }
  }
  return results
}
