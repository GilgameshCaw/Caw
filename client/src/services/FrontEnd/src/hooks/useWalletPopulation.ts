/**
 * useWalletPopulation.ts
 *
 * Detects which Population the currently-connected wallet belongs to by
 * inspecting the bytecode at the wallet's address.
 *
 * Population A — plain EOA: no bytecode (code === undefined or '0x' or length 0)
 * Population B — EIP-7702 delegated EOA: code starts with 0xef0100 AND is
 *               exactly 23 bytes (the canonical 7702 delegation designator,
 *               3-byte magic + 20-byte implementation address).
 * Population C — other smart-contract account (e.g. Safe, Gnosis)
 * none         — no wallet connected
 */

import { useMemo } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useTokenDataStore, useActiveTokenOwnerAddress } from '~/store/tokenDataStore'
import { isPasskeyAddress } from '~/constants/passkeyStorage'

export type WalletPopulation = 'A' | 'B' | 'C' | 'none'

export interface UseWalletPopulationReturn {
  population: WalletPopulation
  loading: boolean
  address: `0x${string}` | undefined
}

/**
 * Classifies a hex bytecode string into A / B / C.
 * Exported for unit testing without React.
 */
export function classifyBytecode(code: string | undefined): 'A' | 'B' | 'C' {
  // Undefined or empty → plain EOA
  if (!code || code === '0x' || code.length === 0) return 'A'

  // EIP-7702 delegation designator: exactly 0xef0100 + 20 byte address = 23 bytes.
  // Hex representation: '0x' prefix + 46 chars = 48 chars total.
  const EIP7702_MAGIC = '0xef0100'
  if (
    code.toLowerCase().startsWith(EIP7702_MAGIC) &&
    code.length === 48 // '0x' + 46 hex chars = 23 bytes
  ) {
    return 'B'
  }

  return 'C'
}

