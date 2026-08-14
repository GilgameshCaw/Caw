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
 *                 EXCEPT when the DB already holds rows from a previous deployment.
 *                 The stamp was introduced with this guard, so every database
 *                 carried over from an older build has no stamp while still being
 *                 keyed to the OLD contracts — the exact case this guard exists for.
 *                 Stamping that would mark stale data as current, and every later
 *                 boot would report OK: the guard disarms itself for that database.
 *                 So: no stamp + prior rows → treat as a mismatch.
 *                 And if that look at the data cannot be taken, refuse as well —
 *                 "could not check" must not leave here as "checked and fine".
 *   - matches   → proceed normally.
 *   - MISMATCH  → the code points at NEW contracts but the DB is for OLD ones →
 *                 throw a loud, explicit error telling the dev to reset the DB.
 *
 * Bypass (only if you REALLY know the DB is compatible): set
 * ALLOW_CONTRACT_EPOCH_MISMATCH=1 — logs a warning and proceeds. This also covers
 * the one benign unstamped case: a DB that was already rebuilt for the current
 * contracts before this guard shipped. One boot with the flag stamps it for good —
 * and it has to be taken out again afterwards, or this guard stays off permanently.
 */

import { PrismaClient } from '@prisma/client'
import { CAW_NAMES_ADDRESS } from '../abi/addresses'
import { logger } from './logger'

const EPOCH_KEY = 'deployed-contract-epoch'

/** Both bypass paths say this, and so does the error text — a flag with no exit is how
 *  a guard disarms itself, which is the failure this guard exists to prevent. */
const REMOVE_FLAG_NOTE =
  'Remove ALLOW_CONTRACT_EPOCH_MISMATCH once this boot has stamped the DB — left in ' +
  '.env (ecosystem.config.cjs preloads it) this guard stays off for good, including ' +
  'the next redeploy.'

/** The epoch this code is wired to = the current deployed CawProfile address. */
function currentEpoch(): string {
  return (process.env.CAW_NAMES_ADDRESS || CAW_NAMES_ADDRESS).toLowerCase()
}

/** Prisma errors are multi-line with the human summary last; the box wants one line.
 *  The full text still goes to the log, so nothing is lost. */
