import { useEffect, useState, useRef, useCallback } from "react";
import { apiFetch }              from './client'
import { baseSepolia }           from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData, useAccount } from 'wagmi'
import type { TypedDataDomain, TypedDataField } from '@ethersproject/abstract-signer'
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { useClientConfigStore } from "~/store/clientConfigStore";
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'
import { hasMinimumStake, getRequiredStake, STAKING_REQUIREMENTS } from '~/constants/stakingRequirements'
import { InsufficientStakeError, getActionTypeForModal } from '~/errors/InsufficientStakeError'

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

    // Check for minimum stake based on action type
    // Note: unlike and unfollow don't require stake checks
    const stakingKey = params.actionType === 'like' ? 'MIN_STAKE_LIKE' :
                      params.actionType === 'recaw' ? 'MIN_STAKE_REPOST' :
                      params.actionType === 'follow' ? 'MIN_STAKE_FOLLOW' :
                      params.actionType === 'caw' && params.receiverId ? 'MIN_STAKE_COMMENT' :
                      params.actionType === 'caw' ? 'MIN_STAKE_POST' :
                      null

    if (stakingKey && !hasMinimumStake(activeToken?.stakedAmount, stakingKey)) {
      const requiredAmount = getRequiredStake(stakingKey)
      const actionTypeForModal = getActionTypeForModal(params.actionType)
      throw new InsufficientStakeError(activeToken?.stakedAmount, requiredAmount, actionTypeForModal)
    }

    // Wait for token data to be loaded (max 10 seconds)
    let attempts = 0;
    let currentToken;
    let currentCawonce;

    while (attempts < 100) { // 100 attempts * 100ms = 10 seconds max
      const state = useTokenDataStore.getState();

      // Try to find tokens for the address (case-insensitive)
      let tokensByAddress;
      if (address) {
        // Check all variations of address case
        tokensByAddress = state.tokensByAddress[address.toLowerCase()] ||
                         state.tokensByAddress[address] ||
                         Object.entries(state.tokensByAddress).find(([key]) =>
                           key.toLowerCase() === address.toLowerCase()
                         )?.[1];
      }

      if (tokensByAddress && tokensByAddress.length > 0) {
        currentToken = tokensByAddress.find(t => t.tokenId === activeTokenId);
        currentCawonce = currentToken?.cawonce;

        if (currentCawonce !== undefined && currentCawonce !== null) {
          break; // Token data is loaded
        }
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

    // Bump cawonce BEFORE submission to avoid conflicts with concurrent submissions
    bumpCawonce(activeTokenId)

    const { domain, types, primaryType, message } = buildTypedData({...params, cawonce: currentCawonce})

    try {
      const signature = await signTypedDataAsync({
        domain,
        types:       { ActionData: TYPES.ActionData },
        primaryType,               // 'ActionData'
        message
      })

      const response = await apiFetch('/api/actions', {
        method: 'POST',
        body: JSON.stringify({ data: message, domain, types, signature })
      })

      return response // Return the response which includes txQueueId
    } catch (error) {
      // If submission fails, we should ideally roll back the cawonce bump
      // but for now we'll leave it incremented to avoid conflicts
      console.error('Failed to submit action:', error)
      throw error
    }
  }, [activeTokenId, address, signTypedDataAsync, bumpCawonce])

  // as soon as we become connected, replay the pending action
  useEffect(() => {
    if (!isConnected || !pendingParams || !cawonce || submittingRef.current) {
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
  }, [isConnected, pendingParams, cawonce, requestAndSubmit])

  return async (params: ActionParams) => {
    // 1) if wallet not yet connected, pop the connect modal
    console.log('what',activeToken, address)
    if (!isConnected) {
      setPendingParams(params)
      openConnectModal?.()
      return null
    } else if (activeToken.address?.toLowerCase() !== address?.toLowerCase()) {
      console.error("That profile tokenId is not owned by your connected wallet")
      return null
    } else {
      return await requestAndSubmit(params)
    }
  }
}

