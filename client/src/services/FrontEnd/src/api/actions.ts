import { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch }              from './client'
import { baseSepolia }           from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData, useAccount, useSwitchChain } from 'wagmi'
import { readContract } from '@wagmi/core'
import type { TypedDataDomain, TypedDataField } from '@ethersproject/abstract-signer'
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { useClientConfigStore } from "~/store/clientConfigStore";
import { CAW_ACTIONS_ADDRESS, CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawActionsAbi, cawNameL2Abi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { hasMinimumStake, getRequiredStake, STAKING_REQUIREMENTS } from '~/constants/stakingRequirements'
import { getActionTypeForModal } from '~/errors/InsufficientStakeError'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import { useAuthStore } from '~/store/authStore'
import { privateKeyToAccount } from 'viem/accounts'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useClientAuthStore } from '~/store/clientAuthStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { useInstanceStore } from '~/store/instanceStore'
import { API_HOST } from './client'


// Cache client auth status per tokenId to avoid repeated RPC calls
const clientAuthCache = new Map<number, boolean>()

/**
 * Read the current on-chain staked CAW balance for a tokenId directly from
 * the L2 contract (cawBalanceOf). Used when writing pending-deposit hints
 * to capture a trustworthy baseline — the wagmi store can be stale, but a
 * fresh RPC call is ground truth. The clearing rule in ProfileChooser
 * relies on this baseline to detect "deposit has landed" by measuring the
 * stake delta, so it must not be wrong.
 *
 * Returns 0n on any failure (fresh mints will legitimately return 0 because
 * the token didn't exist on L2 yet; failures also degrade to 0 which is the
 * safest default — a too-low baseline means the clearing rule needs the
 * absolute stake to reach the deposit amount before firing, which is correct).
 */
export async function readOnChainStakeForHint(tokenId: number): Promise<bigint> {
  try {
    const result = await readContract(wagmiConfig, {
      address: CAW_NAMES_L2_ADDRESS,
      abi: cawNameL2Abi,
      functionName: 'cawBalanceOf',
      args: [tokenId],
      chainId: baseSepolia.id,
    })
    return BigInt(result?.toString() ?? '0')
  } catch (err) {
    console.warn(`[readOnChainStakeForHint] Failed for tokenId=${tokenId}:`, err)
    return 0n
  }
}

/** map human-friendly names to on-chain enum values */
const ActionTypeMap = {
  caw:      0,
  like:     1,
  unlike:   2,
  recaw:    3,
  follow:   4,
  unfollow: 5,
  withdraw: 6,
  other:    7
} as const

export type ActionTypeKey = keyof typeof ActionTypeMap

/** natstat: singleton client ID (one per front-end) */
export const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID) || 1

/**
 * Validator tip (in whole CAW tokens - contract multiplies by 10^18)
 *
 * Base tip is fetched from the server (set via admin settings page).
 * Falls back to VITE_VALIDATOR_TIP env var, then 1000.
 * Per-chain tip: Additional tip per replication chain to cover LZ fees.
 */
let BASE_VALIDATOR_TIP = BigInt(import.meta.env.VITE_VALIDATOR_TIP || "1000")

/** Additional tip per replication chain (to cover share of LZ fees) */
const TIP_PER_REPLICATION_CHAIN = BigInt(import.meta.env.VITE_TIP_PER_CHAIN || "500") // 500 CAW per chain

// Fetch live tip config from server on startup
apiFetch<{ baseTip: string }>('/api/validator-analytics/tip-config')
  .then(cfg => {
    BASE_VALIDATOR_TIP = BigInt(cfg.baseTip)
    console.log(`[Actions] Loaded validator base tip: ${BASE_VALIDATOR_TIP} CAW`)
  })
  .catch(() => {
    console.warn('[Actions] Could not fetch tip config, using default:', BASE_VALIDATOR_TIP.toString())
  })

/**
 * Calculate the validator tip based on replication chain count
 * This compensates the validator for the LayerZero fees they pay for replication
 */
