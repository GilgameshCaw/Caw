/**
 * bootstrap.ts
 *
 * Orchestrates the full onboarding flow for a new Population B user
 * (phone-first, no existing wallet).
 *
 * Steps performed by this module:
 *   1. Generate a fresh secp256k1 keypair (the user's primary identity key).
 *   2. Encrypt the private key under the vault password → BackupBlob.
 *   3. Read chainId and EOA tx nonce from the connected RPC provider.
 *   4. Sign an EIP-7702 authorization tuple (delegates the EOA to SmartEOA).
 *   5. Hand the assembled params to the sponsor API, which submits a single
 *      type-0x04 tx bundling 7702 delegation + SmartEOA.initialize +
 *      CawProfileMinter.mintAndDepositSponsored.
 *   6. Return the tx hash and the backup blob to the caller.
 *
 * Out of scope (handled by other steps):
 *   - Passkey (P-256) keypair generation and WebAuthn assertions — Step 4d.
 *     The `passkeyPubkeyX` / `passkeyPubkeyY` and `permitSig` (a WebAuthn
 *     assertion over the sponsor permit digest) are passed in as parameters.
 *     This keeps the secp256k1 identity layer cleanly separable from the
 *     passkey layer.
 *   - Sponsor API HTTP transport — Step 4d wires the HTTP client. The
 *     `sponsorApi` parameter abstracts away the transport; any client that
 *     implements `SponsorApiClient` works.
 *   - Cloud backup upload — caller decides when to call `downloadBackupBlob`
 *     or upload to server. This module returns the blob; the UX layer handles
 *     the storage action.
 *
 * Design constraint: this file must NOT import anything from Step 4d
 * (passkey) or SponsorService — the boundary is enforced by the parameter
 * shape. See plan-smart-eoa-passkey-sponsorship.md §4 for the full flow.
 */

import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex } from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import { generateSecp256k1Keypair } from './secp256k1Key'
import { encryptBackupBlob, encryptBackupBlobWithKey, type BackupBlob } from './backupBlob'
import { signAuthorizationTuple, type SignedAuthorizationTuple } from './eip7702'
import { buildMintDepositPermitDigest } from './eip712Permits'
import { buildPrfSalt, prfSecretToAesKey, markPrfCapable } from './prf'
import { signWithPasskey } from './passkey'
import { apiFetch } from '~/api/client'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Parameters the sponsor server needs to assemble and submit the bootstrap tx.
 * Shape mirrors POST /api/sponsor/bootstrap (see plan §5).
 *
 * The `permitSig` is a WebAuthn assertion (P-256, variable-length ABI blob)
 * over the `mintAndDepositSponsored` EIP-712 permit digest. It is produced
 * by the passkey signer (Step 4d) and passed in by the caller. SmartEOA's
 * isValidSignature dispatches on blob length (≥224 bytes for WebAuthn,
 * 65 bytes for secp256k1 ECDSA).
 */
