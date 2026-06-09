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
import { encryptBackupBlob, type BackupBlob } from './backupBlob'
import { signAuthorizationTuple, type SignedAuthorizationTuple } from './eip7702'
import { buildMintDepositPermitDigest } from './eip712Permits'

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
   * Invite code (required). Threaded all the way through to the
   * /api/sponsor/bootstrap call, where it's validated against the
   * SponsorCode table. Server returns INVALID_CODE/IP_BANNED/etc on miss.
   */
  code: string
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
export type PasskeyPermitSigner = (permitDigest: `0x${string}`) => Promise<{
  permitSig: `0x${string}`
  clientDataJSON: string
  authenticatorData: `0x${string}`
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
  /**
   * One-shot signer for the post-mint /api/auth/verify sign-in. The minted
   * profile is owned by `ecdsaAddress`, and this closure signs a personal_sign
   * message with that key so the onboarding can establish a session WITHOUT
   * persisting the raw private key anywhere. The key lives only inside this
   * closure (already in memory for the bootstrap) — let it GC after use.
   */
  signVerifyMessage: (message: string) => Promise<`0x${string}`>
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
  code: string
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
}): Promise<BootstrapResult> {
  const {
    code,
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
    kycLevel = 0,
    sponsorTokenId = 0,
    repayAmount = 0n,
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
  const passkeyAssertion = await passkeySigner(permitDigest)

  // Step 6: Assemble and submit the bootstrap params to the sponsor API.
  // The sponsor server builds the single type-0x04 tx:
  //   authorizationList: [authResult.signedAuthorization]
  //   to: keypair.address (the delegated EOA)
  //   calldata: SmartEOA.initialize(pkX, pkY, ecdsaFallback, mintParams)
  // which internally calls CawProfileMinter.mintAndDepositSponsored.
  const bootstrapParams: BootstrapParams = {
    code,
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

  const { txHash } = await sponsorApi.sponsorBootstrap(bootstrapParams)

  // Build a one-shot signer over the ecdsaFallback key for post-mint sign-in.
  // viem's privateKeyToAccount gives an EIP-191 personal_sign signer matching
  // what /api/auth/verify recovers via ethers.verifyMessage. Captures the key
  // in a closure only — nothing new is persisted.
  const verifyAccount = privateKeyToAccount(bytesToHex(keypair.privateKey))

  return {
    txHash,
    backupBlob,
    ecdsaAddress: keypair.address,
    signVerifyMessage: (message: string) => verifyAccount.signMessage({ message }),
  }
}
