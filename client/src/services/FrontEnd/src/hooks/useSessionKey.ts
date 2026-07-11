import { useCallback, useEffect } from 'react'
import { hashMessage } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSignMessage, useSwitchChain, useChainId, useAccount } from 'wagmi'
import { useReadContract } from 'wagmi'
import { getPublicClient } from '@wagmi/core'
import { useConnectModalBridge as useConnectModal } from '~/hooks/useConnectModalBridge'
import { baseSepolia } from 'wagmi/chains'
import { apiFetch } from '~/api/client'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { CAW_NAMES_L2_ADDRESS, SMART_EOA_ADDRESS } from '~/../../../abi/addresses'
import { CLIENT_ID } from '~/api/actions'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useRootSigner } from '~/hooks/useRootSigner'
import { encryptPrivateKey, getEncryptionSignMessage, setDecryptedKey } from '~/services/sessionKeyEncryption'
import { cawProfileLedgerAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/wagmiConfig'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { signAuthorizationTuple } from '~/services/identity/eip7702'
import { enrollPasskey, signWithPasskey, hexToBytes as passkeyHexToBytes } from '~/services/identity/passkey'
import { getPasskeyCredential, isPasskeyAddress } from '~/constants/passkeyStorage'
import { buildPrfSalt, markPrfCapable } from '~/services/identity/prf'
import { wrapSessionKeyWithPrf, unwrapSessionKeyWithPrf, saveSessionRoamMeta } from '~/services/identity/sessionPrf'
import { validatePrfBackupBlobShape } from '~/services/identity/backupBlob'
import { readContract } from '@wagmi/core'
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi } from '~/../../../abi/generated'

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
  const setActiveWallet = useSessionKeyStore(s => s.setActiveWallet)
  const activeToken = useActiveToken()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const rootSigner = useRootSigner()
  const recovery = useRecoveryContext()

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

      // ── L2 delegation self-heal — RECOVERY MODE ONLY ─────────────────────
      // Old accounts created before the L2-delegate leg (#261) have an
      // L1-delegated SmartEOA but NO L2 delegation. CawProfileLedger.registerSession
      // calls SmartEOA.isValidSignature on L2 to verify the passkey; with no code
      // on L2 that call fails → BadSig(). We CAN'T rebuild the L2 delegation from a
      // normal passkey session — it needs the secp256k1 ecdsaFallback key to sign a
      // 7702 auth tuple (a passkey can't), and that key only lives in memory in
      // RECOVERY MODE. So the self-heal runs ONLY when recovery.privateKey is
      // present. A normal session NEVER probes L2 or demands a backup file (avoids
      // a false "go find your backup" when the real failure is something else); if
      // such an account is genuinely undelegated, registration fails with the
      // normal error and the user can re-onboard. (Recovery mode already involves a
      // deliberate backup-file flow, so the extra passkey prompt below is in-context.)
      const ownerAddr = (activeToken?.owner ?? rootSigner.address) as `0x${string}` | undefined
      if (recovery.privateKey && ownerAddr) {
        const l2Client = getPublicClient(wagmiConfig, { chainId: baseSepolia.id })
        const currentCode = l2Client ? await l2Client.getCode({ address: ownerAddr }) : undefined
        const wantPrefix = (`0xef0100${SMART_EOA_ADDRESS.slice(2).toLowerCase()}`)
        const isDelegated = typeof currentCode === 'string' &&
          currentCode.toLowerCase() === wantPrefix

        if (!isDelegated) {
          onProgress?.('Setting up your account on L2…')

          // ecdsaFallbackAddr = the secp256k1 key's address (= recovery.address).
          const ecdsaFallbackAddr = recovery.address!

          // The L2 SmartEOA.initialize needs a passkey pubkey, but the existing
          // passkey's P-256 coordinates aren't stored locally (only the
          // credentialId is) and recovery context only carries the secp256k1 key.
          // The only client-side way to obtain X/Y is a WebAuthn ceremony, so we
          // enroll here. On platforms with a synced passkey (iCloud / Google PM)
          // this surfaces the existing key; otherwise a fresh credential is
          // enrolled for L2 use. Acceptable: the user is already in a deliberate
          // recovery flow. The secp256k1 ecdsaFallback (the recovery key) remains
          // the anchor that the session-register ERC-1271 path validates against.
          const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
          const passkey = await enrollPasskey({
            rpId,
            userName: activeToken?.username ?? ecdsaFallbackAddr,
            userDisplayName: activeToken?.username ?? ecdsaFallbackAddr,
          })

          // Get the L2 EOA nonce — must not hardcode 0; old accounts may have
          // transacted on L2 (e.g. a previous delegate-l2 that didn't propagate).
          const l2Nonce = l2Client
            ? await l2Client.getTransactionCount({ address: ownerAddr })
            : 0

          // Build the L2 EIP-7702 auth tuple signed with the secp256k1 key.
          const keyBytes = new Uint8Array(
            recovery.privateKey.slice(2).match(/.{2}/g)!.map(h => parseInt(h, 16))
          )
          const authResult = await signAuthorizationTuple({
            privateKey: keyBytes,
            chainId: baseSepolia.id,
            contractAddress: SMART_EOA_ADDRESS as `0x${string}`,
            nonce: BigInt(l2Nonce),
          })

          // POST to sponsor — same body shape as Onboarding.tsx:478.
          await apiFetch('/api/sponsor/delegate-l2', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              passkeyPubkeyX: passkey.pubkeyX,
              passkeyPubkeyY: passkey.pubkeyY,
              ecdsaFallbackAddr,
              authTupleNonce: String(l2Nonce),
              authTupleSignature: {
                yParity: authResult.signedAuthorization.yParity,
                r: authResult.signedAuthorization.r,
                s: authResult.signedAuthorization.s,
              },
            }),
          })

          // Poll L2 getCode until delegation lands (max ~30 s, 10 × 3 s).
          if (l2Client) {
            for (let i = 0; i < 10; i++) {
              await new Promise(r => setTimeout(r, 3000))
              const code = await l2Client.getCode({ address: ownerAddr })
              if (typeof code === 'string' && code.toLowerCase() === wantPrefix) break
            }
          }
        }
      }
      // ── end L2 delegation self-heal ───────────────────────────────────────
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

    // For Population B (passkey / WebAuthn blob), include the claimed signer so
    // the server can verify ERC-1271 against the correct SmartEOA address rather
    // than attempting ethers.verifyMessage (ECDSA-only) on a non-ECDSA blob.
    // Pop-A sends a 65-byte ECDSA sig; the server ignores `signer` and recovers
    // the address via verifyMessage as before. Always include it for clarity.
    const signerAddress = isPasskey ? (activeToken?.owner ?? rootSigner.address) : undefined

    const result = await apiFetch<{ requestId: string; status: string }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ message, signature, ...(signerAddress ? { signer: signerAddress } : {}) }),
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

    // The owner address the session must be STORED + KEYED under. For Pop-A this
    // is the connected wagmi wallet; for Pop-B (passkey, no wagmi) there is NO
    // connectedAddress, so it's the active profile's owner — the same address the
    // session was signed for (signerAddress above) and registered under on-chain.
    // Using connectedAddress here for Pop-B stored the session under `undefined`,
    // so getActiveSessionForAddress(activeToken.owner) missed and the UI stayed
    // "not connected" despite a confirmed on-chain registration. Mirrors
    // registerSponsoredSession (the onboarding path), which already keys by owner.
    const effectiveOwner = (connectedAddress ?? activeToken?.owner)?.toLowerCase()

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
        ownerAddress: effectiveOwner,
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
        ownerAddress: effectiveOwner,
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
      })
    }

    // Pop-B has no wagmi address, so the wagmi-keyed setActiveWallet effect never
    // fires for them — set it explicitly so sessionForWallet()/getActiveSession()
    // resolve the session we just stored. (Mirrors registerSponsoredSession, #240.)
    if (effectiveOwner) setActiveWallet(effectiveOwner)

    // ROAMING (Bug E): for passkey (Pop-B) users, PRF-wrap the session key + upload
    // it so this session can be restored on another device with a Face ID (no new
    // on-chain registration). Best-effort + fire-and-forget — a failure just means
    // this device's session doesn't roam (the user can re-create QS elsewhere).
    // Pop-A (wallet) users already roam via their wallet, so skip them.
    if (rootSigner.kind === 'passkey' && effectiveOwner) {
      void (async () => {
        try {
          const credentialId = getPasskeyCredential(activeToken?.tokenId)
          if (!credentialId) return
          const rpId = typeof window !== 'undefined' ? window.location.hostname : ''
          const salt = await buildPrfSalt(effectiveOwner)
          const { challenge } = await apiFetch<{ challenge: `0x${string}` }>(
            '/api/wallet/blob/challenge',
            { method: 'POST', body: JSON.stringify({ address: effectiveOwner }) },
          )
          const sig = await signWithPasskey({ credentialId, digest: challenge, rpId, prfSalt: salt })
          markPrfCapable(credentialId, !!sig.prfSecret)
          if (!sig.prfSecret) return
          const keyBytes = passkeyHexToBytes(privateKey.slice(2))
          const sessionPrfBlob = await wrapSessionKeyWithPrf(keyBytes, sig.prfSecret, sessionAccount.address)
          keyBytes.fill(0)
          await apiFetch('/api/wallet/blob/prf', {
            method: 'POST',
            body: JSON.stringify({
              address: effectiveOwner,
              sessionPrfBlob: JSON.stringify(sessionPrfBlob),
              challenge,
              signature: sig.sig,
            }),
          })
          // Non-secret metadata for same-device rebuilds; the new device re-reads
          // the authoritative expiry/scope/limit/spent from on-chain at restore.
          saveSessionRoamMeta(effectiveOwner, {
            sessionAddress: sessionAccount.address,
            ownerAddress: effectiveOwner,
            expiry,
            scopeBitmap: DEFAULT_SCOPE,
            spendLimit: spendLimit.toString(),
            tipCeiling: tipCeiling.toString(),
          })
          console.log('[QuickSign] session PRF-wrapped for roaming')
        } catch (e) {
          console.warn('[QuickSign] session roam-wrap skipped (non-fatal):', e)
        }
      })()
    }

    return { address: sessionAccount.address, expiry }
  }, [isConnected, connectedAddress, openConnectModal, chainId, signMessageAsync, switchChainAsync, setSession, setActiveWallet, activeToken, cawPrice, rootSigner, recovery])
}

