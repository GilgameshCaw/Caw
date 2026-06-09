/**
 * SponsorService — submits sponsored L1 contract calls on behalf of users.
 *
 * Three operations:
 *   sponsorBootstrap  — single EIP-7702 type-0x04 tx that delegates the
 *                       user's EOA to SmartEOA, initialises it, and calls
 *                       CawProfileMinter.mintAndDepositSponsored in one shot.
 *   sponsorDeposit    — calls depositForSponsored; no auth-tuple needed (EOA
 *                       already delegated from bootstrap).
 *   sponsorAuthenticate — calls authenticateSponsored for a second-network
 *                         auth on an already-minted profile.
 *
 * Trust chain: user ERC-1271 permit sig → CawProfileMinter verifies on-chain
 * → pulls CAW from sponsor → mints/deposits/auth to user's recipient address.
 * Sponsor cannot redirect funds; all critical params are bound into the permit.
 *
 * This service is intentionally NOT wired into ValidatorService; it submits
 * L1 transactions while ValidatorService submits L2 action batches. Separate
 * concerns, separate hot wallets (though the same env key may be used for
 * both in small deployments).
 */

import {
  Contract,
  Wallet,
  Transaction,
  Interface,
  Signature,
  toBeHex,
  verifyAuthorization,
  authorizationify,
  type Provider,
  type ContractTransactionResponse,
  type Authorization,
} from 'ethers'
import { makeJsonRpcProvider } from '../../utils/rpcProvider'
import { cawProfileMinterAbi, smartEoaAbi } from '../../abi/generated'

// ─── Param types ────────────────────────────────────────────────────────────

export interface AuthTupleSignature {
  yParity: number
  r: `0x${string}`
  s: `0x${string}`
}

export interface BootstrapParams {
  passkeyPubkeyX: `0x${string}`
  passkeyPubkeyY: `0x${string}`
  ecdsaFallbackAddr: `0x${string}`
  username: string
  depositAmountCAW: bigint
  networkId: number
  lzDestId: number
  lzTokenAmount: bigint
  // 7702 auth tuple signed by the user's secp256k1 key
  authTupleSignature: AuthTupleSignature
  authTupleNonce: bigint   // user's EOA nonce at sign time (usually 0)
  // EIP-712 permit sig from the user (passkey or secp256k1)
  permitSig: `0x${string}`
  permitNonce: bigint      // current SmartEOA.nonceOf(Minter, ACTION_MINT_DEPOSIT)
  // Phase 2 Sponsor Repay — all default to 0 / unused.
  // - kycLevel withdraw gate (set at mint, stored per-tokenId on Minter):
  //     0 = no gate (gift / repay-only / casual sponsorship — default)
  //     1 = 180-day time-lock, no KYC ("stored-value" fiat-mint framing)
  //     2+ = KYC verifier required at that level (Civic Pass adapter, etc.)
  // - sponsorTokenId: the sponsor profile receiving sweeps when repayAmount > 0
  // - repayAmount: wei. Contract enforces repayAmount <= depositAmount * 2.
  kycLevel?: number
  sponsorTokenId?: number
  repayAmount?: bigint
}

export interface DepositParams {
  tokenId: number
  amount: bigint
  networkId: number
  lzDestId: number
  lzTokenAmount: bigint
  permitNonce: bigint
  permitSig: `0x${string}`
}

export interface AuthenticateParams {
  tokenId: number
  networkId: number
  lzDestId: number
  lzTokenAmount: bigint
  permitNonce: bigint
  permitSig: `0x${string}`
}

// ─── Structured error responses ─────────────────────────────────────────────

export type SponsorErrorCode =
  | 'USERNAME_TAKEN'
  | 'BAD_SIG'
  | 'NONCE_MISMATCH'
  | 'ZERO_DEPOSIT'
  | 'DEPOSIT_TOO_LARGE'
  | 'LZ_FEE_TOO_LARGE'
  | 'LZ_UNDERPAID'
  | 'TREASURY_LOW'
  | 'RECIPIENT_NOT_DELEGATED'
  | 'TX_REVERTED'
  | 'INTERNAL'
  // ── Sponsor-code gating errors (validateSponsorCode) ──────────────────────
  | 'INVALID_CODE'
  | 'CODE_EXPIRED'
  | 'CODE_EXHAUSTED'
  | 'BUDGET_EXCEEDED'
  | 'IP_BANNED'
  | 'USERNAME_TOO_SHORT'
  | 'INVALID_CODE_LOCKDOWN'

