/**
 * useProfilelessPasskeyWallets — surface passkey (Pop-B) SmartEOA wallets that
 * this browser controls but that own NO profile, yet still hold non-dust CAW/ETH
 * on L1.
 *
 * Why this exists: transferring a passkey wallet's LAST profile out (to a foreign
 * address) evicts it from tokenDataStore, so the normal chooser/AccountSettings
 * grouping — which iterates tokensByAddress named tokens — can never show it. Any
 * CAW/ETH left in that wallet becomes unreachable in the UI. This hook enumerates
 * the durable "passkey wallets I control" set (constants/passkeyStorage) PLUS the
 * current recovery-mode address (backup-file load), removes any that still own a
 * profile locally, reads each one's L1 CAW + ETH balance, and returns those above
 * a dust threshold so AccountSettings can render a rescue card.
 *
 * Signing for these wallets does NOT require a stored credential: the rescue flow
 * uses a DISCOVERABLE passkey assertion (the OS offers any resident passkey) or
 * the recovery key. See constants/passkeyStorage + services/identity/passkey
 * signDigestWithDiscoverablePasskey.
 */

import { useEffect, useMemo, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import { chains } from '~/config/chains'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { useTokenDataStore, usePriceStore } from '~/store/tokenDataStore'
import { listPasskeyWallets } from '~/constants/passkeyStorage'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'

export interface ProfilelessWallet {
  address: Address
  cawWei: bigint
  ethWei: bigint
  /** USD value of the CAW + ETH held (best-effort; 0 if prices unavailable). */
  usd: number
  /** True when this address is the current backup-file recovery-mode key. */
  fromRecovery: boolean
}

// Dust floor: below this combined USD value we don't surface the wallet (avoids
// cluttering the list with empty/near-empty wallets). CAW is ~$3.8e-8, so this is
// still a very small amount of ETH or a meaningful chunk of CAW.
const DUST_USD = 0.05

export function useProfilelessPasskeyWallets(): {
  wallets: ProfilelessWallet[]
  loading: boolean
  /** Re-read balances (call after a successful rescue to refresh the list). */
  refresh: () => void
} {
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined
  const ethPriceUsd = usePriceStore(s => s.priceMap['ethereum']) as number | undefined
  const recovery = useRecoveryContext()

  const [wallets, setWallets] = useState<ProfilelessWallet[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // Candidate addresses: durable known-passkey-wallets set + recovery address,
  // MINUS any address that currently owns a profile locally (those show in the
  // normal grouping, not as a rescue card).
  const ownedLc = useMemo(
    () =>
      new Set(
        Object.entries(tokensByAddress)
          .filter(([, toks]) => (toks?.length ?? 0) > 0)
          .map(([addr]) => addr.toLowerCase()),
      ),
    [tokensByAddress],
  )

  const candidates = useMemo(() => {
    const set = new Set(listPasskeyWallets())
    if (recovery.isInRecoveryMode && recovery.address) set.add(recovery.address.toLowerCase())
    for (const owned of ownedLc) set.delete(owned)
    return Array.from(set)
  }, [ownedLc, recovery.isInRecoveryMode, recovery.address, nonce])

  const recoveryLc = recovery.address?.toLowerCase()

  useEffect(() => {
    if (!l1Client || candidates.length === 0) {
      setWallets([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const results = await Promise.all(
        candidates.map(async (addr): Promise<ProfilelessWallet | null> => {
          try {
            const [cawWei, ethWei] = await Promise.all([
              l1Client.readContract({
                address: CAW_ADDRESS as Address,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [addr as Address],
              }) as Promise<bigint>,
              l1Client.getBalance({ address: addr as Address }),
            ])
            const cawUsd = cawPriceUsd ? Number(cawWei) / 1e18 * cawPriceUsd : 0
            const ethUsd = ethPriceUsd ? Number(ethWei) / 1e18 * ethPriceUsd : 0
            const usd = cawUsd + ethUsd
            return {
              address: addr as Address,
              cawWei,
              ethWei,
              usd,
              fromRecovery: addr === recoveryLc,
            }
          } catch {
            return null
          }
        }),
      )
      if (cancelled) return
      const kept = results
        .filter((w): w is ProfilelessWallet => w != null)
        // Keep if USD is above dust, OR (prices unavailable) if any raw balance is
        // non-zero — never hide funds just because a price feed is down.
        .filter(w => (w.usd >= DUST_USD) || ((!cawPriceUsd || !ethPriceUsd) && (w.cawWei > 0n || w.ethWei > 0n)))
        .sort((a, b) => (b.usd - a.usd))
      setWallets(kept)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [l1Client, candidates, cawPriceUsd, ethPriceUsd, recoveryLc])

  return { wallets, loading, refresh: () => setNonce(n => n + 1) }
}
