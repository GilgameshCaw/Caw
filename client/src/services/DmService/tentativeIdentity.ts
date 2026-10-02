import { prisma } from '../../prismaClient'

/**
 * Settle a DmIdentity row that an identity relay accepted tentatively, now
 * that this node knows the name's on-chain owner.
 *
 * POST /api/dm/identity/relay accepts a key without checking the wallet when
 * the local User row has no address yet, and records the relayed wallet in
 * `relayedWalletAddress`. Once the owner is known:
 * - relayed wallet == owner: the row is confirmed; the marker is cleared
 *   (only while it still names that wallet, like the other two branches).
 * - relayed wallet != owner, and the row still holds the key registered for
 *   that wallet: the key is cleared (publicKey '' = no key, the same
 *   placeholder ensureDmIdentity and clearStaleDmKeys use) and the row is
 *   marked revoked. Nothing reads `revoked` to stop serving a key, so the
 *   clear is what keeps senders from encrypting to it.
 * - relayed wallet != owner, but the row has since been re-registered for
 *   another wallet (the owner's own POST /identity or a later relay): that
 *   key is not the relayed one; only the stale marker is cleared.
 *
 * Call it wherever User.address gets written from chain: the Transfer
 * watcher, refreshUserFromChain (placeholder rows created by DM relay), and
 * syncTokensOwnedByWallet (not imported anywhere today; settled there so a
 * future caller does not skip it).
 *
 * Non-fatal: failures log but do not surface to the caller.
 *
 * Audit: 2026-05-22 DM-2
 */
export async function settleTentativeDmIdentity(tokenId: number, ownerAddress: string, source: string): Promise<void> {
  try {
    const identity = await prisma.dmIdentity.findUnique({
      where: { userId: tokenId },
      select: { relayedWalletAddress: true, walletAddress: true, publicKey: true },
    })
    if (!identity || !identity.relayedWalletAddress) return
    const relayed = identity.relayedWalletAddress.toLowerCase()
    const owner = ownerAddress.toLowerCase()

    if (relayed === owner) {
      await prisma.dmIdentity.updateMany({
        where: { userId: tokenId, relayedWalletAddress: identity.relayedWalletAddress },
        data: { relayedWalletAddress: null },
      })
      return
    }

    if (identity.walletAddress.toLowerCase() === relayed) {
      await prisma.dmIdentity.updateMany({
        where: { userId: tokenId, walletAddress: { equals: identity.relayedWalletAddress, mode: 'insensitive' } },
        data: { publicKey: '', revoked: true, relayedWalletAddress: null },
      })
      console.warn(
        `[${source}] DmIdentity: tokenId=${tokenId} key cleared` +
        ` — relayed wallet ${identity.relayedWalletAddress} ≠ on-chain ${ownerAddress}`,
      )
    } else {
      await prisma.dmIdentity.updateMany({
        where: { userId: tokenId, relayedWalletAddress: identity.relayedWalletAddress },
        data: { relayedWalletAddress: null },
      })
    }
  } catch (err: any) {
    console.warn(`[${source}] DmIdentity settle failed for tokenId=${tokenId}:`, err?.message)
  }
}