export function getValidatorTip(): bigint {
  const chainCount = useClientConfigStore.getState().getReplicationChainCount()
  return BASE_VALIDATOR_TIP + (TIP_PER_REPLICATION_CHAIN * BigInt(chainCount))
}

/**
 * Check which cawonces in a range are already used (pending or confirmed).
 * Returns the first safe cawonce to start a contiguous block of `count` actions.
 */
export async function findSafeCawonceStart(tokenId: number, start: number, count: number): Promise<number> {
  const result = await apiFetch<{ used: number[]; nextSafe: number }>('/api/users/check-cawonces', {
    method: 'POST',
    body: JSON.stringify({ tokenId, start, count }),
  })
  // If no conflicts, the original start is fine
  if (result.used.length === 0) return start
  // Otherwise use the server's suggestion
  return result.nextSafe
}


/** natstat: EIP-712 domain */
export const DOMAIN: TypedDataDomain = {
  name:               'Caw Protocol',
  version:            '1',
  chainId:            baseSepolia.id,
  verifyingContract:  CAW_ACTIONS_ADDRESS
}

/** natstat: EIP-712 types */
export const TYPES: Record<string, TypedDataField[]> = {
  EIP712Domain: [
    { name: 'name',              type: 'string'  },
    { name: 'version',           type: 'string'  },
    { name: 'chainId',           type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ],
  ActionData: [
    { name: 'actionType',      type: 'uint8'    },
    { name: 'senderId',        type: 'uint32'   },
    { name: 'receiverId',      type: 'uint32'   },
    { name: 'receiverCawonce', type: 'uint32'   },
    { name: 'clientId',        type: 'uint32'   },
    { name: 'cawonce',         type: 'uint32'   },
    { name: 'recipients',      type: 'uint32[]' },
    { name: 'amounts',         type: 'uint64[]' },
    { name: 'text',            type: 'string'   }
  ]
}

export type ActionParams = {
  actionType:     ActionTypeKey   // now a string key
  senderId:       number
  receiverId?:    number
  receiverCawonce?: number
  cawonce?:       number
  recipients?:    number[]
  amounts?:       BigInt[]
  text?:          string
  isQuote?:       boolean
}

/**
 * natstat: build the EIP-712 payload, mapping string→enum and inlining CLIENT_ID
 */
export function buildTypedData(params: ActionParams) {
  const code = ActionTypeMap[params.actionType]
  if (code === undefined) {
    throw new Error(`Unknown actionType "${params.actionType}"`)
  }
  // Clone the amounts array to avoid mutating the original
  const amounts = [...(params.amounts ?? [])];

  // For OTHER actions with amounts already provided, don't add validator tip
  // (the amount already includes the tip plus any additional costs)
  // For all other cases, add the validator tip (dynamic based on replication chains)
  if (params.actionType !== 'other' || amounts.length === 0) {
    amounts.push(getValidatorTip());
  }


  return {
    domain:      DOMAIN,
    types:       TYPES,
    primaryType: 'ActionData' as const,
    message: {
      actionType:      code,
      senderId:        params.senderId,
      receiverId:      params.receiverId      ?? 0,
      receiverCawonce: params.receiverCawonce ?? 0,
      clientId:        CLIENT_ID,
      cawonce:         params.cawonce         ?? 0,
      recipients:      params.recipients      ?? [],
      text:            params.text            ?? '',
      amounts:         amounts.map((amount) => amount.toString())
    }
  }
}

/**
 * natstat: sign with EIP-712 v4 and enqueue to our API
 */
export function useSignAndSubmitAction() {
  const { isConnected, address }      = useAccount()
  const { openConnectModal } = useConnectModal()
  const { switchChainAsync } = useSwitchChain()
  const hasActiveSession = useHasActiveSession()

  const { signTypedDataAsync } = useSignTypedData()
  const activeToken = useActiveToken();
  const cawonce       = activeToken?.cawonce;
  const bumpCawonce   = useTokenDataStore(s => s.bumpCawonce)
  const activeTokenId = activeToken?.tokenId

  // ⬇️ buffer for the action the user tried to do before they were connected
  const [pendingParams, setPendingParams] = useState<ActionParams | null>(null)
  const submittingRef = useRef(false) // Use ref to prevent re-entrancy

  const requestAndSubmit = useCallback(async (params: ActionParams) => {
    // Ensure we have an active token ID
    if (!activeTokenId) {
      throw new Error('No active token selected. Please connect your wallet.')
    }

    // Look up session key for the token owner (not the connected wallet).
    // This allows Quick Sign to work regardless of which wallet is connected,
    // since the session key was delegated by the token owner on-chain.
    // Read fresh from the store to avoid stale closures.
    const sessionStore0 = useSessionKeyStore.getState()
    const freshToken = Object.values(useTokenDataStore.getState().tokensByAddress)
      .flat().find(t => t.tokenId === activeTokenId)
    const tokenOwner = freshToken?.owner || activeToken?.owner
    const activeSession0 = tokenOwner
      ? sessionStore0.getActiveSessionForAddress(tokenOwner)
      : sessionStore0.getActiveSession()
    const actionCode0 = ActionTypeMap[params.actionType]
    const canUseSession0 = activeSession0 &&
      actionCode0 !== 6 && // exclude WITHDRAW
      (activeSession0.scopeBitmap & (1 << actionCode0)) !== 0

    if (!canUseSession0 && isConnected && activeToken?.owner && address) {
      if (activeToken.owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error('Wrong wallet connected. Please switch to the correct wallet.')
      }
    }

    // Prompt to enable Quick Sign if it's not active.
    // Only for action types that Quick Sign supports (codes 0-5: caw, like, unlike, recaw, follow, unfollow).
    // Tips (other=7) and withdrawals (6) always require wallet signing — don't prompt for those.
    const hasActiveSessions = Object.keys(sessionStore0.sessions).length > 0
    const suppressPrompt = sessionStore0.hasSeenPrompt && (sessionStore0.enabled || hasActiveSessions)
    const actionEligibleForQuickSign = actionCode0 !== 6 // everything except WITHDRAW
    if (!canUseSession0 && !suppressPrompt && actionEligibleForQuickSign) {
      const { useQuickSignPromptStore } = await import('~/components/modals/QuickSignModal')
      const promptStore = useQuickSignPromptStore.getState()
      if (promptStore.skipOnce) {
        // User chose "Sign Manually" — consume the flag and proceed with wallet signing
        useQuickSignPromptStore.setState({ skipOnce: false })
      } else {
        // Return a promise that resolves when the modal callback completes.
        // This way the caller sees the actual response, not null.
        return new Promise((resolve, reject) => {
          promptStore.show(async () => {
            try {
              const result = await requestAndSubmit(params)
              resolve(result)
            } catch (err) {
              reject(err)
            }
          })
        })
      }
    }

    // Check for minimum stake based on action type
    // Note: unlike and unfollow don't require stake checks
    const stakingKey = params.actionType === 'like' ? 'MIN_STAKE_LIKE' :
                      params.actionType === 'recaw' ? 'MIN_STAKE_REPOST' :
                      params.actionType === 'follow' ? 'MIN_STAKE_FOLLOW' :
                      params.actionType === 'caw' && params.receiverId ? 'MIN_STAKE_COMMENT' :
                      params.actionType === 'caw' ? 'MIN_STAKE_POST' :
                      params.actionType === 'other' ? 'MIN_STAKE_POST' :
                      null

    // Budget math:
    //   budget = onChainStake + pendingDepositAmount - sum(in-flight TxQueue costs)
    //
    // The pending deposit is treated as real spendable budget — it's in flight
    // on L1 and guaranteed to land on L2 unless the tx reverts. The pending
    // TxQueue spend (actions already queued but not yet confirmed on-chain)
    // is subtracted so each queued action "consumes" its own slice of the
    // budget, preventing the user from over-spending. When the action is
    // either confirmed or failed, the pending-spend store releases the slice.
    // Trigger a fresh on-chain token data fetch before reading the stake.
    // Fire-and-forget: we immediately read whatever is currently in the store,
    // but queue the refetch so subsequent action submissions see updated
    // values. We do NOT await because that would add visible latency to
    // every button click. For the mint&deposit-lands case this will self-heal
    // within one click-cycle if the first attempt is wrong.
    try { useTokenDataStore.getState().refetchTokenData?.() } catch {}

    // Self-heal any stale pendingSpend entries before reading the store.
    // getEffectiveStake has stale-cleanup logic that's only triggered when
    // called. Passing 1n guarantees the sweep runs (it's called for its
    // side effect, not its return value).
    usePendingSpendStore.getState().getEffectiveStake(1n)

    const pendingState = usePendingSpendStore.getState()

    // Read the freshest on-chain stake directly from the store rather than
    // the closure-captured activeToken, because activeToken can be stale after
    // the pending deposit lands: the Zustand subscription may not re-fire if
    // the stakedAmount update happens mid-action before this hook re-renders.
    // Pull the value imperatively so the stake check always uses current state.
    const freshTokenDataStore = useTokenDataStore.getState()
    const freshActiveToken = freshTokenDataStore.activeTokenId !== undefined
      ? Object.values(freshTokenDataStore.tokensByAddress).flat().find(t => t.tokenId === freshTokenDataStore.activeTokenId)
      : undefined
    const onChainStake = (freshActiveToken?.stakedAmount ?? activeToken?.stakedAmount) ?? 0n

    // Read pending deposit amount from localStorage (optimistic, written by
    // New.tsx / Staking.tsx / PostMintOnboarding.tsx on L1 tx success) and
    // from the backend (authoritative, written by the PATCH paths when the
    // user exists). Use the larger of the two to avoid double-counting when
    // both are in sync, but still cover the race window where only one has
    // updated yet.
    let localHintWei = 0n
    try {
      const hintRaw = localStorage.getItem(`caw:pendingDeposit:${activeTokenId}`)
      if (hintRaw) {
        const hint = JSON.parse(hintRaw)
        const age = Date.now() - (hint?.at ?? 0)
        if (hint?.amount && age < 30 * 60 * 1000) {
          try { localHintWei = BigInt(hint.amount) } catch {}
        }
      }
    } catch { /* ignore */ }

    let backendPendingWei = 0n
    try {
      const userRes = await apiFetch(`/api/users/by-token/${activeTokenId}`)
      if (userRes?.pendingDepositAmount) {
        try { backendPendingWei = BigInt(userRes.pendingDepositAmount) } catch {}
      }
    } catch (err) {
      console.warn('[Actions] Failed to fetch by-token for pending-deposit check:', err)
    }

    const pendingDepositWei = localHintWei > backendPendingWei ? localHintWei : backendPendingWei
    const userHasPendingDeposit = pendingDepositWei > 0n

    // Explicit signed math — do NOT route through getEffectiveStake because it
    // clamps (onChainStake - pendingSpend) to 0 when onChainStake is zero,
    // which hides the negative overspend and lets pendingSpend fall off the
    // books. We want: total = onChain + pendingDeposit - pendingSpend, clamped
    // at zero only after all three are summed.
    const totalBudgetSigned = onChainStake + pendingDepositWei - pendingState.pendingSpend
    const effectiveStake = totalBudgetSigned > 0n ? totalBudgetSigned : 0n

    console.log(`[StakeCheck] onChain=${onChainStake.toString()}, pendingDeposit=${pendingDepositWei.toString()}, pendingSpend=${pendingState.pendingSpend.toString()}, effectiveBudget=${effectiveStake.toString()}, pendingItems=${Object.keys(pendingState.pendingByTxQueue).length}`)

    if (stakingKey && !hasMinimumStake(effectiveStake, stakingKey)) {
      // Budget is insufficient even counting the pending deposit. Show the
      // insufficient-stake modal with the real remaining budget so the user
      // sees what they can/can't afford. If they still have budget for a
      // cheaper action (e.g. a like at 2k CAW instead of a follow at 30k),
      // the modal's "you have X remaining" messaging lets them pick one.
      const requiredAmount = getRequiredStake(stakingKey)
      const actionTypeForModal = getActionTypeForModal(params.actionType)
      useInsufficientStakeStore.getState().show(effectiveStake, requiredAmount, actionTypeForModal)
      return null
    }

    // Check if user is authenticated with this client on-chain (cached after first check).
    // Skip the modal entirely if we know a deposit is pending: minting through
    // this client auto-authenticates it, but the L1→L2 LZ message may not have
    // landed yet. The validator's waiting_for_deposit path will hold the action
    // until both the deposit and the client auth arrive.
    if (!clientAuthCache.get(activeTokenId) && !userHasPendingDeposit) {
      try {
        const isAuthed = await readContract(wagmiConfig, {
          address: CAW_NAMES_L2_ADDRESS,
          abi: cawNameL2Abi,
          functionName: 'authenticated',
          args: [CLIENT_ID, activeTokenId],
          chainId: baseSepolia.id,
        })
        if (isAuthed) {
          clientAuthCache.set(activeTokenId, true)
        } else {
          return new Promise((resolve, reject) => {
            useClientAuthStore.getState().show(activeTokenId, async () => {
              try {
                clientAuthCache.set(activeTokenId, true)
                const result = await requestAndSubmit(params)
                resolve(result)
              } catch (err) { reject(err) }
            })
          })
        }
      } catch (err) {
        console.warn('[Actions] Failed to check client auth status, proceeding:', err)
      }
    }

    // Wait for token data to be loaded (max 10 seconds)
    let attempts = 0;
    let currentToken;
    let currentCawonce;

    while (attempts < 100) { // 100 attempts * 100ms = 10 seconds max
      const state = useTokenDataStore.getState();

      // Search all addresses for the active token (supports session keys where
      // the connected wallet may differ from the token owner)
      for (const tokens of Object.values(state.tokensByAddress)) {
        const found = tokens.find(t => t.tokenId === activeTokenId);
        if (found) {
          currentToken = found;
          currentCawonce = found.cawonce;
          break;
        }
      }

      if (currentCawonce !== undefined && currentCawonce !== null) {
        break; // Token data is loaded
      }

      // Wait 100ms before trying again
      await new Promise(resolve => setTimeout(resolve, 100));
      attempts++;
    }

    // If still not loaded after waiting, throw error
    if (currentCawonce === undefined || currentCawonce === null) {
      console.error('Token data not loaded:', {
        activeTokenId,
        address,
        allAddresses: Object.keys(useTokenDataStore.getState().tokensByAddress),
        tokensByAddress: useTokenDataStore.getState().tokensByAddress,
        currentToken
      });
      throw new Error('Token data not loaded. Please refresh and try again.')
    }

    // Use explicitly provided cawonce if given (e.g., pre-allocated thread cawonces),
    // otherwise read from the store and bump it for the next caller.
    // When cawonce is pre-allocated, the caller already bumped the store past the
    // entire range, so we must NOT bump again here to avoid wasting cawonces.
    const useCawonce = params.cawonce ?? currentCawonce
    if (params.cawonce == null) {
      // Normal path: read from store, bump for next action
      console.log(`[signAndSubmit] Using cawonce=${useCawonce} for ${params.actionType}, bumping to ${currentCawonce + 1}`)
      bumpCawonce(activeTokenId)
    } else {
      console.log(`[signAndSubmit] Using pre-allocated cawonce=${useCawonce} for ${params.actionType} (store already bumped)`)
    }

    const { domain, types, primaryType, message } = buildTypedData({...params, cawonce: useCawonce})

    // Check for an active session key that covers this action type.
    // Look up by token owner so Quick Sign works regardless of connected wallet.
    const actionCode = ActionTypeMap[params.actionType]
    const sessionStore = useSessionKeyStore.getState()
    const activeSession = tokenOwner
      ? sessionStore.getActiveSessionForAddress(tokenOwner)
      : sessionStore.getActiveSession()

    // If Quick Sign is enabled but session expired, show renewal modal
    const rawSession = tokenOwner
      ? sessionStore.getSessionForAddress(tokenOwner)
      : sessionStore.getSession()
    if (sessionStore.enabled && !activeSession && rawSession) {
      return new Promise((resolve, reject) => {
        useQuickSignRenewStore.getState().show('expired', async () => {
          try {
            const result = await requestAndSubmit(params)
            resolve(result)
          } catch (err) { reject(err) }
        })
      })
    }

    const canUseSession = activeSession &&
      actionCode !== 6 && // exclude WITHDRAW
      (activeSession.scopeBitmap & (1 << actionCode)) !== 0

    // Fixed protocol costs per action type (whole CAW tokens) — must match CawActions.sol
    const ACTION_COSTS: Record<string, bigint> = {
      caw: 5000n, like: 2000n, recaw: 4000n, follow: 30000n,
      unlike: 0n, unfollow: 0n, other: 0n, withdraw: 0n,
    }

    // Check spend limit before signing with session key
    if (canUseSession) {
      const limit = BigInt(activeSession.spendLimit || '0')
      if (limit > 0n) {
        const spent = BigInt(rawSession?.spent || '0')
        const tip = getValidatorTip()
        const protocolCost = ACTION_COSTS[params.actionType] || 0n
        const totalCost = protocolCost + tip
        const remaining = limit - spent
        console.log(`[QuickSign] Spend limit: ${limit}, spent: ${spent}, remaining: ${remaining}, actionCost: ${protocolCost}, tip: ${tip}, totalCost: ${totalCost}`)
        if (spent + totalCost > limit) {
          return new Promise((resolve, reject) => {
            useQuickSignRenewStore.getState().show('spend_limit', async () => {
              try {
                const result = await requestAndSubmit(params)
                resolve(result)
              } catch (err) { reject(err) }
            })
          })
        }
      }
    }

    try {
      let signature: `0x${string}`

      if (canUseSession) {
        // Sign with session key — no wallet popup
        const sessionAccount = privateKeyToAccount(activeSession.privateKey)
        signature = await sessionAccount.signTypedData({
          domain,
          types:       { ActionData: TYPES.ActionData },
          primaryType,
          message,
        })
      } else {
        // Fall back to wallet signature (MetaMask popup)
        signature = await signTypedDataAsync({
          domain,
          types:       { ActionData: TYPES.ActionData },
          primaryType,
          message,
        })
      }

      // If there's a pending mint/deposit in localStorage for this sender, forward
      // the L1 tx hash so the server can park the action in waiting_for_deposit
      // until the DataCleaner watcher sees the deposit landed on L2. The server
      // never verifies the hash synchronously — presence alone is a hint, and
      // grief is bounded by a per-sender waiting-slot cap on the server side.
      let pendingDepositTxHash: string | undefined
      try {
        const hintRaw = localStorage.getItem(`caw:pendingDeposit:${activeTokenId}`)
        if (hintRaw) {
          const hint = JSON.parse(hintRaw)
          if (hint?.txHash && typeof hint.txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hint.txHash)) {
            // Hard expiry: 30 min stale hint is garbage, ignore and clear it
            const age = Date.now() - (hint.at ?? 0)
            if (age < 30 * 60 * 1000) {
              pendingDepositTxHash = hint.txHash
            } else {
              localStorage.removeItem(`caw:pendingDeposit:${activeTokenId}`)
            }
          }
        }
      } catch { /* ignore */ }

      const response = await apiFetch('/api/actions', {
        method: 'POST',
        body: JSON.stringify({
          data: message, domain, types, signature,
          isQuote: params.isQuote || false,
          ...(pendingDepositTxHash ? { pendingDepositTxHash } : {}),
        })
      })

      // If the server returned auth data (passive auth), store it immediately
      if (response.auth) {
        const { sessionToken: newToken, authorizedTokenIds, authorizedAddresses, expiresAt } = response.auth
        const authState = useAuthStore.getState()
        if (authState.sessionToken && authState.sessionToken === newToken) {
          // Same session — just add the new authorizations
          authState.addAuthorization(authorizedTokenIds, authorizedAddresses)
        } else {
          // New session created by server
          authState.setSession(newToken, authorizedTokenIds, authorizedAddresses, expiresAt)
        }
      }

      // Record pending spend so subsequent actions see reduced effective stake
      if (response.txQueueId) {
        const actionCostWei: Record<string, bigint> = {
          caw: 5000n, like: 2000n, recaw: 4000n, follow: 30000n,
          unlike: 0n, unfollow: 0n, other: 0n, withdraw: 0n,
        }
        const costWholeTokens = (actionCostWei[params.actionType] || 0n) + getValidatorTip()
        const costWei = costWholeTokens * 10n**18n
        if (costWei > 0n) {
          usePendingSpendStore.getState().addPendingSpend(response.txQueueId, costWei)
        }
      }

      // Broadcast to other instances as redundancy (fire-and-forget after 2s delay)
      // Other instances will either accept it or reject as duplicate — both are fine
      const actionPayload = JSON.stringify({ data: message, domain, types, signature })
      setTimeout(() => {
        try {
          const allHosts = useInstanceStore.getState().getApiHosts()
          const activeHost = useInstanceStore.getState().activeApiHost || API_HOST || ''
          const otherHosts = allHosts.filter((h: string) => h !== activeHost && h !== '')
          for (const host of otherHosts) {
            fetch(`${host}/api/actions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: actionPayload,
            }).catch(() => {}) // Silently ignore failures on redundant broadcasts
          }
          if (otherHosts.length > 0) {
            console.log(`[Actions] Broadcast to ${otherHosts.length} redundant instance(s)`)
          }
        } catch {}
      }, 2000)

      return response // Return the response which includes txQueueId
    } catch (error: any) {
      // If submission fails, we should ideally roll back the cawonce bump
      // but for now we'll leave it incremented to avoid conflicts
      console.error('Failed to submit action:', error)

      const errMsg = (error?.message || error?.shortMessage || '').toLowerCase()

      // Wrong chain — switch and retry
      if (errMsg.includes('chainid should be same') || errMsg.includes('chain mismatch')) {
        try {
          await switchChainAsync({ chainId: baseSepolia.id })
          return await requestAndSubmit(params)
        } catch {
          throw new Error('Please switch to the correct network and try again.')
        }
      }

      // Not authenticated with this client — show auth modal
      if (errMsg.includes('not authenticated')) {
        clientAuthCache.delete(activeTokenId!)
        return new Promise((resolve, reject) => {
          useClientAuthStore.getState().show(activeTokenId!, async () => {
            try {
              clientAuthCache.set(activeTokenId!, true)
              const result = await requestAndSubmit(params)
              resolve(result)
            } catch (err) { reject(err) }
          })
        })
      }

      // Detect session key spend limit or expiry errors from the contract/validator
      if (canUseSession && (errMsg.includes('spend limit') || errMsg.includes('session') || errMsg.includes('expired'))) {
        const reason = errMsg.includes('spend') ? 'spend_limit' : 'expired'
        return new Promise((resolve, reject) => {
          useQuickSignRenewStore.getState().show(reason, async () => {
            try {
              const result = await requestAndSubmit(params)
              resolve(result)
            } catch (err) { reject(err) }
          })
        })
      }

      throw error
    }
  }, [activeTokenId, address, signTypedDataAsync, bumpCawonce])

  // as soon as we become connected with the correct wallet, replay the pending action
  useEffect(() => {
    if (!isConnected || !pendingParams || !cawonce || submittingRef.current) {
      return
    }

    // Don't auto-submit if connected wallet doesn't match the active token's owner
    if (activeToken?.address && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
      return
    }

    // Set flag immediately to prevent re-execution
    submittingRef.current = true
    const params = pendingParams
    setPendingParams(null)

    // Submit the action
    requestAndSubmit(params).finally(() => {
      submittingRef.current = false
    })
  }, [isConnected, pendingParams, cawonce, requestAndSubmit, address, activeToken?.address])

  return async (params: ActionParams) => {
    // Session key active for this token's owner — skip wallet checks entirely
    if (hasActiveSession) {
      return await requestAndSubmit(params)
    }

    // 1) if wallet not yet connected, pop the connect modal
    if (!isConnected) {
      setPendingParams(params)
      openConnectModal?.()
      return null
    } else if (activeToken?.owner?.toLowerCase() !== address?.toLowerCase()) {
      console.error("That profile tokenId is not owned by your connected wallet")
      return null
    } else {
      return await requestAndSubmit(params)
    }
  }
}

