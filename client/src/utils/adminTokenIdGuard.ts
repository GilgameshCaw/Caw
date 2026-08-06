/**
 * ADMIN_TOKEN_IDS drift warning — boot-time check that flags a stale
 * bootstrap-admin pin, WITHOUT changing the tokenId-based auth model.
 *
 * Why: `ADMIN_TOKEN_IDS` (client/src/api/middleware/auth.ts, ~L131) is a
 * comma-separated list of tokenIds that are treated as ADMIN regardless of
 * their DB `role` (see `resolveAdminTokenId` / `requireModerator`'s
 * bootstrap fast-path). On a CawProfile-cascade redeploy, tokenIds
 * reassign starting from 0 again — a pinned id like `1` silently becomes
 * whoever happens to mint/hold tokenId 1 in the NEW deployment, granting
 * them admin. Nothing crashes; the privilege escalation is silent.
 *
 * This module does NOT fix that model (still tokenId-based, per product
 * decision) — it just makes the drift LOUD at boot so an operator notices
 * and re-syncs ADMIN_TOKEN_IDS. Purely advisory: never blocks boot, never
 * throws past its own caller.
 *
 * Call once at boot, alongside assertContractEpoch() — see programs/start.ts.
 */

import { PrismaClient } from '@prisma/client'
import { logger } from './logger'

/**
 * Parse ADMIN_TOKEN_IDS the SAME way auth.ts does. Kept in sync by hand —
 * duplicating rather than importing avoids pulling the whole auth.ts
 * module (and its DB-backed middleware wiring) into the boot path.
 */
function parseAdminTokenIds(): number[] {
  return (process.env.ADMIN_TOKEN_IDS ?? '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
}

/**
 * Check ADMIN_TOKEN_IDS against the current DB and warn (non-fatal) if any
 * pinned tokenId looks stale: unheld (no User row — bootstrap admin is
 * dead) or held by an account whose stored role is still USER (may be a
 * different person than intended post-redeploy). Never throws.
 */
export async function warnIfAdminTokenIdsStale(): Promise<void> {
  const pinnedIds = parseAdminTokenIds()
  if (pinnedIds.length === 0) return // no env-admins configured — nothing to check

  const prisma = new PrismaClient()
  try {
    const users = await prisma.user.findMany({
      where: { tokenId: { in: pinnedIds } },
      select: { tokenId: true, username: true, role: true },
    })
    const byTokenId = new Map(users.map(u => [u.tokenId, u]))

    const warnings: string[] = []

    for (const tokenId of pinnedIds) {
      const user = byTokenId.get(tokenId)
      if (!user) {
        warnings.push(
          `  ADMIN_TOKEN_IDS pins tokenId ${tokenId} but no account holds it — admin ` +
          `bootstrap is DEAD (nobody has admin). Re-sync ADMIN_TOKEN_IDS to your ` +
          `admin's current tokenId.`,
        )
        continue
      }
      if (user.role === 'USER') {
        warnings.push(
          `  ADMIN_TOKEN_IDS grants admin to tokenId ${tokenId} (@${user.username}) whose ` +
          `stored role is USER — verify this is intentionally your admin. After a ` +
          `redeploy, tokenIds reassign and this may now be a DIFFERENT person. ` +
          `Re-sync ADMIN_TOKEN_IDS if so.`,
        )
        continue
      }
      // role is ADMIN or MODERATOR — pin looks legitimate.
      logger.log(`[adminTokenIdGuard] tokenId ${tokenId} (@${user.username}) role=${user.role} — OK`)
    }

    if (warnings.length > 0) {
      logger.warn(
        '\n\n' +
        '════════════════════════════════════════════════════════════════════\n' +
        '  ⚠️  ADMIN_TOKEN_IDS MAY BE STALE — verify bootstrap admin access\n' +
        '════════════════════════════════════════════════════════════════════\n' +
        warnings.join('\n\n') + '\n\n' +
        '  This is a WARNING ONLY — boot is proceeding. ADMIN_TOKEN_IDS pins\n' +
        '  admin access to a tokenId, and tokenIds REASSIGN on a contract\n' +
        '  redeploy — a pinned id can silently point at a different holder.\n\n' +
        '  ➜  Edit client/.env, update ADMIN_TOKEN_IDS to your admin\'s current\n' +
        '     tokenId, then restart (e.g. `pm2 startOrReload ecosystem.config.cjs`).\n' +
        '════════════════════════════════════════════════════════════════════\n',
      )
    }
  } catch (err) {
    // Advisory check only — a DB hiccup here must never affect boot.
    logger.warn('[adminTokenIdGuard] check skipped (non-fatal):', (err as Error)?.message)
  } finally {
    await prisma.$disconnect().catch(() => { /* ignore */ })
  }
}