export type BootstrapParams = {
  /**
   * Gate: provide EXACTLY ONE of `code` or `xQualifiedToken`. Threaded to
   * /api/sponsor/bootstrap, which validates the code against the SponsorCode
   * table, OR consumes the X-qualified token from the open X-signup flow.
   */
  code?: string
  /** X-qualified token from /api/verify/x/signup-callback (open signup gate). */
  xQualifiedToken?: string
  /** P-256 public key X coordinate (32 bytes, hex). */
  passkeyPubkeyX: `0x${string}`
  /** P-256 public key Y coordinate (32 bytes, hex). */
  passkeyPubkeyY: `0x${string}`
  /** Ethereum address of the user's secp256k1 EOA (= ecdsaFallback in SmartEOA). */
  ecdsaFallbackAddr: `0x${string}`
  /** Username to register. Server pre-checks availability before submitting tx. */
  username: string
  /** CAW token amount to deposit (in wei-equivalent units). */
  depositAmountCAW: bigint
  /** CAW Network ID (see CawNetworkManager). */
  networkId: number
  /** LayerZero destination chain ID for the L2 authentication message. */
  lzDestId: number
  /** Signed EIP-7702 auth tuple. */
  authTupleSignature: SignedAuthorizationTuple
  /**
   * WebAuthn assertion (ABI-encoded) over the mintAndDepositSponsored
   * EIP-712 permit digest. Produced by the passkey signer (Step 4d).
   * Passed to SmartEOA.isValidSignature by the sponsor server during
   * ERC-1271 permit verification.
   */
  permitSig: `0x${string}`
  /**
   * Raw clientDataJSON bytes from the WebAuthn assertion. Required by the
   * sponsor server to reconstruct the WebAuthn challenge and verify the
   * assertion independently.
   */
  clientDataJSON: string
  /**
   * Raw authenticatorData bytes (hex) from the WebAuthn assertion.
   */
  authenticatorData: `0x${string}`
}

/**
 * Abstract sponsor API surface. The real HTTP client (Step 4d) implements
 * this interface; tests can stub it without network access.
 */
export type SponsorApiClient = {
  sponsorBootstrap: (params: BootstrapParams) => Promise<{ txHash: string }>
}

/**
 * Callback type for the passkey permit signer (Step 4d).
 *
 * The signer is given the EIP-712 permit digest that the SmartEOA will
 * verify via isValidSignature. It must produce a WebAuthn assertion over
 * that digest, encoded as an ABI blob that SmartEOA can decode.
 *
 * Returns the three fields that bootstrap.ts includes in BootstrapParams.
 */
export type PasskeyPermitSigner = (
  permitDigest: `0x${string}`,
  /** When present, the ceremony ALSO requests the WebAuthn PRF secret with this
   *  salt so onboarding can enrol the DM-PRF blob WITHOUT a second Face ID (the
   *  same passkey touch signs the mint permit AND yields the PRF secret). */
  prfSalt?: Uint8Array,
) => Promise<{
  permitSig: `0x${string}`
  clientDataJSON: string
  authenticatorData: `0x${string}`
  /** The 32-byte PRF secret, present only when `prfSalt` was passed AND the
   *  authenticator supports PRF. Undefined otherwise (caller falls back to a
   *  separate enrol ceremony). */
  prfSecret?: Uint8Array
}>

/**
 * RPC provider surface needed by the bootstrap flow.
 *
 * Accepts either a viem PublicClient or any object that implements these
 * two methods, so the caller can pass their wagmi client or a lightweight
 * stub in tests.
 */
export type BootstrapRpcProvider = {
  /** Returns the chain ID of the connected network. Never hardcoded. */
  getChainId: () => Promise<number>
  /** Returns the current transaction count (nonce) for an address. */
  getTransactionCount: (params: { address: `0x${string}` }) => Promise<number>
}

