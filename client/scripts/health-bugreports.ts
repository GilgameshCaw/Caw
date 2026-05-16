// scripts/health-bugreports.ts
// One-shot BugReport health probe. Run via: npx ts-node client/scripts/health-bugreports.ts
// Designed for /loop 20m invocation; exits 1 when new PENDING reports exist.
import { prisma } from '../src/prismaClient'

const WINDOW_MINUTES = 20
const REPORTER_WINDOW_HOURS = 24

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set')
    process.exit(1)
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000)
  const reporterWindowStart = new Date(now.getTime() - REPORTER_WINDOW_HOURS * 60 * 60 * 1000)

  console.log(`[${now.toISOString()}] BugReport health (last ${WINDOW_MINUTES}m)`)

  // 1. New PENDING reports in the last 20m
  const newPending = await prisma.bugReport.findMany({
    where: {
      status: 'PENDING',
      createdAt: { gte: windowStart },
    },
    select: { id: true, createdAt: true, description: true, username: true, userId: true, type: true },
    orderBy: { createdAt: 'desc' },
  })

  const hasNew = newPending.length > 0
  console.log(`new PENDING (last ${WINDOW_MINUTES}m): ${newPending.length}`)
  for (const r of newPending) {
    const desc = r.description.slice(0, 80)
    const reporter = r.username ?? (r.userId != null ? `uid:${r.userId}` : 'anonymous')
    console.log(`  id=${r.id}  type=${r.type}  reporter=${reporter}  at=${r.createdAt.toISOString()}`)
    console.log(`    "${desc}"`)
  }

  // 2. Total currently-open PENDING (no time filter)
  const totalPending = await prisma.bugReport.count({
    where: { status: 'PENDING' },
  })
  console.log(`total open PENDING: ${totalPending}`)

  // 3. Top 3 most recent reporters in last 24h (by report count)
  const recent24h = await prisma.bugReport.findMany({
    where: { createdAt: { gte: reporterWindowStart } },
    select: { username: true, userId: true },
  })

  const reporterFreq: Record<string, number> = {}
  for (const r of recent24h) {
    const key = r.username ?? (r.userId != null ? `uid:${r.userId}` : 'anonymous')
    reporterFreq[key] = (reporterFreq[key] ?? 0) + 1
  }

  const top3 = Object.entries(reporterFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  console.log(`top reporters (last ${REPORTER_WINDOW_HOURS}h):`)
  if (top3.length > 0) {
    for (const [handle, cnt] of top3) {
      console.log(`  ${cnt}x  ${handle}`)
    }
  } else {
    console.log('  none')
  }

  // 4. Exit code
  const exitCode = hasNew ? 1 : 0
  if (exitCode === 1) {
    console.log(`ACTION REQUIRED: ${newPending.length} new PENDING report(s) in last ${WINDOW_MINUTES}m`)
  } else {
    console.log('status: nominal')
  }

  await prisma.$disconnect()
  process.exit(exitCode)
}

main().catch(err => {
  console.error('health-bugreports fatal:', err)
  prisma.$disconnect().finally(() => process.exit(1))
})