export interface SponsorError {
  error: SponsorErrorCode
  detail: string
}

export interface SponsorSuccess {
  txHash: string
}

export type SponsorResult = SponsorSuccess | SponsorError

export function isSponsorError(r: SponsorResult): r is SponsorError {
  return 'error' in r
}

// ─── Minimum ETH balance before we refuse to submit (0.01 ETH) ──────────────
const MIN_TREASURY_ETH = BigInt('10000000000000000') // 0.01 ETH

// ─── Gas limits — generous to avoid OOG without over-reserving ──────────────
const GAS_LIMIT_BOOTSTRAP   = 400_000n
const GAS_LIMIT_DEPOSIT     = 250_000n
const GAS_LIMIT_AUTHENTICATE = 250_000n

// ─── Known revert reason selectors (keccak256 of the error string) ───────────
// We match on lowercased substring of the revert reason since contracts may
// vary the exact string slightly across versions.
const REVERT_SUBSTRINGS: Record<SponsorErrorCode, string[]> = {
  USERNAME_TAKEN:          ['already been taken', 'username taken', 'taken'],
  BAD_SIG:                 ['bad sig', 'invalid signature', 'sig invalid'],
  NONCE_MISMATCH:          ['nonce mismatch', 'invalid nonce'],
  ZERO_DEPOSIT:            ['zero deposit', 'amount is 0'],
  DEPOSIT_TOO_LARGE:       [],    // generated locally, never from contract
  LZ_FEE_TOO_LARGE:        [],    // generated locally, never from contract
  LZ_UNDERPAID:            ['lz fee', 'insufficient fee', 'lzsend'],
  TREASURY_LOW:            [],    // generated locally, never from contract
  RECIPIENT_NOT_DELEGATED: ['direct submit required', 'not delegated', 'code.length'],
  TX_REVERTED:             [],    // fallback for unmatched reverts
  INTERNAL:                [],    // internal service errors
  // ── Sponsor-code errors: never returned from on-chain reverts ────────────
  INVALID_CODE:            [],
  CODE_EXPIRED:            [],
  CODE_EXHAUSTED:          [],
  BUDGET_EXCEEDED:         [],
  IP_BANNED:               [],
  USERNAME_TOO_SHORT:      [],
  INVALID_CODE_LOCKDOWN:   [],
}

function parseRevertError(err: unknown): SponsorError {
  const raw = String((err as any)?.reason || (err as any)?.message || err).toLowerCase()
  for (const [code, substrings] of Object.entries(REVERT_SUBSTRINGS) as [SponsorErrorCode, string[]][]) {
    if (substrings.length > 0 && substrings.some(s => raw.includes(s))) {
      return { error: code, detail: raw }
    }
  }
  return { error: 'TX_REVERTED', detail: raw }
}

// ─── SponsorService ──────────────────────────────────────────────────────────

export interface SponsorServiceOpts {
  l1ProviderUrl: string
  l1RpcSecret?: string
  l1ChainId?: number
  sponsorPrivateKey: string
  minterAddress: string
  cawProfileAddress: string
  smartEoaAddress: string
  /** Minimum CAW required for a bootstrap call (prevents dust-mint spam). */
  minDepositCAW?: bigint
  /** Maximum CAW allowed per bootstrap/deposit call (M-1 anti-drain cap). Default 10M CAW. */
  maxDepositCAW?: bigint
  /** Maximum LZ fee (wei) allowed per call (M-2 anti-drain cap). Default 0.005 ETH. */
  maxLzFeeWei?: bigint
}

export class SponsorService {
  private readonly provider: Provider
  private readonly wallet: Wallet
  private readonly minterAddress: string
  private readonly cawProfileAddress: string
  private readonly smartEoaAddress: string
  private readonly minDepositCAW: bigint
  private readonly maxDepositCAW: bigint
  private readonly maxLzFeeWei: bigint
  private readonly l1ChainId: number | undefined

  // Lazily resolved from provider on first call; cached for subsequent calls.
  private resolvedChainId: number | null = null