export function useWalletPopulation(): UseWalletPopulationReturn {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const recoveryCtx = useRecoveryContext()
  // Reactive: re-evaluate population when the stored Pop-B owner address changes
  // (set by Onboarding.tsx after a sponsored mint). Sponsored Population-B users
  // never connect a wagmi wallet, so without this they classify as 'none'.
  const lastAddress = useTokenDataStore(s => s.lastAddress) as Address | undefined
  // The owner address of the currently-active PROFILE. A user can own a MIX of
  // passkey (Pop-B) and plain-EOA (Pop-A) profiles in one chooser; we classify
  // by which profile is active, not by a browser-global "ever enrolled a
  // passkey" flag. A passkey profile is owned by the SmartEOA address persisted
  // as lastAddress; a Pop-A profile is owned by a different (real EOA) address.
  const activeOwner = useActiveTokenOwnerAddress()

  const { data: bytecode, isLoading } = useQuery({
    queryKey: ['wallet-bytecode', address],
    queryFn: async () => {
      if (!publicClient || !address) return undefined
      return publicClient.getCode({ address })
    },
    enabled: isConnected && !!address && !!publicClient,
    // Match project-wide staleTime of 5 min (project_infura_quota_dials.md)
    staleTime: 5 * 60 * 1000,
    // Reconnect / address change triggers a refetch automatically via queryKey
  })

  // A returning passkey (Population B) install marks itself via localStorage at
  // enroll (PasskeyStep). Sponsored Pop-B users never connect a wagmi wallet, so
  // this flag — plus the stored owner address — is how we classify them on a
  // cold load. Recovery mode (backup-file sign-in) is the other Pop-B signal.
  // Per-account: is the active profile's owner a passkey account? Keyed by owner
  // address (lastAddress), which survives the pre-hydration window when the
  // active tokenId isn't resolved yet. No browser-global flag — so a different
  // account on the same browser no longer bleeds into a passkey classification.
  const isPasskeyInstall = isPasskeyAddress(lastAddress)

  const population = useMemo<WalletPopulation>(() => {
    // Recovery mode (backup-file sign-in) is unambiguously Population B regardless
    // of wallet state — the secp256k1 ecdsaFallback key is the active signer.
    if (recoveryCtx.isInRecoveryMode) return 'B'

    // A wagmi wallet is CONNECTED but its address isn't available yet — the wallet
    // is locked or still initializing. This is a TRANSIENT wallet state, not a
    // passkey user: do NOT fall through to the passkey-install branch (a stale
    // "this browser enrolled a passkey" marker would otherwise misclassify a
    // Population-A wallet user as B and route them to the backup-file signer).
    // Return 'none'+loading so signing waits for the wallet to unlock.
    if (isConnected && !address) return 'none'

    // A wagmi wallet IS connected, but it does NOT own the active profile, and
    // the active profile is owned by a known passkey (Pop-B) address. This is the
    // "roamed to a new browser that happens to have an unrelated EOA connected"
    // case: the connected wallet is incidental, the passkey account is the real
    // signer for THIS profile. Without this, we'd classify by the connected
    // wallet's bytecode (a plain EOA → 'A'), route DM/Quick-Sign through the wrong
    // wallet, and the passkey account's roamed session/DM would never restore.
    // Match the active profile's owner against the passkey owner (lastAddress) so
    // this only fires when the passkey account is actually the active one.
    if (
      isConnected &&
      address &&
      isPasskeyInstall &&
      lastAddress &&
      activeOwner === lastAddress.toLowerCase() &&
      address.toLowerCase() !== lastAddress.toLowerCase()
    ) {
      return 'B'
    }

    // No wagmi wallet at all. A passkey install with a known owner address is a
    // sponsored Population-B user (they never connect a wagmi wallet) — BUT only
    // if the ACTIVE profile is actually owned by that passkey address. The
    // passkey-install flag is browser-global, so a browser that once enrolled a
    // passkey would otherwise misclassify a Pop-A profile (a plain-EOA-owned
    // token shown in the same chooser) as B and surface the passkey-only Wallet
    // link / backup-file signer. Match the active profile's owner against the
    // passkey owner (lastAddress) so the classification is per-PROFILE.
    if (!isConnected || !address) {
      if (
        isPasskeyInstall &&
        lastAddress &&
        // The active profile must belong to the passkey owner. If we can't yet
        // resolve the active owner (pre-hydration), fall back to the old
        // behaviour (treat as B) so a genuine sponsored Pop-B user isn't locked
        // out on a cold load before the token store hydrates.
        (activeOwner === undefined || activeOwner === lastAddress.toLowerCase())
      ) {
        return 'B'
      }
      return 'none'
    }
    if (isLoading) return 'none'
    // bytecode from getCode is Hex | undefined; convert to string for classifier
    const code = bytecode === undefined ? undefined : (bytecode as string)
    return classifyBytecode(code)
  }, [isConnected, address, isLoading, bytecode, recoveryCtx.isInRecoveryMode, isPasskeyInstall, lastAddress, activeOwner])

  // Surface the correct owner address for the active population.
  //   - recovery mode: the recovered address.
  //   - passkey profile active while a DIFFERENT wagmi wallet is connected (the
  //     roamed-browser case above): the passkey owner, NOT the incidental wallet
  //     — otherwise downstream owner checks (DM pre-flight, Quick Sign) compare
  //     against the wrong address and abort with "wrong wallet".
  //   - no wagmi wallet + passkey install: the stored passkey owner.
  //   - otherwise: the connected wallet.
  const activeProfileIsRoamedPasskey =
    isConnected &&
    !!address &&
    isPasskeyInstall &&
    !!lastAddress &&
    activeOwner === lastAddress.toLowerCase() &&
    address.toLowerCase() !== lastAddress.toLowerCase()
  const effectiveAddress = (!isConnected && recoveryCtx.isInRecoveryMode)
    ? (recoveryCtx.address ?? undefined)
    : (activeProfileIsRoamedPasskey || (!isConnected && isPasskeyInstall))
      ? lastAddress
      : address

  return {
    population,
    // Loading while the bytecode query runs, OR while a connected wallet hasn't
    // surfaced its address yet (locked/initializing) and we're not in recovery —
    // callers should wait rather than treat the user as a final population.
    loading: (isConnected && !!address && isLoading) ||
             (isConnected && !address && !recoveryCtx.isInRecoveryMode),
    address: effectiveAddress,
  }
}
