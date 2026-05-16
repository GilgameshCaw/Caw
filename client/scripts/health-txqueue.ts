// scripts/health-txqueue.ts
// One-shot TxQueue health probe. Run via: npx ts-node client/scripts/health-txqueue.ts
// Designed for /loop 20m invocation; exits 1 when action is required.
import { prisma } from '../src/prismaClient'

const WINDOW_MINUTES = 20
const STUCK_THRESHOLD_MINUTES = 5
const FAILED_ALERT_THRESHOLD = 50

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set')
    process.exit(1)
  }

  const now = new Date()
  const windowStart = new Date(now.getTime() - WINDOW_MINUTES * 60 * 1000)
  const stuckCutoff = new Date(now.getTime() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  console.log(`[${now.toISOString()}] TxQueue health (last ${WINDOW_MINUTES}m)`)

  // 1. Counts by status in the last 20m
  const statusCounts = await prisma.txQueue.groupBy({
    by: ['status'],
    where: { createdAt: { gte: windowStart } },
    _count: true,
  })

  const statuses = ['failed', 'validated_by_peer', 'processing', 'pending',
                    'awaiting_indexer', 'cancelled', 'done']
  const countMap: Record<string, number> = {}
  for (const row of statusCounts) countMap[row.status] = row._count

  const countLine = statuses
    .map(s => `${s}=${countMap[s] ?? 0}`)
    .join('  ')
  console.log(`counts:  ${countLine}`)

  const failedCount = countMap['failed'] ?? 0

  // 2. Top 3 error messages among failed rows in last 20m
  const failedRows = await prisma.txQueue.findMany({
    where: { status: 'failed', createdAt: { gte: windowStart } },
    select: { reason: true },
  })

  const errorFreq: Record<string, number> = {}
  let cawonceUsedCount = 0
  for (const row of failedRows) {
    const msg = row.reason ?? '(no reason)'
    if (msg.includes('Cawonce already used')) cawonceUsedCount++
    const key = msg.slice(0, 80)
    errorFreq[key] = (errorFreq[key] ?? 0) + 1
  }

  const top3 = Object.entries(errorFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)

  if (top3.length > 0) {
    console.log('top errors (last 20m):')
    for (const [msg, cnt] of top3) {
      console.log(`  ${cnt}x  ${msg}`)
    }
  } else {
    console.log('top errors (last 20m): none')
  }
  console.log(`cawonce-used failures: ${cawonceUsedCount}`)

  // 3. Stuck rows: processing or awaiting_indexer older than 5 minutes
  const stuckRows = await prisma.txQueue.findMany({
    where: {
      status: { in: ['processing', 'awaiting_indexer'] },
      updatedAt: { lt: stuckCutoff },
    },
    select: { id: true, status: true, updatedAt: true, payload: true },
    orderBy: { updatedAt: 'asc' },
    take: 5,
  })

  const hasStuck = stuckRows.length > 0
  if (hasStuck) {
    console.log(`STUCK rows (>${STUCK_THRESHOLD_MINUTES}m in processing/awaiting_indexer):`)
    for (const row of stuckRows) {
      const ageSec = Math.round((now.getTime() - row.updatedAt.getTime()) / 1000)
      const data = (row.payload as any)?.data ?? {}
      const actionType = data.actionType ?? 'unknown'
      console.log(`  id=${row.id}  status=${row.status}  age=${ageSec}s  action=${actionType}`)
    }
  } else {
    console.log(`stuck rows: none`)
  }

  // 4. Currently-open queue snapshot (all time, not windowed)
  const openCount = await prisma.txQueue.count({
    where: { status: { in: ['pending', 'processing', 'awaiting_indexer', 'validated_by_peer'] } },
  })
  console.log(`open queue: ${openCount} rows (pending+processing+awaiting_indexer+validated_by_peer)`)

  // 5. Exit code
  const exitCode = (hasStuck || failedCount > FAILED_ALERT_THRESHOLD) ? 1 : 0
  if (exitCode === 1) {
    const reasons: string[] = []
    if (hasStuck) reasons.push(`${stuckRows.length} stuck row(s)`)
    if (failedCount > FAILED_ALERT_THRESHOLD) reasons.push(`failed=${failedCount} > threshold ${FAILED_ALERT_THRESHOLD}`)
    console.log(`ACTION REQUIRED: ${reasons.join(', ')}`)
  } else {
    console.log('status: nominal')
  }

  await prisma.$disconnect()
  process.exit(exitCode)
}

main().catch(err => {
  console.error('health-txqueue fatal:', err)
  prisma.$disconnect().finally(() => process.exit(1))
})