  constructor(opts: SponsorServiceOpts) {
    this.provider = makeJsonRpcProvider(opts.l1ProviderUrl, opts.l1ChainId, opts.l1RpcSecret)
    // Wallet bound to provider so .sendTransaction() works.
    this.wallet = new Wallet(opts.sponsorPrivateKey, this.provider)
    this.minterAddress = opts.minterAddress
    this.cawProfileAddress = opts.cawProfileAddress
    this.smartEoaAddress = opts.smartEoaAddress
    this.minDepositCAW = opts.minDepositCAW ?? BigInt(0)
    this.maxDepositCAW = opts.maxDepositCAW ?? 10_000_000n * 10n ** 18n  // 10M CAW
    this.maxLzFeeWei = opts.maxLzFeeWei ?? 5_000_000_000_000_000n         // 0.005 ETH
    this.l1ChainId = opts.l1ChainId
  }

  // ── Public surface ──────────────────────────────────────────────────────

  /**
   * Bootstrap a new Population B user in a single EIP-7702 type-4 tx.
   * The tx:
   *   1. Applies the 7702 auth tuple (delegates EOA → SmartEOA).
   *   2. Calls SmartEOA.initialize(pkX, pkY, fallback, minterAddr, mintCalldata).
   *   3. SmartEOA.initialize calls mintAndDepositSponsored internally.
   *
   * The user MUST have already signed:
   *   a. A 7702 auth tuple with their secp256k1 key (authTupleSignature).
   *   b. An EIP-712 MintAndDeposit permit via their passkey or secp256k1 key.
   */
  async sponsorBootstrap(params: BootstrapParams): Promise<SponsorResult> {
    try {
      const chainId = await this.getChainId()

      // ── Pre-flight checks ──────────────────────────────────────────────

      // 1. Minimum deposit check
      if (params.depositAmountCAW < this.minDepositCAW) {
        return {
          error: 'ZERO_DEPOSIT',
          detail: `depositAmountCAW ${params.depositAmountCAW} is below minimum ${this.minDepositCAW}`,
        }
      }

      // 1b. Maximum deposit check (M-1): prevents an attacker from forcing the
      //     sponsor to transfer up to its full CAW allowance in a single call.
      if (params.depositAmountCAW > this.maxDepositCAW) {
        return {
          error: 'DEPOSIT_TOO_LARGE',
          detail: `depositAmountCAW ${params.depositAmountCAW} exceeds SPONSOR_MAX_DEPOSIT_CAW (${this.maxDepositCAW})`,
        }
      }

      // 1c. Maximum LZ fee check (M-2): prevents forcing the sponsor to send
      //     up to its full ETH balance as a LayerZero fee in a single call.
      if (params.lzTokenAmount > this.maxLzFeeWei) {
        return {
          error: 'LZ_FEE_TOO_LARGE',
          detail: `lzTokenAmount ${params.lzTokenAmount} exceeds SPONSOR_MAX_LZ_FEE_WEI (${this.maxLzFeeWei})`,
        }
      }

      // 2. Recover user's EOA address from their 7702 auth tuple sig.
      //    The auth tuple hash is: keccak256(0x05 || rlp([chainId, smartEoaAddress, nonce]))
      //    verifyAuthorization does exactly this.
      const authForRecovery = {
        address: this.smartEoaAddress,
        nonce: params.authTupleNonce,
        chainId: BigInt(chainId),
      }
      // verifyAuthorization accepts SignatureLike — flat { r, s, yParity } works
      const sigComponents = {
        yParity: params.authTupleSignature.yParity,
        r: params.authTupleSignature.r,
        s: params.authTupleSignature.s,
      }
      let userEoaAddress: string
      try {
        userEoaAddress = verifyAuthorization(authForRecovery, sigComponents as any)
      } catch (e) {
        return { error: 'BAD_SIG', detail: `Could not recover EOA from auth tuple: ${e}` }
      }

      // 2b. Preflight: confirm FE-supplied authTupleNonce matches user's current
      //     EOA nonce. If stale, the 7702 auth-list entry is silently dropped by
      //     the EVM (nonce mismatch causes that entry to be skipped, not a revert)
      //     and we'd burn sponsor gas running mintAndDepositSponsored against an
      //     un-delegated EOA (L-4).
      const currentEoaNonce = await this.provider.getTransactionCount(userEoaAddress, 'pending')
      if (BigInt(currentEoaNonce) !== params.authTupleNonce) {
        return {
          error: 'NONCE_MISMATCH',
          detail: `authTupleNonce ${params.authTupleNonce} doesn't match user's current EOA nonce ${currentEoaNonce}`,
        }
      }

      // 3. Username availability pre-check (best-effort; contract enforces atomically)
      const minterReadOnly = new Contract(
        this.minterAddress,
        cawProfileMinterAbi as any,
        this.provider,
      )
      const existingId: bigint = await minterReadOnly.idByUsername(params.username)
      if (existingId !== 0n) {
        return { error: 'USERNAME_TAKEN', detail: `Username "${params.username}" is already taken (id=${existingId})` }
      }

      // 4. Treasury balance check
      const sponsorBalance = await this.provider.getBalance(this.wallet.address)
      if (sponsorBalance < MIN_TREASURY_ETH) {
        return {
          error: 'TREASURY_LOW',
          detail: `Sponsor ETH balance (${sponsorBalance}) below minimum (${MIN_TREASURY_ETH})`,
        }
      }

      // ── Build the mintAndDepositSponsored calldata ────────────────────
      // This is the calldata that SmartEOA.initialize will forward to the
      // Minter as the final step of its execution. The sponsor's sig
      // check happens inside the Minter against the SmartEOA's storage
      // (already written in initialize step 2 before the external call).
      //
      // Phase 2 Sponsor Repay: the last 3 args (kycLevel/sponsorTokenId/
      // repayAmount) default to zero — only set when /api/sponsor/bootstrap
      // applied a non-zero sponsor-code policy. Zero values match the
      // pre-Phase-2 behaviour exactly (no kyc gate, no repay obligation).
      const minterIface = new Interface(cawProfileMinterAbi as any)
      const mintCalldata = minterIface.encodeFunctionData('mintAndDepositSponsored', [
        params.networkId,
        userEoaAddress,     // recipient = the user's delegated EOA
        params.username,
        params.depositAmountCAW,
        params.lzDestId,
        params.lzTokenAmount,
        params.permitNonce,
        params.permitSig,
        params.kycLevel       ?? 0,
        params.sponsorTokenId ?? 0,
        params.repayAmount    ?? 0n,
      ])

      // ── Build SmartEOA.initialize calldata ───────────────────────────
      const smartEoaIface = new Interface(smartEoaAbi as any)
      const initCalldata = smartEoaIface.encodeFunctionData('initialize', [
        params.passkeyPubkeyX,
        params.passkeyPubkeyY,
        params.ecdsaFallbackAddr,
        this.minterAddress,
        mintCalldata,
      ])

      // ── Assemble EIP-7702 type-4 transaction ─────────────────────────
      // authorizationify() requires AuthorizationLike: { address, nonce, chainId,
      // signature: SignatureLike }. We build a SignatureLike from the user's
      // flat { r, s, yParity } components via Signature.from().
      const authEntry: Authorization = authorizationify({
        address: this.smartEoaAddress,
        nonce: params.authTupleNonce,
        chainId: BigInt(chainId),
        signature: Signature.from({
          r: sigComponents.r,
          s: sigComponents.s,
          yParity: sigComponents.yParity as 0 | 1,
        }),
      })

      const sponsorNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending')
      const feeData = await this.provider.getFeeData()

      const tx = new Transaction()
      tx.type = 4
      tx.to = userEoaAddress
      tx.data = initCalldata
      // msg.value flows through initialize → mintAndDepositSponsored to cover
      // the LayerZero fee. Pass lzTokenAmount as the ETH value; the Minter
      // uses it for the LZ send call.
      tx.value = params.lzTokenAmount
      tx.nonce = sponsorNonce
      tx.chainId = BigInt(chainId)
      tx.gasLimit = GAS_LIMIT_BOOTSTRAP
      tx.maxFeePerGas = feeData.maxFeePerGas ?? (feeData.gasPrice ?? 20_000_000_000n)
      tx.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 1_500_000_000n
      tx.authorizationList = [authEntry]

      // Sign with sponsor's key.
      const signedTx = await this.wallet.signTransaction(tx)
      const txResponse = await this.provider.broadcastTransaction(signedTx)

      // Wait for the receipt and CHECK STATUS. The tx can be mined yet REVERT
      // (e.g. the sponsor wallet hasn't approved the Minter to spend its CAW →
      // SmartEOA returns MinterCallFailed). Returning the hash on broadcast
      // alone made the FE treat a reverted mint as success — the user got a
      // "done" screen and a profile that doesn't exist. Confirm the mint
      // actually landed before reporting success.
      const receipt = await txResponse.wait()
      if (!receipt || receipt.status !== 1) {
        return {
          error: 'TX_REVERTED',
          detail: `Bootstrap tx ${txResponse.hash} reverted on-chain (status ${receipt?.status ?? 'null'}). ` +
            `Common cause: the sponsor wallet has not approved the Minter to spend CAW.`,
        }
      }

      return { txHash: txResponse.hash }
    } catch (err) {
      // Distinguish between pre-submit and on-chain reverts for caller.
      return parseRevertError(err)
    }
  }