/** Full result returned to the onboarding flow. */
export type BootstrapResult = {
  /** Transaction hash of the single type-0x04 bootstrap tx. */
  txHash: string
  /**
   * Encrypted backup blob containing the secp256k1 private key.
   * The caller must persist this — the private key is NOT stored anywhere
   * else and cannot be recovered without this blob + the vault password.
   */
  backupBlob: BackupBlob
  /** Ethereum address of the generated secp256k1 keypair (= ecdsaFallback in SmartEOA). */
  ecdsaAddress: `0x${string}`
  /** The minted username — authoritative source for the post-mint /welcome nav
   *  (the onboarding callback's closed-over `state.username` is stale/empty). */
  username: string
  /**
   * The CAW amount actually deposited at bootstrap (raw token units, what was
   * SIGNED + sent to the sponsor — the receipt confirmed it). Returned so the
   * post-mint optimistic-credit hint is written from THIS authoritative value,
   * not a re-derived `derivedDepositAmount` that can read 0 once `giftInfo` has
   * gone stale in a later render. We know a gifted deposit landed; act on it
   * optimistically and reconcile against chain in the background.
   */
  depositAmountCAW: bigint
  /**
   * One-shot signer for the post-mint /api/auth/verify sign-in. The minted
   * profile is owned by `ecdsaAddress`, and this closure signs a personal_sign
   * message with that key so the onboarding can establish a session WITHOUT
   * persisting the raw private key anywhere. The key lives only inside this
   * closure (already in memory for the bootstrap) — let it GC after use.
   */
  signVerifyMessage: (message: string) => Promise<`0x${string}`>
  /**
   * Enrol the PRF blob AFTER the mint (Bug D). Closes over the recovery key (still
   * in memory here) and, when called, wraps it under the passkey's PRF secret and
   * uploads it — passkey-gated. Must be invoked only AFTER the profile is indexed
   * + the SmartEOA delegation is live (post-mint sign-in), because /blob/prf's
   * gate runs SmartEOA.isValidSignature on-chain, which can't succeed pre-mint.
   * This makes the user's FIRST cold device Face-ID-only for DMs. Non-fatal: a
   * failure just means the first cold device falls back to the password (which
   * then enrols PRF as before). Takes the enrolled passkey credentialId (known to
   * the caller at mint-complete). Returns true iff a PRF blob was uploaded.
   */
  enrollPrfAfterMint: (credentialId: string) => Promise<boolean>
  /**
   * L2 delegation payload (present only when bootstrap() was called with
   * l2ChainId). The caller POSTs this to /api/sponsor/delegate-l2 to delegate the
   * user's EOA → SmartEOA on L2 + enroll the passkey, so the passkey root signer
   * can act on L2 without a Quick Sign session. Signed here while the secp256k1
   * key was in scope; the raw key is NOT included.
   */
  l2Delegation?: {
    passkeyPubkeyX: `0x${string}`
    passkeyPubkeyY: `0x${string}`
    ecdsaFallbackAddr: `0x${string}`
    authTupleNonce: string
    authTupleSignature: { yParity: number; r: `0x${string}`; s: `0x${string}` }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Full onboarding flow for a new Population B user.
 *
 * @param opts.vaultPassword      The user's chosen vault password. Must pass
 *                                 the UI's entropy gate before this is called.
 * @param opts.username            Desired username. Server validates availability.
 * @param opts.depositAmountCAW    Amount to deposit (raw token units).
 * @param opts.networkId           CAW Network ID.
 * @param opts.lzDestId            LayerZero destination chain ID.
 * @param opts.passkeyPubkeyX      P-256 public key X (Step 4d output).
 * @param opts.passkeyPubkeyY      P-256 public key Y (Step 4d output).
 * @param opts.smartEoaAddress     Deployed SmartEOA implementation address.
 *                                 Read from the network config — NOT user input.
 * @param opts.rpcProvider         Connected RPC provider for chainId + nonce reads.
 * @param opts.passkeySigner       Callback that produces a WebAuthn assertion over
 *                                 a given EIP-712 digest (Step 4d).
 * @param opts.sponsorApi          Sponsor API client for submitting the bootstrap tx.
 * @param opts.permitDigest        The EIP-712 permit digest that the passkey signer
 *                                 must assert over. Computed by the sponsor server
 *                                 or derived off-chain from the known struct type.
 *                                 Passed in so this module doesn't depend on the
 *                                 sponsor server's internal digest derivation logic.
 */
export async function bootstrapNewUser(opts: {
  /** Invite code. Provide this OR xQualifiedToken (the open X-signup gate). */
  code?: string
  /** X-qualified token from /api/verify/x/signup-callback. Alternative to code. */
  xQualifiedToken?: string
  vaultPassword: string
  username: string
  depositAmountCAW: bigint
  networkId: number
  lzDestId: number
  passkeyPubkeyX: `0x${string}`
  passkeyPubkeyY: `0x${string}`
  smartEoaAddress: `0x${string}`
  rpcProvider: BootstrapRpcProvider
  passkeySigner: PasskeyPermitSigner
  /**
   * L2 chain ID (e.g. Base Sepolia 84532). When provided, bootstrap ALSO signs a
   * second EIP-7702 auth tuple committed to this chainId (with the L2 EOA nonce,
   * which is 0 on a fresh keypair) and returns it as `l2Delegation`. The caller
   * POSTs it to /api/sponsor/delegate-l2 so the user's EOA is delegated to
   * SmartEOA on L2 too — required for the passkey root signer to do on-chain
   * actions on L2 (CawActions ERC-1271-verifies on L2). See
   * docs/POPB_L2_DELEGATION_SCOPE.md. Omitted → no L2 tuple (back-compat).
   */
  l2ChainId?: number
  sponsorApi: SponsorApiClient
  /**
   * CawProfileMinter address — the EIP-712 `verifyingContract`. Needed here
   * (not a pre-built digest) because the digest binds `recipient` to the
   * user's delegated EOA, which is the freshly-generated keypair address and
   * therefore unknown until Step 1 below.
   */
  minterAddress: `0x${string}`
  /** Permit nonce — must equal SmartEOA.nonceOf(Minter, ACTION_MINT_DEPOSIT) at submit. */
  permitNonce: bigint
  /** LZ ZRO token payment for the cross-chain deposit (0 on testnet). */
  lzTokenAmount: bigint
  /**
   * Sponsor-Repay (Phase 2) policy, defaulted to a plain gift. These ride the
   * signed permit struct and the on-chain call; they MUST match what the
   * sponsor server passes to mintAndDepositSponsored or the digest won't match.
   */
  kycLevel?: number
  sponsorTokenId?: number
  repayAmount?: bigint
  /**
   * DURABILITY HOOK — fires AFTER the encrypted backup blob is created but BEFORE
   * the irreversible mint. The caller uses it to upload the ciphertext blob to the
   * server (and enrol a PRF blob) so that if the mint response is LOST (e.g. a 502
   * during a deploy), the profile is still RECOVERABLE — the recovery key survives
   * in the pre-uploaded blob, restorable via /recovery. Without this, a lost
   * response orphans the on-chain profile (its fresh-random key existed only in
   * memory and is gone forever). Awaited; a throw here ABORTS before the mint (so
   * we never mint a profile we couldn't first make recoverable). Non-fatal soft
   * failures should be swallowed by the callback itself.
   */
  persistBeforeMint?: (info: {
    ownerAddress: `0x${string}`
    backupBlob: BackupBlob
    recoveryPrivateKey: Uint8Array
  }) => Promise<void>
}): Promise<BootstrapResult> {
  const {
    code,
    xQualifiedToken,
    vaultPassword,
    username,
    depositAmountCAW,
    networkId,
    lzDestId,
    passkeyPubkeyX,
    passkeyPubkeyY,
    smartEoaAddress,
    rpcProvider,
    passkeySigner,
    sponsorApi,
    minterAddress,
    permitNonce,
    lzTokenAmount,
    l2ChainId,
    kycLevel = 0,
    sponsorTokenId = 0,
    repayAmount = 0n,
    persistBeforeMint,
  } = opts

  // Step 1: Generate the secp256k1 keypair.
  // This is the user's primary identity key and future ecdsaFallback anchor.
  const keypair = generateSecp256k1Keypair()

  // Step 2: Encrypt the private key under the vault password.
  // The blob is returned to the caller for cloud storage — we do NOT store
  // it here. The raw private key is only kept in `keypair.privateKey` in
  // memory for the duration of this function.
  const backupBlob = await encryptBackupBlob(
    keypair.privateKey,
    vaultPassword,
    keypair.address,
  )

  // Step 3: Read chainId and EOA tx nonce from the RPC provider.
  // NEVER hardcode the chainId — same code path works on testnet + mainnet.
  const [chainId, nonce] = await Promise.all([
    rpcProvider.getChainId(),
    rpcProvider.getTransactionCount({ address: keypair.address }),
  ])

  // Step 4: Sign the EIP-7702 auth tuple.
  // This authorizes the delegation of the user's EOA to the SmartEOA contract.
  const authResult = await signAuthorizationTuple({
    privateKey: keypair.privateKey,
    chainId,
    contractAddress: smartEoaAddress,
    nonce: BigInt(nonce),
  })

  // Step 4a2: Sign a SECOND auth tuple for L2 (Pop-B L2 delegation). The passkey
  // root signer can only ERC-1271-verify on a chain where the EOA is delegated to
  // SmartEOA; CawActions verifies actions on L2, so the EOA must be delegated on
  // L2 too. We sign it here while keypair.privateKey is in scope. The L2 EOA nonce
  // is 0 on a fresh keypair (it has never transacted on L2). Returned as
  // `l2Delegation` for the caller to POST to /api/sponsor/delegate-l2 — no L2 tx
  // happens here. Skipped when l2ChainId is omitted (back-compat).
  let l2Delegation: BootstrapResult['l2Delegation'] = undefined
  if (l2ChainId !== undefined && l2ChainId !== chainId) {
    const l2Auth = await signAuthorizationTuple({
      privateKey: keypair.privateKey,
      chainId: l2ChainId,
      contractAddress: smartEoaAddress,
      nonce: 0n,   // fresh EOA: nonce 0 on L2 (never transacted there)
    })
    l2Delegation = {
      passkeyPubkeyX,
      passkeyPubkeyY,
      ecdsaFallbackAddr: keypair.address,
      authTupleNonce: '0',
      authTupleSignature: {
        yParity: l2Auth.signedAuthorization.yParity,
        r: l2Auth.signedAuthorization.r,
        s: l2Auth.signedAuthorization.s,
      },
    }
  }

  // Step 4b: Build the EIP-712 permit digest the passkey will sign.
  // CRITICAL: `recipient` must be the delegated EOA the contract sees — which
  // the sponsor server derives by RECOVERING the address from this exact auth
  // tuple (verifyAuthorization), then passing it as `recipient`. We recover it
  // the IDENTICAL way here so the FE-signed digest provably matches the
  // server's. Do NOT substitute keypair.address: although the tuple is signed
  // with keypair.privateKey, recovering from the signed tuple is the canonical
  // source of truth and immune to any address-derivation skew. A mismatched
  // recipient makes SmartEOA.isValidSignature fail (opaque MinterCallFailed).
  const recoveredRecipient = await recoverAuthorizationAddress({
    authorization: {
      chainId: authResult.signedAuthorization.chainId,
      address: authResult.signedAuthorization.address,
      nonce: authResult.signedAuthorization.nonce,
    },
    signature: {
      r: authResult.signedAuthorization.r,
      s: authResult.signedAuthorization.s,
      yParity: authResult.signedAuthorization.yParity,
    },
  })

  // TEMP DIAGNOSTIC (remove after sponsored-mint digest bug is closed): print
  // the three addresses + nonce so we can see, in the browser console, whether
  // the FE-recovered recipient matches keypair.address and what the server will
  // independently recover from the same tuple.
  // eslint-disable-next-line no-console
  console.log('[bootstrap:diag]', JSON.stringify({
    keypairAddress: keypair.address,
    recoveredRecipient,
    recoveredEqualsKeypair: recoveredRecipient.toLowerCase() === keypair.address.toLowerCase(),
    authNonce: authResult.signedAuthorization.nonce,
    authChainId: authResult.signedAuthorization.chainId,
    authDelegateTarget: authResult.signedAuthorization.address,
    permitNonce: permitNonce.toString(),
    chainId,
  }))

  const permitDigest = buildMintDepositPermitDigest({
    minterAddress,
    chainId,
    networkId,
    recipient: recoveredRecipient,
    username,
    depositAmount: depositAmountCAW,
    lzDestId,
    lzTokenAmount,
    nonce: permitNonce,
    kycLevel,
    sponsorTokenId,
    repayAmount,
  })

  // Step 5: Get the WebAuthn (passkey) assertion for the sponsor permit.
  // The passkey signer (Step 4d) produces an ABI-encoded WebAuthn assertion
  // over the permit digest. SmartEOA.isValidSignature dispatches to the
  // WebAuthn path when the blob is >= 224 bytes.
  //
  // SINGLE-PROMPT DM-PRF ENROL: `recoveredRecipient` (the owner address the PRF
  // salt is keyed by) is known HERE, before the ceremony — so we request the PRF
  // secret in this SAME touch. The captured secret is carried out and used by
  // enrollPrfAfterMint to wrap the DM recovery key with NO second Face ID. If the
  // authenticator doesn't support PRF, prfSecret is undefined and enrol falls back
  // to its own ceremony (unchanged behaviour).
  let mintPermitPrfSalt: Uint8Array | undefined
  try { mintPermitPrfSalt = await buildPrfSalt(recoveredRecipient) } catch { /* non-secure ctx — skip PRF capture */ }
  const passkeyAssertion = await passkeySigner(permitDigest, mintPermitPrfSalt)
  const capturedPrfSecret: Uint8Array | undefined = passkeyAssertion.prfSecret

  // Step 6: Assemble and submit the bootstrap params to the sponsor API.
  // The sponsor server builds the single type-0x04 tx:
  //   authorizationList: [authResult.signedAuthorization]
  //   to: keypair.address (the delegated EOA)
  //   calldata: SmartEOA.initialize(pkX, pkY, ecdsaFallback, mintParams)
  // which internally calls CawProfileMinter.mintAndDepositSponsored.
  const bootstrapParams: BootstrapParams = {
    ...(code ? { code } : {}),
    ...(xQualifiedToken ? { xQualifiedToken } : {}),
    passkeyPubkeyX,
    passkeyPubkeyY,
    ecdsaFallbackAddr: keypair.address,
    username,
    depositAmountCAW,
    networkId,
    lzDestId,
    authTupleSignature: authResult.signedAuthorization,
    permitSig: passkeyAssertion.permitSig,
    clientDataJSON: passkeyAssertion.clientDataJSON,
    authenticatorData: passkeyAssertion.authenticatorData,
  }

  // DURABILITY: make the profile recoverable BEFORE the irreversible mint. Upload
  // the ciphertext backup blob (and enrol PRF) keyed by the owner address, so a
  // lost mint response doesn't orphan the profile — the recovery key survives on
  // the server, restorable via /recovery. A throw here aborts before the mint.
  if (persistBeforeMint) {
    await persistBeforeMint({
      ownerAddress: keypair.address,
      backupBlob,
      recoveryPrivateKey: keypair.privateKey,
    })
  }

  const { txHash } = await sponsorApi.sponsorBootstrap(bootstrapParams)

  // Build a one-shot signer over the ecdsaFallback key for post-mint sign-in.
  // viem's privateKeyToAccount gives an EIP-191 personal_sign signer matching
  // what /api/auth/verify recovers via ethers.verifyMessage. Captures the key
  // in a closure only — nothing new is persisted.
  const verifyAccount = privateKeyToAccount(bytesToHex(keypair.privateKey))

  // CRITICAL: the minted profile is owned by `recoveredRecipient` (the delegated
  // EOA the sponsor server set as `recipient` — recovered from the auth tuple),
  // NOT keypair.address. /api/auth/verify looks up the User by the address the
  // signature recovers to, so we MUST report the owner address as ecdsaAddress.
  // verifyAccount signs with keypair.privateKey; for the verify to resolve to the
  // profile owner, that recovered signer must equal recoveredRecipient — which it
  // does, since recoveredRecipient is exactly the authority of the tuple signed by
  // keypair.privateKey. Returning keypair.address here (≠ recoveredRecipient in
  // practice) made verify look up a non-existent User → no session → /welcome.
  return {
    txHash,
    backupBlob,
    ecdsaAddress: recoveredRecipient,
    // Echo the minted username back so the post-mint sign-in navigates to the
    // right /welcome/:username. The onboarding handler is a useCallback that
    // closes over a STALE `state` (empty username at callback-creation time), so
    // it must NOT read state.username — it reads result.username instead. (#209
    // regression: empty username → navigate('/welcome/') → /home → splash.)
    username,
    depositAmountCAW,
    signVerifyMessage: (message: string) => verifyAccount.signMessage({ message }),
    // Bug D: enrol the PRF blob after the mint (profile indexed + SmartEOA live).
    // Closes over keypair.privateKey + recoveredRecipient (the owner) + the PRF
    // secret CAPTURED during the mint-permit ceremony (capturedPrfSecret).
    //
    // SINGLE-PROMPT PATH (preferred): if we already hold the PRF secret from the
    // mint-permit touch, wrap the recovery key with it and write via the
    // SESSION-AUTHENTICATED first-write (the user is signed in post-mint) — NO
    // second Face ID. FALLBACK: no captured secret (authenticator lacks PRF, or a
    // non-secure ctx) → the old self-contained passkey-gated ceremony.
    enrollPrfAfterMint: async (credentialId: string): Promise<boolean> => {
      const owner = recoveredRecipient
      // Fast path: reuse the captured secret + session-authed first-write.
      if (capturedPrfSecret) {
        try {
          markPrfCapable(credentialId, true)
          const aesKey = await prfSecretToAesKey(capturedPrfSecret)
          const prfBlob = await encryptBackupBlobWithKey(keypair.privateKey, aesKey, owner)
          // No challenge/signature: the server accepts a FIRST prfBlob write when
          // the caller's session (JWT) is authorized for this address's token AND
          // no prfBlob exists yet. Overwrites still require the passkey gate.
          await apiFetch('/api/wallet/blob/prf', {
            method: 'POST',
            body: JSON.stringify({ address: owner, prfBlob: JSON.stringify(prfBlob) }),
          })
          return true
        } catch (e) {
          console.warn('[bootstrap] single-prompt PRF enrol failed; falling back to ceremony:', e)
          // fall through to the passkey-gated path
        }
      }
      // Fallback: self-contained passkey-gated ceremony (own Face ID).
      try {
        const rpId = typeof window !== 'undefined' ? window.location.hostname : ''
        const salt = await buildPrfSalt(owner)
        const { challenge } = await apiFetch<{ challenge: `0x${string}` }>(
          '/api/wallet/blob/challenge',
          { method: 'POST', body: JSON.stringify({ address: owner }) },
        )
        const sig = await signWithPasskey({ credentialId, digest: challenge, rpId, prfSalt: salt })
        markPrfCapable(credentialId, !!sig.prfSecret)
        if (!sig.prfSecret) return false
        const aesKey = await prfSecretToAesKey(sig.prfSecret)
        const prfBlob = await encryptBackupBlobWithKey(keypair.privateKey, aesKey, owner)
        await apiFetch('/api/wallet/blob/prf', {
          method: 'POST',
          body: JSON.stringify({
            address: owner,
            prfBlob: JSON.stringify(prfBlob),
            challenge,
            signature: sig.sig,
          }),
        })
        return true
      } catch (e) {
        console.warn('[bootstrap] PRF enrol after mint skipped (non-fatal):', e)
        return false
      }
    },
    l2Delegation,
  }
}
