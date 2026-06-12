/**
 * useRootSigner — the single abstraction over a user's ROOT signer.
 *
 * Background (project_root_signer_passkey_wallet): the app has two signer
 * concepts that work app-wide:
 *   - "real wallet": the wagmi-connected EOA (MetaMask etc.) — root signer for
 *     Population A.
 *   - "session wallet": a delegated session key for routine actions — UNCHANGED
 *     by this hook, sits on top of whichever root signer the user has.
 *
 * Population B (sponsored EIP-7702 + WebAuthn passkey) has a PASSKEY WALLET that
 * REPLACES the real wallet as the root signer. This hook unifies the two so a
 * signing site calls one interface instead of branching on population. It does
 * NOT touch the session-wallet machinery.
 *
 * What each backend signs:
 *   - signMessage(message): EIP-191 personal_sign. Real → wagmi. Passkey → the
 *     secp256k1 ecdsaFallback key (recovery mode). NOTE: the server verifies
 *     these with ethers.verifyMessage, which only recovers a 65-byte ECDSA sig
 *     — it cannot verify a WebAuthn blob. So for Population B, signMessage works
 *     ONLY when the ecdsaFallback key is in memory (recovery mode). A passkey-
 *     only user (no recovery key) must use the passkey-native /api/auth/verify-
 *     passkey path instead (task #216); signMessage throws a clear error.
 *   - signDigest(digest): sign a precomputed 32-byte digest for an on-chain /
 *     sponsored ERC-1271 verification. Real → wagmi typed-data. Passkey →
 *     WebAuthn assertion (signWithPasskey) or the recovery key when present.
 *
 * There is no sendRootTx: Population B never broadcasts L1 txs directly — the
 * sponsor server submits on their behalf.
 */

import { useCallback, useMemo } from 'react'
import { hashMessage } from 'viem'
import { useSignMessage } from 'wagmi'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { signWithPasskey } from '~/services/identity/passkey'
import { signDigestForOnChain } from '~/services/identity/secp256k1Key'
import { getJSON } from '~/utils/safeStorage'
import { PASSKEY_CREDENTIAL_KEY } from '~/constants/passkeyStorage'

// ─── Types ──────────────────────────────────────────────────────────────────

export type RootSignerKind = 'real' | 'passkey' | 'none'

export interface RootSigner {
  /** Which backend is active for the current user. */
  kind: RootSignerKind
  /** The address that owns this account's on-chain identity (undefined if unknown). */
  address: `0x${string}` | undefined
  /**
   * Sign an EIP-191 personal_sign message. For Population B this uses the
   * secp256k1 ecdsaFallback key and therefore requires recovery mode; it throws
   * a user-facing error otherwise (passkey-only users use verify-passkey, #216).
   */
  signMessage: (message: string) => Promise<`0x${string}`>
  /**
   * Sign a precomputed 32-byte digest for sponsored / ERC-1271 verification.
   * Real wallet path is not wired here (Population A uses wagmi writeContract
   * directly); this is the passkey/recovery path.
   */
  signDigest: (digest: `0x${string}`) => Promise<`0x${string}`>
  /**
   * Ensure the signer is ready. Real → ensureWallet (may open connect modal).
   * Passkey → resolves if a credentialId or recovery key is available; rejects
   * with a clear message otherwise (so callers show "use your backup file"
   * instead of a wallet modal).
   */
  ensureReady: () => Promise<void>
  /** True when this signer can authorize sponsored entry points (Population B). */
  canSponsor: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

const NO_RECOVERY_KEY_MSG =
  'Signing this on a new device needs your backup file. Sign in with your backup file to continue.'
const NO_PASSKEY_MSG =
  'No passkey found on this device. Sign in with your backup file or use a device where your passkey is saved.'

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useRootSigner(): RootSigner {
  const { population, address } = useWalletPopulation()
  const recovery = useRecoveryContext()
  const ensureWallet = useEnsureWallet()
  const { signMessageAsync } = useSignMessage()
  const { startSigning, stopSigning } = useIdentitySigning()

  const isPasskey = population === 'B'
  const credentialId = getJSON<string | null>(PASSKEY_CREDENTIAL_KEY, null)

  const signMessage = useCallback(
    async (message: string): Promise<`0x${string}`> => {
      if (!isPasskey) {
        // Population A — wagmi personal_sign.
        return (await signMessageAsync({ message })) as `0x${string}`
      }
      // Population B — personal_sign must come from the secp256k1 ecdsaFallback
      // key (server recovers it via ethers.verifyMessage). Only available in
      // recovery mode. Passkey-only users go through verify-passkey instead.
      if (!recovery.privateKey) throw new Error(NO_RECOVERY_KEY_MSG)
      const digest = hashMessage(message) // EIP-191 prefixed hash
      return signDigestForOnChain(hexToBytes(recovery.privateKey), digest)
    },
    [isPasskey, recovery.privateKey, signMessageAsync],
  )

  const signDigest = useCallback(
    async (digest: `0x${string}`): Promise<`0x${string}`> => {
      // Recovery-mode key (secp256k1) takes priority — it produces a 65-byte
      // ECDSA sig that SigVerification validates on the ECDSA path (cheap, no
      // ERC-1271 gas cap). Otherwise fall back to the WebAuthn passkey blob.
      if (recovery.isInRecoveryMode && recovery.privateKey) {
        return signDigestForOnChain(hexToBytes(recovery.privateKey), digest)
      }
      if (!credentialId) throw new Error(NO_PASSKEY_MSG)
      startSigning('Please authenticate with your passkey')
      try {
        const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
        const result = await signWithPasskey({ credentialId, digest, rpId })
        return result.sig
      } finally {
        stopSigning()
      }
    },
    [recovery.isInRecoveryMode, recovery.privateKey, credentialId, startSigning, stopSigning],
  )

  const ensureReady = useCallback(async (): Promise<void> => {
    if (!isPasskey) {
      // Real wallet — defer to ensureWallet (opens connect modal if needed).
      // ensureWallet is awaitable and runs the action once the wallet is ready.
      await ensureWallet(null, async () => { /* readiness signal only */ })
      return
    }
    // Passkey — ready iff we can produce a signature on this device.
    if (!credentialId && !recovery.isInRecoveryMode) {
      throw new Error(NO_PASSKEY_MSG)
    }
  }, [isPasskey, ensureWallet, credentialId, recovery.isInRecoveryMode])

  return useMemo<RootSigner>(
    () => ({
      kind: population === 'B' ? 'passkey' : population === 'none' ? 'none' : 'real',
      address,
      signMessage,
      signDigest,
      ensureReady,
      canSponsor: isPasskey,
    }),
    [population, address, signMessage, signDigest, ensureReady, isPasskey],
  )
}