/**
 * ROAMING (Bug E): restore a Quick Sign session on a NEW device via the passkey.
 *
 * When a passkey (Pop-B) user has no local session but a PRF-wrapped one exists
 * server-side (uploaded at create-time on another device), one Face ID unwraps
 * the SAME session key — whose on-chain registration is still valid — so QS works
 * instantly with NO new registration tx.
 *
 * Flow: one passkey ceremony gets BOTH the blob-retrieval assertion AND the PRF
 * secret → unwrap sessionPrfBlob → derive the session address → read the
 * AUTHORITATIVE on-chain session (expiry/scope/spendLimit) + sessionSpent, seed
 * the local `spent` counter from chain (so a device can't overspend the shared
 * limit) → store. If the on-chain session is expired / not-found, return null
 * (caller silently falls back to create-a-new-session).
 *
 * Returns the restored SessionKeyEntry address on success, or null.
 */
export function useRestoreRoamedSession() {
  const setSession = useSessionKeyStore(s => s.setSession)
  const setActiveWallet = useSessionKeyStore(s => s.setActiveWallet)
  const rootSigner = useRootSigner()
  const activeToken = useActiveToken()

  // `presetPrfSecret`: when the caller already captured the PRF secret in a
  // PRECEDING passkey touch (e.g. the sign-in ceremony), pass it here so QS roam
  // restore reuses it — NO extra Face ID. The blob is then fetched via the
  // SESSION-AUTHED retrieve (the user is signed in). When absent, falls back to a
  // self-contained passkey-gated ceremony (own Face ID).
  return useCallback(async (ownerAddress: string, presetPrfSecret?: Uint8Array, tokenIdHint?: number): Promise<`0x${string}` | null> => {
    const owner = ownerAddress.toLowerCase()
    // [QuickSign:roam] tagged diagnostics on EVERY exit — the roam restore used
    // to no-op silently, so a "didn't bring Quick Sign" report had nothing to go
    // on. Each branch logs WHY it stopped.
    //
    // Passkey gate: do NOT rely on rootSigner.kind — it reflects the GLOBALLY
    // active population, which during passkey sign-in is still whatever wagmi
    // wallet happens to be connected (a stray EOA → 'real'), because the roamed
    // account isn't the active token yet. Gate instead on whether THIS OWNER is a
    // known passkey address (persisted at sign-in). That's the account we're
    // actually restoring for.
    const ownerIsPasskey = rootSigner.kind === 'passkey' || isPasskeyAddress(owner)
    if (!ownerIsPasskey) {
      console.log('[QuickSign:roam] skip: owner is not a passkey account (rootSigner.kind', rootSigner.kind, ', isPasskeyAddress false) owner', owner)
      return null
    }
    // Credential is only needed for the FALLBACK (own-ceremony) path. When a
    // presetPrfSecret is supplied (the sign-in piggyback), the fast path needs no
    // passkey touch, so a missing credential must NOT abort. Prefer the explicit
    // tokenIdHint (the account being signed into) over activeToken — during
    // sign-in the active token hasn't switched to the roamed account yet.
    const credentialId = getPasskeyCredential(tokenIdHint ?? activeToken?.tokenId)
    if (!credentialId && !presetPrfSecret) {
      console.log('[QuickSign:roam] skip: no passkey credentialId (tokenId', tokenIdHint ?? activeToken?.tokenId, ') and no preset PRF secret — cannot unwrap. owner', owner)
      return null
    }
    console.log('[QuickSign:roam] start: owner', owner, 'presetPrfSecret?', !!presetPrfSecret, 'tokenIdHint', tokenIdHint)

    try {
      const rpId = typeof window !== 'undefined' ? window.location.hostname : ''

      // Fast path: reuse a pre-captured PRF secret + a session-authed blob read
      // (no passkey challenge/signature needed — the user is authenticated).
      let prfSecret: Uint8Array | undefined = presetPrfSecret
      let sessionPrfBlob: string | null = null
      if (prfSecret) {
        const r = await apiFetch<{ sessionPrfBlob: string | null }>(
          '/api/wallet/blob/retrieve',
          { method: 'POST', body: JSON.stringify({ address: owner }) },
        )
        sessionPrfBlob = r.sessionPrfBlob
        console.log('[QuickSign:roam] session-authed retrieve → sessionPrfBlob present?', !!sessionPrfBlob)
      } else {
        // Fallback: own ceremony — one challenge + one passkey touch that gates
        // blob retrieval AND yields the PRF secret. Reaching here means
        // !presetPrfSecret, so the earlier guard guarantees credentialId is set.
        if (!credentialId) {
          console.log('[QuickSign:roam] skip: fallback ceremony needs a credentialId but none found for owner', owner)
          return null
        }
        const salt = await buildPrfSalt(owner)
        const { challenge } = await apiFetch<{ challenge: `0x${string}` }>(
          '/api/wallet/blob/challenge',
          { method: 'POST', body: JSON.stringify({ address: owner }) },
        )
        const sig = await signWithPasskey({ credentialId, digest: challenge, rpId, prfSalt: salt })
        markPrfCapable(credentialId, !!sig.prfSecret)
        if (!sig.prfSecret) {
          console.log('[QuickSign:roam] skip: authenticator returned no PRF secret (ceremony path) — cannot unwrap')
          return null
        }
        prfSecret = sig.prfSecret
        const r = await apiFetch<{ sessionPrfBlob: string | null }>(
          '/api/wallet/blob/retrieve',
          { method: 'POST', body: JSON.stringify({ address: owner, challenge, signature: sig.sig }) },
        )
        sessionPrfBlob = r.sessionPrfBlob
        console.log('[QuickSign:roam] ceremony retrieve → sessionPrfBlob present?', !!sessionPrfBlob)
      }
      if (!sessionPrfBlob) {
        console.log('[QuickSign:roam] no-op: server has NO sessionPrfBlob for', owner, '(source device never wrapped this session) → user must Activate Quick Sign')
        return null
      }

      const parsed = JSON.parse(sessionPrfBlob)
      if (!validatePrfBackupBlobShape(parsed)) {
        console.warn('[QuickSign:roam] abort: sessionPrfBlob failed shape validation (corrupt?)')
        return null
      }

      const keyBytes = await unwrapSessionKeyWithPrf(parsed, prfSecret)
      let sessionPrivKey: `0x${string}`
      let sessionAddr: `0x${string}`
      try {
        let hex = '0x'
        for (let i = 0; i < keyBytes.length; i++) hex += keyBytes[i].toString(16).padStart(2, '0')
        sessionPrivKey = hex as `0x${string}`
        sessionAddr = privateKeyToAccount(sessionPrivKey).address
      } finally {
        keyBytes.fill(0)
      }

      // AUTHORITATIVE on-chain read: is this session still registered + unexpired,
      // and how much has been spent across ALL devices? The generated ABI only
      // exposes sessionSpent, so the sessions() struct getter is provided inline
      // (shape matches CawActions.sessions used server-side: {expiry, scopeBitmap,
      // spendLimit, perActionTipRate}).
      const sessionsAbiFragment = [{
        type: 'function', stateMutability: 'view', name: 'sessions',
        inputs: [{ name: 'owner', type: 'address' }, { name: 'sessionKey', type: 'address' }],
        outputs: [
          { name: 'expiry', type: 'uint256' },
          { name: 'scopeBitmap', type: 'uint8' },
          { name: 'spendLimit', type: 'uint256' },
          { name: 'perActionTipRate', type: 'uint256' },
        ],
      }] as const
      const [sessionRaw, spent] = await Promise.all([
        readContract(wagmiConfig, {
          address: CAW_ACTIONS_ADDRESS, abi: sessionsAbiFragment, chainId: baseSepolia.id,
          functionName: 'sessions', args: [owner as `0x${string}`, sessionAddr],
        }),
        readContract(wagmiConfig, {
          address: CAW_ACTIONS_ADDRESS, abi: cawActionsAbi, chainId: baseSepolia.id,
          functionName: 'sessionSpent', args: [owner as `0x${string}`, sessionAddr],
        }) as Promise<bigint>,
      ])
      const session = {
        expiry: (sessionRaw as readonly [bigint, number, bigint, bigint])[0],
        scopeBitmap: (sessionRaw as readonly [bigint, number, bigint, bigint])[1],
        spendLimit: (sessionRaw as readonly [bigint, number, bigint, bigint])[2],
        perActionTipRate: (sessionRaw as readonly [bigint, number, bigint, bigint])[3],
      }
      const expiry = Number(session.expiry)
      const nowSec = Math.floor(Date.now() / 1000)
      // Expired / not-registered → caller silently creates a new session.
      if (expiry === 0 || expiry <= nowSec) {
        console.log('[QuickSign:roam] no-op: on-chain session expired/not-registered (sessionAddr', sessionAddr, 'expiry', expiry, 'now', nowSec, ') → user must Activate Quick Sign')
        return null
      }
      console.log('[QuickSign:roam] on-chain session valid (sessionAddr', sessionAddr, 'expiry', expiry, ') — restoring')

      // Seed `spent` from on-chain sessionSpent (Q1) so this device sees what
      // other devices already spent and can't overspend the shared on-chain limit.
      setSession({
        privateKey: sessionPrivKey,
        address: sessionAddr,
        ownerAddress: owner,
        expiry,
        scopeBitmap: Number(session.scopeBitmap),
        spendLimit: session.spendLimit.toString(),
        spent: spent.toString(),
        // `spent` was just read from chain — stamp it so the submit-time
        // fast-path trusts it (within TTL) instead of immediately re-reading.
        spentSyncedAt: Date.now(),
        tipCeiling: session.perActionTipRate.toString(),
      })
      setActiveWallet(owner)
      saveSessionRoamMeta(owner, {
        sessionAddress: sessionAddr, ownerAddress: owner, expiry,
        scopeBitmap: Number(session.scopeBitmap),
        spendLimit: session.spendLimit.toString(),
        tipCeiling: session.perActionTipRate.toString(),
      })
      console.log('[QuickSign] roamed session restored from PRF blob')
      return sessionAddr
    } catch (e) {
      console.warn('[QuickSign] roamed session restore failed (will create new):', e)
      return null
    }
  }, [rootSigner, activeToken, setSession, setActiveWallet])
}

