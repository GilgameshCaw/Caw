import { useCallback, useEffect } from 'react'
import { hashMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSignMessage, useSwitchChain, useChainId, useAccount } from 'wagmi'
import { useReadContract } from 'wagmi'
import { useConnectModalBridge as useConnectModal } from '~/hooks/useConnectModalBridge'
import { baseSepolia } from 'wagmi/chains'
import { apiFetch } from '~/api/client'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { CLIENT_ID } from '~/api/actions'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useRootSigner } from '~/hooks/useRootSigner'
import { encryptPrivateKey, getEncryptionSignMessage, setDecryptedKey } from '~/services/sessionKeyEncryption'
import { cawProfileLedgerAbi } from '~/../../../abi/generated'
import { isPasskeyAddress } from '~/constants/passkeyStorage'

export const DEFAULT_SESSION_DURATION = 180 * 24 * 60 * 60 // 6 months

export const SESSION_DURATION_OPTIONS = [
  { label: '1 month',   value: 30 * 24 * 60 * 60 },
  { label: '3 months',  value: 90 * 24 * 60 * 60 },
  { label: '6 months',  value: 180 * 24 * 60 * 60 },
  { label: '1 year',    value: 365 * 24 * 60 * 60 },
]

// Default scope: CAW(0), LIKE(1), UNLIKE(2), RECAW(3), FOLLOW(4), UNFOLLOW(5)
// Bits 0-5 (caw, like, unlike, recaw, follow, unfollow) + bit 7 (other: tips, profile updates, etc.)
// Bit 6 (withdraw) is the only one excluded
const DEFAULT_SCOPE = 0xBF // 0b10111111

// Default spend limit: $10 worth of CAW at current price, with a generous fallback
const DEFAULT_SPEND_USD = 10
const FALLBACK_SPEND_LIMIT = BigInt(500_000_000) // 500M CAW fallback if price unavailable

/** Get the default spend limit ($10 worth of CAW at current price) */
export function getDefaultSpendLimit(): bigint {
  const cawPrice = usePriceStore.getState().priceMap['a-hunters-dream'] ?? 0
  if (cawPrice > 0) {
    return BigInt(Math.round(DEFAULT_SPEND_USD / cawPrice))
  }
  return FALLBACK_SPEND_LIMIT
}

// Legacy export for any direct references
export const DEFAULT_SPEND_LIMIT = FALLBACK_SPEND_LIMIT

/** Get the default tip ceiling: the "Fast" tier (priority tip).
 *  We default to the highest tier so users get the snappiest experience by
 *  default; they can always dial it down if they want to save CAW.
 *  Callers should pass `getTipTiers().fast` from `~/api/actions`. */
export function getDefaultTipCeiling(fastTierTip: bigint): bigint {
  return fastTierTip
}

