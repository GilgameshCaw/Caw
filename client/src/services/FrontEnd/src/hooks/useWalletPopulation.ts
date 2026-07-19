/**
 * useWalletPopulation.ts
 *
 * Detects which Population the currently-ACTIVE PROFILE belongs to.
 *
 * Population A — plain EOA, or a 7702-delegate address this browser cannot sign
 *               for (no stored passkey credential): no bytecode, or bytecode
 *               present but unusable from here.
 * Population B — the active profile's owner address is an EIP-7702 SmartEOA AND
 *               this browser holds a WebAuthn credential for one of that owner's
 *               tokens — i.e. this browser can actually produce a passkey
 *               signature for it.
 * Population C — other smart-contract account (e.g. Safe, Gnosis)
 * none         — no wallet connected and no resolvable passkey-owned active profile
 *
 * WHY CREDENTIAL-GATED, NOT BYTECODE-GATED OR MARKER-GATED:
 *   - Bytecode alone is not enough: a passkey (7702) address added to another
 *     wallet (e.g. Rabby) as a WATCH-ONLY viewer has the 0xef0100... delegation
 *     designator on-chain, but this browser holds no credential for it and so
 *     cannot produce a signature. That must classify as 'A' (no passkey signing
 *     possible here), never 'B'.
 *   - The old `isPasskeyAddress(lastAddress)` marker is a browser-global "last
 *     passkey owner I signed in as" flag scoped to a SINGLE address. A browser
 *     can hold passkey credentials for MULTIPLE addresses (a user's several
 *     SmartEOAs), and a profile TRANSFERRED between two of the user's own
 *     passkey addresses keeps its own tokenId/credential — but the marker only
 *     ever remembers one address, so a freshly-transferred-in profile under a
 *     different-but-still-owned address was wrongly falling through to 'A'.
 *   - The per-tokenId WebAuthn credential (`hasPasskeyCredentialForAddress`) is
 *     the actual capability test: "can this browser sign for this address right
 *     now", independent of which address happened to sign in last.
 */

import { useMemo } from 'react'
import type { Address } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useTokenDataStore, useActiveTokenOwnerAddress } from '~/store/tokenDataStore'
import { hasPasskeyCredentialForAddress } from '~/constants/passkeyStorage'

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
  // Browser-global "last passkey owner" — still used as a pre-hydration fallback
  // for effectiveAddress/loading semantics, but no longer the PRIMARY classifier.
  const lastAddress = useTokenDataStore(s => s.lastAddress) as Address | undefined
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  // The owner address of the currently-active PROFILE. A user can own a MIX of
  // passkey (Pop-B) and plain-EOA (Pop-A) profiles in one chooser; we classify by
  // which profile is active, not by a browser-global "ever enrolled a passkey"
  // flag.
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

  // THE primary passkey signal: does THIS BROWSER hold a WebAuthn credential for
  // any token owned by the ACTIVE profile's owner address? This is per-ADDRESS
  // (covers sibling profiles under the same SmartEOA, including a profile that
  // was just transferred in) and per-BROWSER (a watch-only viewer with no
  // credential correctly fails this test even though the address is a 7702
  // delegate on-chain).
  const activeOwnerHasPasskey = useMemo(
    () => hasPasskeyCredentialForAddress(activeOwner, tokensByAddress),
    [activeOwner, tokensByAddress]
  )

  const population = useMemo<WalletPopulation>(() => {
    // Recovery mode (backup-file sign-in) is unambiguously Population B regardless
    // of wallet state — the secp256k1 ecdsaFallback key is the active signer.
    if (recoveryCtx.isInRecoveryMode) return 'B'

    // A wagmi wallet is CONNECTED but its address isn't available yet — the wallet
    // is locked or still initializing. This is a TRANSIENT wallet state; do NOT
    // fall through to the credential-based branch below, since the active token
    // may not have resolved yet either. Return 'none'+loading so signing waits
    // for the wallet to unlock.
    if (isConnected && !address) return 'none'

    // PRIMARY classifier: the active profile's owner address has a passkey
    // credential in THIS browser → Population B, regardless of whether a wagmi
    // wallet happens to be connected (and regardless of which address it is —
    // the connected wallet may be an unrelated/incidental EOA, or the same
    // SmartEOA reflected via a wallet extension). This covers:
    //   - a profile transferred between two of the user's own passkey addresses
    //     (both credentials already live in this browser)
    //   - a sponsored Pop-B user on a cold load with no wagmi wallet connected
    //   - a roamed browser with an unrelated EOA connected
    // and explicitly EXCLUDES a watch-only passkey address with no credential
    // here (falls through to bytecode below, which would say 'B' from the
    // on-chain 0xef0100 delegate bytes — that's exactly the case this gate
    // prevents from being misclassified as signable).
    if (activeOwnerHasPasskey) return 'B'

    // No wagmi wallet at all, and the active owner has no local passkey
    // credential — nothing to classify against.
    if (!isConnected || !address) return 'none'

    if (isLoading) return 'none'
    // bytecode from getCode is Hex | undefined; convert to string for classifier.
    // NOTE: this can still report 'B' for a 7702 delegate address purely from its
    // on-chain bytecode (e.g. a watch-only passkey address with no local
    // credential, or a connected wallet whose address happens to equal a 7702
    // delegate this browser can't sign for). That's fine here — the credential
    // gate above already claimed every case where signing is actually possible;
    // reaching this line for a 7702-coded address means we have NO credential for
    // it, and bytecode-only 'B' would be a lie about signing capability. Guard it:
    const code = bytecode === undefined ? undefined : (bytecode as string)
    const bytecodeClass = classifyBytecode(code)
    // A 7702-delegate address without a local credential cannot sign as a
    // passkey from this browser — treat it as Population A (no on-chain-only
    // signing path is wired for it), never 'B'.
    if (bytecodeClass === 'B') return 'A'
    return bytecodeClass
  }, [isConnected, address, isLoading, bytecode, recoveryCtx.isInRecoveryMode, activeOwnerHasPasskey])

  // Surface the correct owner address for the active population.
  //   - recovery mode: the recovered address.
  //   - active owner has a local passkey credential (population === 'B' via the
  //     primary classifier): the ACTIVE OWNER address, not the incidentally
  //     connected wagmi wallet — otherwise downstream owner checks (DM
  //     pre-flight, Quick Sign) compare against the wrong address and abort with
  //     "wrong wallet".
  //   - otherwise: the connected wallet (or lastAddress as a last resort while
  //     nothing is connected).
  const effectiveAddress = (!isConnected && recoveryCtx.isInRecoveryMode)
    ? (recoveryCtx.address ?? undefined)
    : (activeOwnerHasPasskey && activeOwner)
      ? (activeOwner as Address)
      : (!isConnected && lastAddress)
        ? lastAddress
        : address

  return {
    population,
    // Loading while the bytecode query runs, OR while a connected wallet hasn't
    // surfaced its address yet (locked/initializing) and we're not in recovery —
    // callers should wait rather than treat the user as a final population.
    // Skip the bytecode-loading wait entirely once the credential gate has
    // already resolved population to 'B' — no need for an on-chain read.
    loading: (!activeOwnerHasPasskey && isConnected && !!address && isLoading) ||
             (isConnected && !address && !recoveryCtx.isInRecoveryMode),
    address: effectiveAddress,
  }
}
