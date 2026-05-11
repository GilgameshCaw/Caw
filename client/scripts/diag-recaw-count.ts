/**
 * Diagnostic: why does Activity All-Data show low RECAW counts.
 *
 * Hypothesis A: CawOwnershipSnapshot has fewer RECAW ACTION_RECIPIENT rows
 *               than expected (indexer skipping, displayActionType drift).
 * Hypothesis B: Action / Caw tables have RECAW rows but snapshot path
 *               never wrote a recipient row (e.g. receiverId=0).
 *
 * Run: tsx client/scripts/diag-recaw-count.ts
 * (Reads DATABASE_URL via the standard Prisma client.)
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  console.log(`Window: ${since.toISOString()} → now\n`)

  // 1) RECAW Action rows in the window — clientId lives in data JSON
  const actionRows: any[] = await prisma.$queryRawUnsafe(`
    SELECT (data->>'clientId')::int as "clientId", COUNT(*)::int as n
    FROM "Action"
    WHERE "createdAt" >= '${since.toISOString()}'::timestamptz
      AND "actionType" = 'RECAW'
    GROUP BY (data->>'clientId')
    ORDER BY (data->>'clientId')::int NULLS FIRST
  `)
  console.log('1) RECAW Action rows by clientId:')
  console.table(actionRows)
  const totalActions = actionRows.reduce((a, r) => a + Number(r.n), 0)
  console.log(`   total: ${totalActions}\n`)

  // 2) RECAW Caw rows in the window
  const cawRows: any[] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int as n
    FROM "Caw"
    WHERE "createdAt" >= '${since.toISOString()}'::timestamptz
      AND "action" = 'RECAW'
  `)
  console.log(`2) RECAW Caw rows (for-you feed source): ${cawRows[0]?.n ?? 0}\n`)

  // 3) CawOwnershipSnapshot for RECAWs in the window, by (reason, actionType)
  const snapRows: any[] = await prisma.$queryRawUnsafe(`
    SELECT "reason", "actionType", COUNT(*)::int as n
    FROM "CawOwnershipSnapshot"
    WHERE "blockTimestamp" >= '${since.toISOString()}'::timestamptz
      AND ("actionType" = 'RECAW' OR "actionType" IS NULL)
    GROUP BY "reason", "actionType"
    ORDER BY "reason", "actionType"
  `)
  console.log('3) CawOwnershipSnapshot rows with actionType=RECAW or NULL, by reason:')
  console.table(snapRows)

  // 4) Cross-check: number of distinct (txHash, logIndex, actionIndex) tuples for RECAW snapshots
  const distinctActions: any[] = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int as n FROM (
      SELECT DISTINCT "txHash", "logIndex", "actionIndex"
      FROM "CawOwnershipSnapshot"
      WHERE "blockTimestamp" >= '${since.toISOString()}'::timestamptz
        AND "actionType" = 'RECAW'
    ) sub
  `)
  console.log(`\n4) Distinct (txHash, logIndex, actionIndex) for RECAW snapshots: ${distinctActions[0]?.n ?? 0}`)
  console.log(`   (should match Action count if every RECAW Action got snapshotted)\n`)

  // 5) A few sample RECAW snapshot rows
  const samples: any[] = await prisma.$queryRawUnsafe(`
    SELECT "tokenId", "reason", "actionType", "delta", "counterpartyTokenId", "blockTimestamp"
    FROM "CawOwnershipSnapshot"
    WHERE "blockTimestamp" >= '${since.toISOString()}'::timestamptz
      AND "actionType" = 'RECAW'
    ORDER BY "blockTimestamp" DESC
    LIMIT 10
  `)
  console.log('5) 10 most recent RECAW snapshot rows:')
  console.table(samples)
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
