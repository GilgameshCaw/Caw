#!/usr/bin/env node
// Standalone CLI entry point for ensureManualSqlIndexes, meant to be
// chained after `prisma db push` / `prisma db push --force-reset` in
// package.json's prisma:push / prisma:reset scripts, so every path
// that runs a bare `prisma db push` (not just `caw install`) gets the
// same manually-managed-index protection.
//
// Reads DATABASE_URL directly from process.env (npm scripts already
// have client/.env loaded via dotenv in this project's tooling, or the
// caller can `export $(cat .env)` first) rather than parsing .env
// itself, to avoid a second .env-parsing implementation to keep in
// sync with update.js's readDatabaseUrl.

import 'dotenv/config'
import { ensureManualSqlIndexes } from '../src/steps/ensureManualSql.js'

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error('[ensure-manual-sql] DATABASE_URL not set — skipping manually-managed index check')
  process.exit(0) // non-fatal: don't break `npm run prisma:push` over this
}

const results = ensureManualSqlIndexes(dbUrl)
for (const r of results) {
  if (r.status === 'created') console.log(`[ensure-manual-sql] created ${r.name}`)
  else if (r.status === 'already-present') console.log(`[ensure-manual-sql] ${r.name} already present`)
  else if (r.status === 'blocked') {
    console.warn(`[ensure-manual-sql] ${r.name}: duplicate rows would violate this index — run \`caw doctor\` for details, resolve manually`)
  } else {
    console.warn(`[ensure-manual-sql] ${r.name}: ${r.error}`)
  }
}
// Non-fatal even on a problem: this runs on every server boot via the
// "api" npm script, and refusing to start the server over an index
// issue would turn a notification bug into a full outage. `caw doctor`
// surfaces the same problem for an operator to act on deliberately.
process.exit(0)
