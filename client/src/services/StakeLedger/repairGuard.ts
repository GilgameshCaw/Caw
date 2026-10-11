import type { PrismaTransactionClient } from '../ActionProcessor/types'

const STAKE_LEDGER_REPAIR_LOCK_NAMESPACE = 0x534c5247 // "SLRG"

export async function acquireRepairSharedLock(
  tx: PrismaTransactionClient,
  networkId: number,
): Promise<boolean> {
  await (tx as any).$queryRawUnsafe(
    'SELECT 1 FROM pg_advisory_xact_lock_shared($1::int, $2::int)',
    STAKE_LEDGER_REPAIR_LOCK_NAMESPACE,
    networkId,
  )

  const guard = await tx.stakeLedgerRepairGuard.findUnique({
    where: { networkId },
    select: { repairRequired: true },
  })

  return guard?.repairRequired ?? false
}

export async function acquireRepairExclusiveLock(
  tx: PrismaTransactionClient,
  networkId: number,
): Promise<void> {
  await (tx as any).$queryRawUnsafe(
    'SELECT 1 FROM pg_advisory_xact_lock($1::int, $2::int)',
    STAKE_LEDGER_REPAIR_LOCK_NAMESPACE,
    networkId,
  )
}
