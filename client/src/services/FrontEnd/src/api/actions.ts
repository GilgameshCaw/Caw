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

const CAWONCE_STALE_MS = 10 * 60 * 1000 // 10 minutes

// Cache client auth status per tokenId to avoid repeated RPC calls
const clientAuthCache = new Map<number, boolean>()

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
 * Validator tip constants (in whole CAW tokens - contract multiplies by 10^18)
 *
 * Base tip: Default tip for validator to cover L2 gas costs
 * Per-chain tip: Additional tip per replication chain to cover LZ fees
 *
 * At ~500k CAW = $0.01, 1k CAW ≈ $0.00002 per action
 */
const BASE_VALIDATOR_TIP = BigInt(import.meta.env.VITE_VALIDATOR_TIP || "1000") // 1k CAW base

/** Additional tip per replication chain (to cover share of LZ fees) */
const TIP_PER_REPLICATION_CHAIN = BigInt(import.meta.env.VITE_TIP_PER_CHAIN || "500") // 500 CAW per chain

/**
 * Calculate the validator tip based on replication chain count
 * This compensates the validator for the LayerZero fees they pay for replication
 */
export function getValidatorTip(): bigint {
  const chainCount = useClientConfigStore.getState().getReplicationChainCount()
  return BASE_VALIDATOR_TIP + (TIP_PER_REPLICATION_CHAIN * BigInt(chainCount))
}

/** Legacy export for backwards compatibility */
export const VALIDATOR_TIP = BASE_VALIDATOR_TIP




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

    // Check wallet ownership — if no session key, the connected wallet must own the token
    const sessionStore0 = useSessionKeyStore.getState()
    const activeSession0 = sessionStore0.getActiveSession()
    const actionCode0 = ActionTypeMap[params.actionType]
    const canUseSession0 = activeSession0 &&
      actionCode0 <= 5 &&
      (activeSession0.scopeBitmap & (1 << actionCode0)) !== 0

    if (!canUseSession0 && isConnected && activeToken?.owner && address) {
      if (activeToken.owner.toLowerCase() !== address.toLowerCase()) {
        throw new Error('Wrong wallet connected. Please switch to the correct wallet.')
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

    // Use effective stake (staked - pending) to account for in-flight actions
    const effectiveStake = usePendingSpendStore.getState().getEffectiveStake(activeToken?.stakedAmount)
    if (stakingKey && !hasMinimumStake(effectiveStake, stakingKey)) {
      const requiredAmount = getRequiredStake(stakingKey)
      const actionTypeForModal = getActionTypeForModal(params.actionType)
      useInsufficientStakeStore.getState().show(effectiveStake, requiredAmount, actionTypeForModal)
      return null
    }

    // Check if user is authenticated with this client on-chain (cached after first check)
    if (!clientAuthCache.get(activeTokenId)) {
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
          useClientAuthStore.getState().show(activeTokenId, () => {
            clientAuthCache.set(activeTokenId, true) // Optimistic after successful auth tx
            requestAndSubmit(params)
          })
          return null
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

    // If cawonce hasn't been synced from chain in 10+ minutes, refresh it now
    const lastSync = useTokenDataStore.getState().lastCawonceSyncAt
    if (Date.now() - lastSync > CAWONCE_STALE_MS) {
      console.log('[Actions] Cawonce stale, refreshing from chain...')
      try {
        const onChainCawonce = await readContract(wagmiConfig, {
          address: CAW_ACTIONS_ADDRESS,
          abi: cawActionsAbi,
          functionName: 'nextCawonce',
          args: [activeTokenId!],
          chainId: baseSepolia.id,
        })
        const fresh = Number(typeof onChainCawonce === 'bigint' ? onChainCawonce : BigInt(onChainCawonce as any))
        console.log(`[Actions] On-chain cawonce: ${fresh}, local: ${currentCawonce}`)
        if (fresh > currentCawonce) {
          useTokenDataStore.getState().setCawonce(activeTokenId!, fresh)
          currentCawonce = fresh
        } else {
          // Update sync timestamp even if value didn't change
          useTokenDataStore.setState({ lastCawonceSyncAt: Date.now() })
        }
      } catch (err) {
        console.warn('[Actions] Failed to refresh cawonce from chain, using cached value:', err)
      }
    }

    // Bump cawonce BEFORE submission to avoid conflicts with concurrent submissions
    bumpCawonce(activeTokenId)

    const { domain, types, primaryType, message } = buildTypedData({...params, cawonce: currentCawonce})

    // Check for an active session key that covers this action type
    const actionCode = ActionTypeMap[params.actionType]
    const sessionStore = useSessionKeyStore.getState()
    const activeSession = sessionStore.getActiveSession()

    // If Quick Sign is enabled but session expired, show renewal modal
    if (sessionStore.enabled && !activeSession && sessionStore.session) {
      useQuickSignRenewStore.getState().show('expired', () => requestAndSubmit(params))
      return null
    }

    const canUseSession = activeSession &&
      actionCode <= 5 &&
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
        const spent = BigInt(sessionStore.session?.spent || '0')
        const tip = getValidatorTip()
        const protocolCost = ACTION_COSTS[params.actionType] || 0n
        const totalCost = protocolCost + tip
        const remaining = limit - spent
        console.log(`[QuickSign] Spend limit: ${limit}, spent: ${spent}, remaining: ${remaining}, actionCost: ${protocolCost}, tip: ${tip}, totalCost: ${totalCost}`)
        if (spent + totalCost > limit) {
          useQuickSignRenewStore.getState().show('spend_limit', () => requestAndSubmit(params))
          return null
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

      const response = await apiFetch('/api/actions', {
        method: 'POST',
        body: JSON.stringify({ data: message, domain, types, signature })
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
        useClientAuthStore.getState().show(activeTokenId!, () => {
          clientAuthCache.set(activeTokenId!, true)
          requestAndSubmit(params)
        })
        return null
      }

      // Detect session key spend limit or expiry errors from the contract/validator
      if (canUseSession && (errMsg.includes('spend limit') || errMsg.includes('session') || errMsg.includes('expired'))) {
        const reason = errMsg.includes('spend') ? 'spend_limit' : 'expired'
        useQuickSignRenewStore.getState().show(reason, () => requestAndSubmit(params))
        return null
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
    // Session key active — skip wallet checks entirely
    if (hasActiveSession) {
      return await requestAndSubmit(params)
    }

    // 1) if wallet not yet connected, pop the connect modal
    if (!isConnected) {
      setPendingParams(params)
      openConnectModal?.()
      return null
    } else if (activeToken?.address?.toLowerCase() !== address?.toLowerCase()) {
      console.error("That profile tokenId is not owned by your connected wallet")
      return null
    } else {
      return await requestAndSubmit(params)
    }
  }
}