  /**
   * Deposit additional CAW for an already-minted profile, with sponsored gas.
   * The user's EOA must already be delegated to SmartEOA (from a prior bootstrap).
   * depositForSponsored also authenticates on first-deposit for a network.
   */
  async sponsorDeposit(params: DepositParams): Promise<SponsorResult> {
    try {
      if (params.amount === 0n) {
        return { error: 'ZERO_DEPOSIT', detail: 'amount must be > 0' }
      }

      // M-1: cap per-call deposit amount to prevent sponsor CAW drain.
      if (params.amount > this.maxDepositCAW) {
        return {
          error: 'DEPOSIT_TOO_LARGE',
          detail: `amount ${params.amount} exceeds SPONSOR_MAX_DEPOSIT_CAW (${this.maxDepositCAW})`,
        }
      }

      // M-2: cap per-call LZ fee to prevent sponsor ETH drain.
      if (params.lzTokenAmount > this.maxLzFeeWei) {
        return {
          error: 'LZ_FEE_TOO_LARGE',
          detail: `lzTokenAmount ${params.lzTokenAmount} exceeds SPONSOR_MAX_LZ_FEE_WEI (${this.maxLzFeeWei})`,
        }
      }

      // Treasury check
      const sponsorBalance = await this.provider.getBalance(this.wallet.address)
      if (sponsorBalance < MIN_TREASURY_ETH) {
        return {
          error: 'TREASURY_LOW',
          detail: `Sponsor ETH balance (${sponsorBalance}) below minimum (${MIN_TREASURY_ETH})`,
        }
      }

      const minter = new Contract(
        this.minterAddress,
        cawProfileMinterAbi as any,
        this.wallet,
      )

      const txResponse: ContractTransactionResponse = await minter.depositForSponsored(
        params.networkId,
        params.tokenId,
        params.amount,
        params.lzDestId,
        params.lzTokenAmount,
        params.permitNonce,
        params.permitSig,
        {
          value: params.lzTokenAmount,
          gasLimit: GAS_LIMIT_DEPOSIT,
        },
      )

      return { txHash: txResponse.hash }
    } catch (err) {
      return parseRevertError(err)
    }
  }