function lastLine(msg: string | undefined): string {
  const lines = (msg ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : 'unknown error'
}

export class ContractEpochMismatchError extends Error {
  /**
   * dbEpoch === null → the DB has no stamp. Either it holds rows from a prior
   * deployment, or — when probeError is set — that could not be determined.
   */
  constructor(
    public readonly dbEpoch: string | null,
    public readonly codeEpoch: string,
    public readonly probeError?: string,
  ) {
    const dbLine = dbEpoch
      ? `    DB was built for CawProfile: ${dbEpoch}\n`
      : probeError
        ? '    DB has NO epoch stamp, and this guard could not read the tables it\n' +
          '    needs to tell a fresh database from one carried over from an older\n' +
          '    build:\n' +
          `      ${probeError}\n` +
          '    The epoch lookup just before it succeeded, so the database IS\n' +
          '    reachable — this is its schema or its permissions, not the\n' +
          '    connection. Refusing rather than guessing.\n'
        : '    DB has NO epoch stamp, but already holds rows from a previous\n' +
          '    deployment — it predates this guard, so it was built for the OLD\n' +
          '    contracts. (A fresh or just-reset DB is empty.)\n'
    super(
      '\n\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      '  ⛔  DATABASE / CONTRACT MISMATCH — server refusing to start\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      '  This code is wired to a DIFFERENT set of contracts than the data in\n' +
      '  the database was built for. The contracts were redeployed (tokenIds\n' +
      '  reassigned), so the existing DB rows are STALE and would misbehave.\n\n' +
      dbLine +
      `    Code now points at CawProfile: ${codeEpoch}\n\n` +
      '  ➜  Reset the database to use the new contracts:\n' +
      '        cd client && npm run prisma:reset\n' +
      '     (= prisma db push --force-reset — this WIPES all data.)\n\n' +
      '  If you are CERTAIN the DB is already compatible, bypass with:\n' +
      '        ALLOW_CONTRACT_EPOCH_MISMATCH=1\n' +
      '     Then REMOVE it. Left in .env — ecosystem.config.cjs preloads it —\n' +
      '     this guard stays off for good, including the next redeploy.\n' +
      '════════════════════════════════════════════════════════════════════\n',
    )
    this.name = 'ContractEpochMismatchError'
  }
}

/**
 * True if this DB already holds rows keyed to a contract deployment.
 *
 * A database created by `prisma db push --force-reset` (the documented remedy) is
 * empty. A database carried over from an older build is not — and it has no epoch
 * stamp either, so "no stamp" on its own cannot mean "fresh" for anyone upgrading.
 * The two cases are only distinguishable by looking at the data.
 *
 * Existence probes, not counts: this runs on every boot and must stay cheap.
 *
 * Throws are the caller's problem to classify, and the caller can: by the time this
 * runs, the epoch lookup has already reached the database, so a failure here is not
 * the unreachable-DB case the boot path tolerates.
 */
async function hasPriorDeploymentState(prisma: PrismaClient): Promise<boolean> {
  const [user, action] = await Promise.all([
    prisma.user.findFirst({ select: { id: true } }),
    prisma.action.findFirst({ select: { id: true } }),
  ])
  return !!(user || action)
}

/**
 * Verify the DB's contract epoch matches this code, or throw
 * ContractEpochMismatchError. Stamps a fresh/reset DB with the current epoch.
 * Call ONCE at boot, before starting any service. Uses its own short-lived
 * PrismaClient so it doesn't depend on service wiring.
 */
export async function assertContractEpoch(): Promise<void> {
  const codeEpoch = currentEpoch()
  const bypass = process.env.ALLOW_CONTRACT_EPOCH_MISMATCH === '1'
  const prisma = new PrismaClient()
  try {
    const row = await prisma.chainData.findUnique({ where: { key: EPOCH_KEY } })
    const dbEpoch = row ? String((row.value as unknown) ?? '').toLowerCase() : null

    if (!dbEpoch) {
      // No stamp. Three outcomes, and they must not be confused:
      //   - a genuinely fresh / just-reset DB → nothing to invalidate → stamp, proceed.
      //   - a DB carried over from a build that predates this guard → it still holds
      //     rows keyed to the OLD contracts. Stamping it would mark stale data as
      //     current and make every later boot report OK — the guard would disarm
      //     itself for that database, which is worse than not having caught it once.
      //   - the look at the data itself fails → the two are indistinguishable, so
      //     refuse. The caller turns anything that is not a mismatch into a warning
      //     and boots, which would make a check that could not run look like a check
      //     that passed. The query above already reached the DB, so this is not the
      //     dev-without-a-database case that leniency exists for.
      let priorState: boolean
      try {
        priorState = await hasPriorDeploymentState(prisma)
      } catch (err) {
        const msg = (err as Error)?.message
        logger.error(`[contractEpoch] could not classify an unstamped DB: ${msg}`)
        if (!bypass) throw new ContractEpochMismatchError(null, codeEpoch, lastLine(msg))
        priorState = true
      }

      if (priorState) {
        if (!bypass) throw new ContractEpochMismatchError(null, codeEpoch)
        logger.warn(
          '[contractEpoch] unstamped DB that is not provably fresh, bypassed ' +
          '(ALLOW_CONTRACT_EPOCH_MISMATCH=1). Proceeding — you asserted the DB is ' +
          `compatible. ${REMOVE_FLAG_NOTE}`,
        )
      }

      // Either a genuinely fresh / just-reset DB, or one of the cases above that the
      // operator bypassed. Stamp it so the next boot doesn't ask again.
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
    if (bypass) {
      logger.warn(
        `[contractEpoch] MISMATCH bypassed (ALLOW_CONTRACT_EPOCH_MISMATCH=1): ` +
        `db=${dbEpoch} code=${codeEpoch}. Proceeding — you asserted the DB is ` +
        `compatible. ${REMOVE_FLAG_NOTE}`,
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