export const SPEND_LIMIT_OPTIONS = [
  { label: '10M',  value: BigInt(10_000_000) },
  { label: '50M',  value: BigInt(50_000_000) },
  { label: '100M', value: BigInt(100_000_000) },
  { label: '500M', value: BigInt(500_000_000) },
  { label: 'No limit', value: BigInt(0) },
]

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function formatSpendLimitForMessage(spendLimit: bigint): string {
  const n = Number(spendLimit)
  if (n === 0) return '0M'
  if (n >= 1_000_000_000 && n % 1_000_000_000 === 0) return `${n / 1_000_000_000}B`
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`
  // Round up to nearest million
  return `${Math.ceil(n / 1_000_000)}M`
}

// TEMPORARY (remove at the next testnet redeploy): the DEPLOYED SessionMessageParser
// tip parser only accepts a PLAIN integer + " CAW" with nothing after — no M/K/B
// suffix, no "(~$x)" note. The updated parser (committed, awaiting redeploy) adds
// the suffix + tolerates the note. Until the parser is redeployed + relinked, the
// FE MUST emit the legacy plain-integer form or registerSessionPersonal reverts
// BadParse(). Flip to false (or delete this branch) once the new parser is live.
const LEGACY_TIP_FORMAT = true

// Tip line for the SIGNED message. New parser reads "<n>[M|K|B] CAW" and ignores a
// trailing " (...)" note (readable: "1M CAW (~$0.0010)"). Legacy/deployed parser
// reads ONLY "<n> CAW" (plain integer, no suffix, no note). 0 = opt-out must be
// the literal "0 CAW" in both ("none"/"0M CAW" → BadParse).
function formatTipCeilingForMessage(tipCeiling: bigint, cawPrice: number): string {
  if (tipCeiling === 0n) return '0 CAW'
  if (LEGACY_TIP_FORMAT) {
    // Plain whole-token integer the deployed parser accepts (e.g. "1000000 CAW").
    return `${tipCeiling.toString()} CAW`
  }
  const cawStr = `${formatSpendLimitForMessage(tipCeiling)} CAW`
  if (cawPrice > 0) {
    const usd = Number(tipCeiling) * cawPrice
    const usdStr = usd < 0.001 ? `~$${usd.toFixed(6)}` : `~$${usd.toFixed(4)}`
    return `${cawStr} (${usdStr})`
  }
  return cawStr
}

function buildSessionMessage(sessionKeyAddress: string, spendLimit: bigint, expiryTimestamp: number, tipCeiling: bigint = 0n, cawPrice: number = 0): string {
  const d = new Date(expiryTimestamp * 1000)
  const day = d.getUTCDate()
  const month = MONTHS[d.getUTCMonth()]
  const year = d.getUTCFullYear()
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')

  const lines = [
    'Enable Quick Sign',
    '------------------',
    'Spend limit:',
    `${formatSpendLimitForMessage(spendLimit)} CAW`,
    '',
    'Tip per action:',
    formatTipCeilingForMessage(tipCeiling, cawPrice),
    '',
    'Expires:',
    `${day} ${month} ${year} ${hh}:${mm}:${ss} UTC`,
    '',
    'CAW Key:',
    sessionKeyAddress,
  ]

  return lines.join('\n')
}

const SESSION_DOMAIN = {
  name:              'CawProfileLedger',
  version:           '1',
  chainId:           baseSepolia.id,
  verifyingContract: CAW_NAMES_L2_ADDRESS,
} as const

export function useCreateSession() {
  const { signMessageAsync } = useSignMessage()
  const { switchChainAsync } = useSwitchChain()
  const { isConnected, address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const setSession = useSessionKeyStore(s => s.setSession)
  const activeToken = useActiveToken()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const rootSigner = useRootSigner()

  return useCallback(async (onProgress?: (status: string) => void, spendLimit: bigint = DEFAULT_SPEND_LIMIT, durationSeconds: number = DEFAULT_SESSION_DURATION, encryptWithWallet: boolean = false, tipCeiling: bigint = 0n) => {
    // Population B (passkey, no wagmi wallet) authorizes the session via the
    // root signer (ecdsaFallback in recovery mode); skip the wallet-connect
    // and chain-switch flow entirely. Population A keeps the wagmi path.
    const isPasskey = rootSigner.kind === 'passkey'

    if (!isPasskey) {
      if (!isConnected) {
        openConnectModal?.()
        return null as any // User will retry after connecting
      }

      // Wallet may have switched accounts (or unlocked into a different one)
      // since the user opened this profile. Refuse to ask for a signature
      // from the wrong address — the resulting session would be bound to a
      // wallet that doesn't own this token, and the user gets a confusing
      // wallet popup for an account they didn't expect.
      const expectedOwner = activeToken?.owner?.toLowerCase()
      const actualOwner = connectedAddress?.toLowerCase()
      if (expectedOwner && actualOwner && expectedOwner !== actualOwner) {
        throw new Error(
          `Wrong wallet connected. This profile is owned by ${activeToken!.owner!.slice(0, 6)}…${activeToken!.owner!.slice(-4)}, ` +
          `but your wallet is connected as ${connectedAddress!.slice(0, 6)}…${connectedAddress!.slice(-4)}. ` +
          `Switch accounts in your wallet and try again.`
        )
      }

      // Ensure wallet is on Base Sepolia (where CawProfileLedger lives)
      if (chainId !== baseSepolia.id) {
        onProgress?.('Switching network...')
        await switchChainAsync({ chainId: baseSepolia.id })
      }
    } else {
      // Passkey: throws a clear "use your backup file" error if no signer is
      // available on this device, instead of popping a wallet modal.
      await rootSigner.ensureReady()
    }

    onProgress?.('Generating session key...')

    const expiry = Math.floor(Date.now() / 1000) + durationSeconds

    // Generate ephemeral keypair
    const privateKey = generatePrivateKey()
    const sessionAccount = privateKeyToAccount(privateKey)

    const message = buildSessionMessage(sessionAccount.address, spendLimit, expiry, tipCeiling)

    console.log('[QuickSign] message:', message)

    onProgress?.('Sign to authorize key...')

    let signature: `0x${string}`
    try {
      if (isPasskey) {
        // Population B — sign the EIP-191 digest with the passkey (WebAuthn blob)
        // or the recovery key if present. hashMessage produces the same digest the
        // contract recomputes inside registerSessionPersonal, so the ERC-1271 path
        // (_challengeMatchesDigest) verifies correctly. signDigest prefers the
        // recovery key when available (65-byte ECDSA, cheaper) and falls back to
        // the WebAuthn assertion (>65 bytes, validated via SmartEOA.isValidSignature).
        const digest = hashMessage(message) // EIP-191 personal_sign hash
        signature = await rootSigner.signDigest(digest)
      } else {
        // Population A — wagmi personal_sign (65-byte ECDSA, ECDSA recovery path).
        signature = await rootSigner.signMessage(message)
      }
    } catch (err) {
      console.error('[QuickSign] signMessage failed:', err)
      throw err
    }

    console.log('[QuickSign] signature obtained, submitting to validator...')
    onProgress?.('Submitting...')

    const result = await apiFetch<{ requestId: string; status: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ message, signature }),
    })

    console.log('[QuickSign] Request created:', result.requestId)

    // Poll for completion (backend handles L2 sync waiting + tx submission)
    for (let i = 0; i < 80; i++) { // max ~4 minutes (covers 3min sync + tx time)
      await new Promise(r => setTimeout(r, 3000))
      try {
        const status = await apiFetch<{ status: string; txHash?: string; blockNumber?: number; error?: string }>(
          `/api/sessions/status/${result.requestId}`
        )

        // Update progress message based on backend state
        if (status.status === 'waiting_for_sync') {
          onProgress?.('Waiting for L2 sync...')
        } else if (status.status === 'submitting') {
          onProgress?.('Registering on-chain...')
        } else if (status.status === 'pending') {
          onProgress?.('Confirming transaction...')
        } else if (status.status === 'confirmed') {
          console.log('[QuickSign] Confirmed:', status.txHash, 'block:', status.blockNumber)
          break
        } else if (status.status === 'failed') {
          console.error('[QuickSign] Registration failed:', status.error, 'Full status:', JSON.stringify(status))
          throw new Error(status.error || 'Something went wrong. Please try again.')
        }
      } catch (e: any) {
        if (e.message && !e.message.includes('API')) throw e
        // Ignore transient polling errors
      }
    }

    // Store session locally after confirmation
    if (encryptWithWallet && connectedAddress) {
      onProgress?.('Encrypting session key...')
      // Sign a deterministic message to derive the encryption key
      const walletSig = await signMessageAsync({ message: getEncryptionSignMessage() })
      const encryptedKey = await encryptPrivateKey(privateKey, walletSig)

      // Store decrypted key in memory + broadcast to other tabs
      setDecryptedKey(connectedAddress, privateKey)

      setSession({
        privateKey: '0xencrypted' as `0x${string}`, // placeholder — real key is in memory
        address: sessionAccount.address,
        ownerAddress: connectedAddress?.toLowerCase(),
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
        encrypted: true,
        encryptedKey,
      })
    } else {
      setSession({
        privateKey,
        address: sessionAccount.address,
        ownerAddress: connectedAddress?.toLowerCase(),
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
      })
    }

    return { address: sessionAccount.address, expiry }
  }, [isConnected, connectedAddress, openConnectModal, chainId, signMessageAsync, switchChainAsync, setSession, activeToken, cawPrice, rootSigner])
}

/**
 * Register a Quick Sign session WITHOUT a wagmi wallet — for the sponsored
 * Population-B onboarding flow, where the secp256k1 ecdsaFallback key is still
 * in memory (via the bootstrap `signVerifyMessage` closure) right after mint.
 *
 * Signer-agnostic: pass a `signMessage(msg) => Promise<sig>` that produces a
 * 65-byte ECDSA personal_sign (the ecdsaFallback closure does this), plus the
 * `ownerAddress` the session is bound to. Builds the same "Enable Quick Sign"
 * message as useCreateSession, POSTs /api/sessions, polls to confirmation, then
 * persists to sessionKeyStore IMMEDIATELY (per feedback_persist_session_in_onSuccess
 * — the key is GC'd if we navigate away mid-poll, so persist on success, not in
 * a later closure).
 *
 * Standalone function (not a hook) so it can run inside Onboarding's async
 * post-mint handler. Returns the session address + expiry, or throws.
 */
export async function registerSponsoredSession(opts: {
  signMessage: (message: string) => Promise<`0x${string}`>
  ownerAddress: `0x${string}`
  spendLimit?: bigint
  durationSeconds?: number
  tipCeiling?: bigint
  cawPrice?: number
  onProgress?: (status: string) => void
}): Promise<{ address: `0x${string}`; expiry: number }> {
  const {
    signMessage,
    ownerAddress,
    spendLimit = DEFAULT_SPEND_LIMIT,
    durationSeconds = DEFAULT_SESSION_DURATION,
    tipCeiling = 0n,
    cawPrice = 0,
    onProgress,
  } = opts

  const expiry = Math.floor(Date.now() / 1000) + durationSeconds
  const privateKey = generatePrivateKey()
  const sessionAccount = privateKeyToAccount(privateKey)

  const message = buildSessionMessage(sessionAccount.address, spendLimit, expiry, tipCeiling)
  onProgress?.('Sign to authorize key...')
  const signature = await signMessage(message)

  onProgress?.('Submitting...')
  const result = await apiFetch<{ requestId: string; status: string }>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ message, signature }),
  })

  // Poll for completion (backend handles L2 sync waiting + tx submission).
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const status = await apiFetch<{ status: string; txHash?: string; error?: string }>(
        `/api/sessions/status/${result.requestId}`,
      )
      // Capture the registration tx hash as soon as it's known and write the
      // caw:pendingQuickSign hint. The session-reg tx confirms on L2 but takes a
      // moment to PROPAGATE to the node the validator reads — so an action signed
      // by this session in that gap (e.g. the stepper's profile-update right
      // after Quick Sign) gets rejected with "SessionInvalid". The hint makes
      // signAndSubmit forward pendingQuickSignTxHash so the validator HOLDS the
      // action until it sees the session, instead of failing it (actions.ts
      // reads caw:pendingQuickSign:<owner>). Mirrors the pendingDeposit hint.
      if (status.txHash && /^0x[0-9a-fA-F]{64}$/.test(status.txHash)) {
        try {
          localStorage.setItem(
            `caw:pendingQuickSign:${ownerAddress.toLowerCase()}`,
            JSON.stringify({ txHash: status.txHash, submittedAt: Date.now() }),
          )
        } catch { /* localStorage unavailable — validator may reject in the gap */ }
      }
      if (status.status === 'waiting_for_sync') onProgress?.('Waiting for L2 sync...')
      else if (status.status === 'submitting') onProgress?.('Registering on-chain...')
      else if (status.status === 'pending') onProgress?.('Confirming transaction...')
      else if (status.status === 'confirmed') break
      else if (status.status === 'failed') {
        throw new Error(status.error || 'Quick Sign registration failed. Please try again.')
      }
    } catch (e: any) {
      if (e.message && !e.message.includes('API')) throw e
      // Ignore transient polling errors.
    }
  }

  // Persist immediately on success — before any navigation — so the in-memory
  // session key isn't lost.
  useSessionKeyStore.getState().setSession({
    privateKey,
    address: sessionAccount.address,
    ownerAddress: ownerAddress.toLowerCase(),
    expiry,
    scopeBitmap: DEFAULT_SCOPE,
    spendLimit: spendLimit.toString(),
    tipCeiling: tipCeiling.toString(),
  })

  // Activate this owner so sessionForWallet() can find the session we just stored,
  // and flip the global enable flag — deriving a session IS opting in. Without
  // setEnabled, getActiveSession() short-circuits to null and the user shows as
  // "not connected" / no Quick Sign despite a valid stored session. A Pop-B passkey
  // user also has no wagmi `address`, so the normal setActiveWallet effect (keyed on
  // the wagmi address) never fires for them. (#240)
  useSessionKeyStore.getState().setActiveWallet(ownerAddress.toLowerCase())
  useSessionKeyStore.getState().setEnabled(true)

  return { address: sessionAccount.address, expiry }
}

/**
 * Reads the Network's on-chain tip target (denominated in CAW wei) from
 * CawProfileLedger, then converts it to whole CAW tokens. Defaults to this
 * build's CLIENT_ID (VITE_NETWORK_ID) so multi-Network mirrors read their own
 * target rather than hardcoding Network 1.
 *
 * Returns:
 *   - tipCeilingCaw: the converted amount in whole CAW (bigint), or undefined while loading
 *   - tipCeilingUsd: the USD equivalent (number), or 0 if prices unavailable
 *   - tipCeilingFallbackCaw: a $0.0009-denominated fallback in whole CAW (always defined)
 */
export function useNetworkTipTargetAsCAW(networkId: number = CLIENT_ID): {
  tipCeilingCaw: bigint | undefined
  tipCeilingUsd: number
  tipCeilingFallbackCaw: bigint
} {
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // Fallback: $0.0009 worth of CAW — the recommended default per-action tip
  // (matches the $0.0009 ★ preset in QuickSignOptions; accepted by the most
  // validators).
  const USD_FALLBACK = 0.0009
  const tipCeilingFallbackCaw: bigint =
    cawPrice > 0 ? BigInt(Math.max(1, Math.round(USD_FALLBACK / cawPrice))) : BigInt(1000)

  // networkTipTargetWei lives on CawProfileLedger (deployed at CAW_NAMES_L2_ADDRESS),
  // NOT on CawActions. Reading it off the wrong ABI/address silently fails and the
  // hook would always fall through to the USD fallback below.
  const { data: tipTargetWei } = useReadContract({
    address: CAW_NAMES_L2_ADDRESS as `0x${string}`,
    abi: cawProfileLedgerAbi,
    functionName: 'networkTipTargetWei',
    args: [networkId],
    chainId: baseSepolia.id,
    staleTime: 5 * 60 * 1000, // 5 minutes per project_infura_quota_dials
  } as any)

  if (tipTargetWei === undefined || tipTargetWei === null) {
    return { tipCeilingCaw: undefined, tipCeilingUsd: 0, tipCeilingFallbackCaw }
  }

  const tipTargetBigInt = tipTargetWei as bigint

  // tipTargetWei is in CAW-wei (18 decimals) — convert to whole CAW tokens
  // If the target is 0 on-chain, fall back to the USD-denominated default
  if (tipTargetBigInt === 0n) {
    return { tipCeilingCaw: tipCeilingFallbackCaw, tipCeilingUsd: USD_FALLBACK, tipCeilingFallbackCaw }
  }

  const wholeCAW = tipTargetBigInt / BigInt(10 ** 18)
  const tipCeilingCaw = wholeCAW > 0n ? wholeCAW : BigInt(1)

  // USD value: whole CAW * cawPrice
  const tipCeilingUsd = cawPrice > 0 ? Number(tipCeilingCaw) * cawPrice : 0

  return { tipCeilingCaw, tipCeilingUsd, tipCeilingFallbackCaw }
}

export function useRevokeSession() {
  const clearSession = useSessionKeyStore(s => s.clearSession)
  const session = useSessionKeyStore(s => s.getSession())
  const activeToken = useActiveToken()

  return useCallback(async () => {
    const sessionKey = session?.privateKey
    const sessionAddress = session?.address
    const ownerAddress = activeToken?.owner

    if (!sessionKey || !sessionAddress || !ownerAddress) {
      // No session or no owner info — just clear locally
      clearSession()
      return
    }

    // Sign a revocation message with the session key
    try {
      const sessionAccount = privateKeyToAccount(sessionKey)
      const signature = await sessionAccount.signTypedData({
        domain: SESSION_DOMAIN,
        types: {
          RevokeSession: [
            { name: 'owner', type: 'address' },
            { name: 'sessionKey', type: 'address' },
          ],
        },
        primaryType: 'RevokeSession',
        message: {
          owner: ownerAddress,
          sessionKey: sessionAddress,
        },
      })

      // Send to API — validator submits on-chain
      await apiFetch('/api/sessions', {
        method: 'DELETE',
        body: JSON.stringify({
          owner: ownerAddress,
          sessionKey: sessionAddress,
          signature,
        }),
      })
      console.log('[QuickSign] Session revoked on-chain via API')
    } catch (err: any) {
      // On-chain revocation failed — still clear locally
      // Session will expire naturally on-chain
      console.warn('[QuickSign] On-chain revocation failed, clearing locally:', err?.message)
    }

    // Always clear the local session (destroys the private key from this browser)
    clearSession()
  }, [session, activeToken, clearSession])
}

/**
 * Keeps the session store's active wallet in sync with the connected wallet.
 * Sessions are stored per-wallet, so switching wallets just changes which session is active —
 * switching back restores the original session without re-registration.
 *
 * Pop-B (passkey) users have no wagmi `address`, but they DO self-activate their
 * owner address via registerSponsoredSession / PasskeySignIn (#240). So when there's
 * no connected wagmi wallet AND this is a passkey install, keep an existing active
 * session intact — otherwise we'd clobber a perfectly good passkey session and show
 * "not connected." A normal wagmi user who disconnects still clears as before (their
 * wallet IS their identity), since this browser isn't marked as a passkey install.
 */
export function useSessionKeyWalletGuard() {
  const { address } = useAccount()
  const setActiveWallet = useSessionKeyStore(s => s.setActiveWallet)

  useEffect(() => {
    if (address) {
      setActiveWallet(address)
      return
    }
    // No wagmi wallet: only a passkey account preserves its self-activated
    // session. Check per-account (keyed by owner address) rather than a
    // browser-global flag — the self-activated session's owner is activeWallet.
    const { activeWallet, sessions } = useSessionKeyStore.getState()
    if (activeWallet && sessions[activeWallet] && isPasskeyAddress(activeWallet)) {
      return
    }
    setActiveWallet(null)
  }, [address, setActiveWallet])
}