  /**
   * Authenticate an already-deposited profile to a second network, with
   * sponsored gas. Calls CawProfileMinter.authenticateSponsored which in
   * turn calls CawProfile.authenticateForMinter.
   */
  async sponsorAuthenticate(params: AuthenticateParams): Promise<SponsorResult> {
    try {
      // M-2: cap per-call LZ fee to prevent sponsor ETH drain.
      if (params.lzTokenAmount > this.maxLzFeeWei) {
        return {
          error: 'LZ_FEE_TOO_LARGE',
          detail: `lzTokenAmount ${params.lzTokenAmount} exceeds SPONSOR_MAX_LZ_FEE_WEI (${this.maxLzFeeWei})`,
        }
      }

      // Treasury check
      const sponsorBalance = await this.provider.getBalance(this.wallet.address)
      if (sponsorBalance < MIN_TREASURY_ETH) {
        return {
          error: 'TREASURY_LOW',
          detail: `Sponsor ETH balance (${sponsorBalance}) below minimum (${MIN_TREASURY_ETH})`,
        }
      }

      const minter = new Contract(
        this.minterAddress,
        cawProfileMinterAbi as any,
        this.wallet,
      )

      const txResponse: ContractTransactionResponse = await minter.authenticateSponsored(
        params.networkId,
        params.tokenId,
        params.lzDestId,
        params.lzTokenAmount,
        params.permitNonce,
        params.permitSig,
        {
          value: params.lzTokenAmount,
          gasLimit: GAS_LIMIT_AUTHENTICATE,
        },
      )

      return { txHash: txResponse.hash }
    } catch (err) {
      return parseRevertError(err)
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private async getChainId(): Promise<number> {
    if (this.resolvedChainId !== null) return this.resolvedChainId
    if (this.l1ChainId != null) {
      this.resolvedChainId = this.l1ChainId
      return this.l1ChainId
    }
    const network = await this.provider.getNetwork()
    this.resolvedChainId = Number(network.chainId)
    return this.resolvedChainId
  }
}

// ─── Singleton factory ───────────────────────────────────────────────────────

let _instance: SponsorService | null = null

/**
 * Lazily initialise and return the process-singleton SponsorService.
 * Returns null when SPONSOR_ENABLED is not '1' or required env vars are missing.
 * Caller must check for null before using the service.
 */
export function getSponsorService(): SponsorService | null {
  if (process.env.SPONSOR_ENABLED !== '1') return null

  // SPONSOR_CODE_HMAC_SECRET is required when sponsor is enabled. Fail at
  // startup rather than at first redemption attempt.
  if (!process.env.SPONSOR_CODE_HMAC_SECRET) {
    throw new Error(
      '[SponsorService] SPONSOR_CODE_HMAC_SECRET must be set (32+ random bytes hex) when SPONSOR_ENABLED=1',
    )
  }

  if (_instance) return _instance

  const l1ProviderUrl = process.env.SPONSOR_L1_RPC_URL || process.env.L1_RPC_URL_HTTP || ''
  const l1RpcSecret = process.env.L1_RPC_SECRET || undefined
  const privateKey = process.env.SPONSOR_HOT_WALLET_PRIVATE_KEY
  const minterAddress = process.env.CAW_NAMES_MINTER_ADDRESS || ''
  const cawProfileAddress = process.env.CAW_NAMES_ADDRESS || ''
  const smartEoaAddress = process.env.SMART_EOA_ADDRESS || ''

  if (!l1ProviderUrl || !privateKey || !minterAddress || !cawProfileAddress || !smartEoaAddress) {
    console.warn(
      '[SponsorService] Missing required env vars. ' +
      'Set SPONSOR_L1_RPC_URL (or L1_RPC_URL_HTTP), SPONSOR_HOT_WALLET_PRIVATE_KEY, ' +
      'CAW_NAMES_MINTER_ADDRESS, CAW_NAMES_ADDRESS, SMART_EOA_ADDRESS. ' +
      'SponsorService is disabled.',
    )
    return null
  }

  const minDepositRaw = process.env.SPONSOR_MIN_DEPOSIT_CAW
  const minDepositCAW = minDepositRaw ? BigInt(minDepositRaw) : 1_000_000n * 10n ** 18n

  const maxDepositRaw = process.env.SPONSOR_MAX_DEPOSIT_CAW
  const maxDepositCAW = maxDepositRaw ? BigInt(maxDepositRaw) : 10_000_000n * 10n ** 18n  // 10M CAW

  const maxLzFeeRaw = process.env.SPONSOR_MAX_LZ_FEE_WEI
  const maxLzFeeWei = maxLzFeeRaw ? BigInt(maxLzFeeRaw) : 5_000_000_000_000_000n  // 0.005 ETH

  _instance = new SponsorService({
    l1ProviderUrl,
    l1RpcSecret,
    l1ChainId: process.env.L1_CHAIN_ID ? Number(process.env.L1_CHAIN_ID) : undefined,
    sponsorPrivateKey: privateKey,
    minterAddress,
    cawProfileAddress,
    smartEoaAddress,
    minDepositCAW,
    maxDepositCAW,
    maxLzFeeWei,
  })

  return _instance
}
