/**
 * Validator identity drift warning — boot-time check that the configured
 * `validatorId` still points at the name the operator meant to be paid.
 *
 * Why: CawActions credits each batch's implicit tip to `validatorId`
 * (`addTokensToBalance(validatorId, implicitTipOwed)`), and only checks that
 * the token exists. `validatorId` is written into config.json as a number at
 * install time. After a CawProfile-cascade redeploy tokenIds are reassigned,
 * so the configured id can end up belonging to someone else: batches keep
 * landing, and their tips keep going to that holder. Nothing fails.
 *
 * Two checks, in order:
 *   1. If `VALIDATOR_USERNAME` is set (the CLI writes it next to
 *      `VALIDATOR_ID` at install), the indexed name of `validatorId` must
 *      equal it. A match is OK even when the owner is not the signing key:
 *      the CLI deliberately allows tips to go to a name held by a different
 *      wallet (cli/src/steps/validator.js). A mismatch is drift.
 *   2. If it is not set, fall back to comparing the indexed owner with the
 *      signer address (the behaviour before `VALIDATOR_USERNAME` was read).
 *
 * Limit: this is a sanity check, not proof of ownership. It catches an id
 * that now resolves to a different name; it does not catch someone else
 * ending up with the same name after a redeploy, and it relies on
 * `VALIDATOR_USERNAME` being kept in sync if validatorId is edited by hand.
 *
 * Advisory only — never blocks boot, never throws.
 */

import { prisma } from '../prismaClient'
import { logger } from './logger'

export async function warnIfValidatorIdNotOwned(
  validatorId: number,
  signerAddress: string,
  expectedUsername: string | undefined = process.env.VALIDATOR_USERNAME,
): Promise<void> {
  try {
    const signer = signerAddress.toLowerCase()
    const expected = expectedUsername?.trim().replace(/^@/, '').toLowerCase() || undefined
    const user = await prisma.user.findUnique({
      where: { tokenId: validatorId },
      select: { username: true, address: true },
    })

    let problem: string | null = null
    if (!user) {
      problem =
        `  validatorId ${validatorId} has no indexed account on this node. Either the\n` +
        `  indexer hasn't reached it yet, or no such name exists in this deployment.`
    } else if (expected) {
      if (user.username?.toLowerCase() === expected) {
        const ownerNote =
          user.address && user.address.toLowerCase() !== signer
            ? ' (tips accrue to the owner of that name, not the signing key)'
            : ''
        logger.log(`[validatorIdGuard] validatorId ${validatorId} is @${user.username}, matches VALIDATOR_USERNAME — OK${ownerNote}`)
        return
      }
      problem =
        `  validatorId ${validatorId} is @${user.username}, but VALIDATOR_USERNAME is\n` +
        `  @${expected}. The id no longer points at the name you configured.`
    } else if (!user.address || user.address.toLowerCase() !== signer) {
      problem =
        `  validatorId ${validatorId} (@${user.username}) is owned by ${user.address ?? 'unknown'},\n` +
        `  not by this validator's key (${signerAddress}), and VALIDATOR_USERNAME\n` +
        `  is not set, so there is no recorded intent to compare against.`
    }

    if (!problem) {
      logger.log(`[validatorIdGuard] validatorId ${validatorId} (@${user!.username}) is owned by the validator key — OK`)
      return
    }

    logger.warn(
      '\n\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      '  ⚠️  VALIDATOR ID MAY BE STALE — batch tips may go to someone else\n' +
      '════════════════════════════════════════════════════════════════════\n' +
      problem + '\n\n' +
      '  Every batch this node submits credits its tip to validatorId.\n' +
      '  tokenIds REASSIGN on a contract redeploy, so an id set at install\n' +
      '  time can silently point at a different holder.\n\n' +
      '  This is a WARNING ONLY — the validator keeps running.\n\n' +
      '  ➜  Set the Validator service\'s validatorId in client/config.json to\n' +
      '     the tokenId of the name you want tips paid to (VALIDATOR_USERNAME),\n' +
      '     then restart. Keep VALIDATOR_ID in client/.env in sync too: the\n' +
      '     CLI rebuilds config.json entries from it, so a stale value there\n' +
      '     brings the old id back.\n' +
      '════════════════════════════════════════════════════════════════════\n',
    )
  } catch (err) {
    // Advisory check only — a DB hiccup here must never affect the validator.
    logger.warn('[validatorIdGuard] check skipped (non-fatal):', (err as Error)?.message)
  }
}
