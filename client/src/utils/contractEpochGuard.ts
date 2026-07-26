/**
 * Contract-epoch guard — refuse to start the server against a DATABASE built for a
 * DIFFERENT set of contracts than the code is now wired to.
 *
 * Why: a CawProfile-cascade redeploy reassigns tokenIds and swaps the core
 * addresses. The database stores rows keyed by tokenId (User, Action, TxQueue, …)
 * that reference the OLD contracts. Booting the new code against that stale DB
 * doesn't crash — it silently misbehaves (profiles that don't exist on-chain,
 * InvalidSig everywhere, indexers writing garbage). A dev who `git pull`s the new
 * contract addresses and restarts without resetting the DB gets a confusing,
 * hard-to-diagnose broken instance.
 *
 * The epoch = the deployed CawProfile (CAW_NAMES_ADDRESS) from addresses.ts. It is
 * contract-scoped and changes on exactly the redeploys that invalidate the DB
 * (tokenId reassignment). We stamp it into ChainData (an existing key/value table)
 * the first time we see a DB, and on every boot compare the stamp to the current
 * code's address:
 *   - no stamp  → fresh / just-reset DB → stamp it, proceed.
 *   - matches   → proceed normally.
 *   - MISMATCH  → the code points at NEW contracts but the DB is for OLD ones →
 *                 throw a loud, explicit error telling the dev to reset the DB.
 *
 * Bypass (only if you REALLY know the DB is compatible): set
 * ALLOW_CONTRACT_EPOCH_MISMATCH=1 — logs a warning and proceeds.
 */

import { PrismaClient } from '@prisma/client'
import { CAW_NAMES_ADDRESS } from '../abi/addresses'
import { logger } from './logger'

const EPOCH_KEY = 'deployed-contract-epoch'

/** The epoch this code is wired to = the current deployed CawProfile address. */
function currentEpoch(): string {
  return (process.env.CAW_NAMES_ADDRESS || CAW_NAMES_ADDRESS).toLowerCase()
}

export class ContractEpochMismatchError extends Error {
  constructor(public readonly dbEpoch: string, public readonly codeEpoch: string) {
    super(
      '\n\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      '  ⛔  DATABASE / CONTRACT MISMATCH — server refusing to start\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      '  This code is wired to a DIFFERENT set of contracts than the data in\n' +
      '  the database was built for. The contracts were redeployed (tokenIds\n' +
      '  reassigned), so the existing DB rows are STALE and would misbehave.\n\n' +
      `    DB was built for CawProfile: ${dbEpoch}\n` +
      `    Code now points at CawProfile: ${codeEpoch}\n\n` +
      '  ➜  Reset the database to use the new contracts:\n' +
      '        cd client && npm run prisma:reset\n' +
      '     (= prisma db push --force-reset — this WIPES all data.)\n\n' +
      '  If you are CERTAIN the DB is already compatible, bypass with:\n' +
      '        ALLOW_CONTRACT_EPOCH_MISMATCH=1\n' +
      '════════════════════════════════════════════════════════════════════\n',
    )
    this.name = 'ContractEpochMismatchError'
  }
}

/**
 * Verify the DB's contract epoch matches this code, or throw
 * ContractEpochMismatchError. Stamps a fresh/reset DB with the current epoch.
 * Call ONCE at boot, before starting any service. Uses its own short-lived
 * PrismaClient so it doesn't depend on service wiring.
 */
export async function assertContractEpoch(): Promise<void> {
  const codeEpoch = currentEpoch()
  const prisma = new PrismaClient()
  try {
    const row = await prisma.chainData.findUnique({ where: { key: EPOCH_KEY } })
    const dbEpoch = row ? String((row.value as unknown) ?? '').toLowerCase() : null

    if (!dbEpoch) {
      // Fresh or just-reset DB — stamp it and proceed.
      await prisma.chainData.upsert({
        where: { key: EPOCH_KEY },
        create: { key: EPOCH_KEY, value: codeEpoch },
        update: { value: codeEpoch },
      })
      logger.log(`[contractEpoch] stamped DB epoch = ${codeEpoch}`)
      return
    }

    if (dbEpoch === codeEpoch) {
      logger.log(`[contractEpoch] OK (${codeEpoch})`)
      return
    }

    // Mismatch.
    if (process.env.ALLOW_CONTRACT_EPOCH_MISMATCH === '1') {
      logger.warn(
        `[contractEpoch] MISMATCH bypassed (ALLOW_CONTRACT_EPOCH_MISMATCH=1): ` +
        `db=${dbEpoch} code=${codeEpoch}. Proceeding — you asserted the DB is compatible.`,
      )
      // Re-stamp so subsequent boots don't keep warning.
      await prisma.chainData.update({ where: { key: EPOCH_KEY }, data: { value: codeEpoch } })
      return
    }
    throw new ContractEpochMismatchError(dbEpoch, codeEpoch)
  } finally {
    await prisma.$disconnect().catch(() => { /* ignore */ })
  }
}