/**
 * WRAP-ON-ACTIVATION (roaming for PRE-EXISTING sessions): the wrap-on-create path
 * only PRF-wraps a session at the moment it's created. A session created before
 * that code existed — or on a device that just restored one — has NO sessionPrfBlob
 * on the server, so it can't roam. This opportunistically wraps the CURRENT local
 * session and uploads it IFF the server doesn't already have one.
 *
 * Reuses a PRF secret captured in a PRECEDING passkey touch (e.g. sign-in) + the
 * session-authed first-write, so it costs NO extra Face ID. Returns true if it
 * wrapped+uploaded, false if there was nothing to do / it failed (non-fatal).
 */
export function useWrapSessionForRoaming() {
  const activeToken = useActiveToken()
  const rootSigner = useRootSigner()
  return useCallback(async (ownerAddress: string, presetPrfSecret?: Uint8Array): Promise<boolean> => {
    if (rootSigner.kind !== 'passkey' || !presetPrfSecret) return false
    const owner = ownerAddress.toLowerCase()
    try {
      // Only wrap if the server DOESN'T already have a session blob (session-authed
      // read — no prompt). Avoids re-uploading every sign-in.
      const { sessionPrfBlob } = await apiFetch<{ sessionPrfBlob: string | null }>(
        '/api/wallet/blob/retrieve',
        { method: 'POST', body: JSON.stringify({ address: owner }) },
      )
      if (sessionPrfBlob) return false // already roamable

      const store = useSessionKeyStore.getState()
      const session = store.getSessionForAddress(owner)
      // Need the decrypted private key present + a real registered session address.
      if (!session?.privateKey || session.privateKey.length < 4 || session.privateKey === '0xencrypted') return false
      if (!session.address) return false

      const keyBytes = passkeyHexToBytes(session.privateKey.slice(2))
      const wrapped = await wrapSessionKeyWithPrf(keyBytes, presetPrfSecret, session.address)
      keyBytes.fill(0)
      // Session-authed first-write (no challenge/signature — the user is signed in).
      await apiFetch('/api/wallet/blob/prf', {
        method: 'POST',
        body: JSON.stringify({ address: owner, sessionPrfBlob: JSON.stringify(wrapped) }),
      })
      console.log('[QuickSign] existing session wrapped for roaming (no prompt)')
      return true
    } catch (e) {
      console.warn('[QuickSign] wrap-on-activation skipped (non-fatal):', e)
      return false
    }
  }, [rootSigner, activeToken])
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
  // Invoked once, after the session is registered on-chain AND persisted locally,
  // with the freshly-created session's private key + address and its non-secret
  // metadata. The onboarding caller uses this to PRF-wrap the session for roaming
  // (reusing the mint-permit PRF secret — no extra prompt) so the account's Quick
  // Sign works on a new browser. Non-fatal: awaited but its rejection is swallowed.
  onSessionCreated?: (
    sessionPrivateKeyHex: `0x${string}`,
    sessionAddress: `0x${string}`,
    meta: { expiry: number; scopeBitmap: number; spendLimit: string; tipCeiling: string },
  ) => Promise<void> | void
}): Promise<{ address: `0x${string}`; expiry: number }> {
  const {
    signMessage,
    ownerAddress,
    spendLimit = DEFAULT_SPEND_LIMIT,
    durationSeconds = DEFAULT_SESSION_DURATION,
    tipCeiling = 0n,
    cawPrice = 0,
    onProgress,
    onSessionCreated,
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

  // Hand the just-created session to the caller so it can PRF-wrap it for roaming
  // (onboarding does this with the mint-permit PRF secret → no extra prompt).
  // Non-fatal: the session already works on this device regardless.
  if (onSessionCreated) {
    try {
      await onSessionCreated(privateKey, sessionAccount.address, {
        expiry,
        scopeBitmap: DEFAULT_SCOPE,
        spendLimit: spendLimit.toString(),
        tipCeiling: tipCeiling.toString(),
      })
    } catch (e) {
      console.warn('[QuickSign] onSessionCreated (roam-wrap) failed (non-fatal):', e)
    }
  }

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
 * no connected wagmi wallet AND there is a stored session under activeWallet, we keep
 * it unconditionally. A Pop-A user's session is keyed to their wagmi address and is
 * only ever active while that wallet is connected; explicit disconnect flows in
 * AccountSettings call clearSession() directly, so a stored-session-with-no-wallet
 * is necessarily a self-activated passkey (Pop-B) session. The old isPasskeyAddress()
 * marker gate was fragile: Safari ITP can evict the marker independently, and on cold
 * start the async re-mark in App.tsx resolves hundreds of ms after this synchronous
 * effect fires — causing spurious clears and "gone next day" / "after deploy" reports.
 */
export function useSessionKeyWalletGuard() {
  const { address } = useAccount()
  const setActiveWallet = useSessionKeyStore(s => s.setActiveWallet)

  useEffect(() => {
    if (address) {
      setActiveWallet(address)
      return
    }
    // No wagmi wallet. If there is a stored session under the current activeWallet,
    // keep it — a session present with no connected wagmi address can only belong to
    // a passkey (Pop-B) user whose self-activated wallet is their identity. Pop-A
    // explicit disconnects go through AccountSettings which calls clearSession()
    // directly; they never rely on this guard to remove session data.
    const { activeWallet, sessions } = useSessionKeyStore.getState()
    if (activeWallet && sessions[activeWallet]) {
      return
    }
    setActiveWallet(null)
  }, [address, setActiveWallet])
}
