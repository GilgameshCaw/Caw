import { useEffect, useState } from "react";
import { apiFetch }              from './client'
import { baseSepolia }           from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData, useAccount } from 'wagmi'
import type { TypedDataDomain, TypedDataField } from '@ethersproject/abstract-signer'
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { CAW_ACTIONS_ADDRESS } from '~/../../../abi/addresses'

/** map human-friendly names to on-chain enum values */
const ActionTypeMap = {
  caw:      0,
  like:     1,
  unlike:   2,
  recaw:    3,
  follow:   4,
  unfollow: 5,
  withdraw: 6,
  other:     7
} as const

export type ActionTypeKey = keyof typeof ActionTypeMap

/** natstat: singleton client ID (one per front-end) */
const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)
const VALIDATOR_TIP = BigInt(import.meta.env.VITE_VALIDATOR_TIP)




/** natstat: EIP-712 domain */
const DOMAIN: TypedDataDomain = {
  name:               'Caw Protocol',
  version:            '1',
  chainId:            baseSepolia.id,
  verifyingContract:  CAW_ACTIONS_ADDRESS
}

/** natstat: EIP-712 types */
const TYPES: Record<string, TypedDataField[]> = {
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
    { name: 'amounts',         type: 'uint128[]'},
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
function buildTypedData(params: ActionParams) {
  const code = ActionTypeMap[params.actionType]
  if (code === undefined) {
    throw new Error(`Unknown actionType "${params.actionType}"`)
  }
  const amounts = params.amounts ?? [];
  amounts.push(BigInt(VALIDATOR_TIP));


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

  // as soon as we become connected, replay the pending action
  useEffect(() => {
    if (isConnected && pendingParams && cawonce != undefined) {
      // clear before firing to avoid loops
      const params = pendingParams
      setPendingParams(null)
      // now actually sign & submit
      void requestAndSubmit(params)
    }
  }, [isConnected, pendingParams, cawonce])

   async function requestAndSubmit(params: ActionParams) {
    // if (cawonce == 0) return console.error("NO CAWONCE");
    const { domain, types, primaryType, message } = buildTypedData({...params, cawonce})

    const signature = await signTypedDataAsync({
      domain,
      types:       { ActionData: TYPES.ActionData },
      primaryType,               // 'ActionData'
      message
    })

    await apiFetch('/api/actions', {
      method: 'POST',
      body: JSON.stringify({ data: message, signature })
    })
    bumpCawonce(activeTokenId)
   }


  return async (params: ActionParams) => {
    // 1) if wallet not yet connected, pop the connect modal
    console.log('what',activeToken, address)
    if (!isConnected) {
      setPendingParams(params)
      openConnectModal?.()
    } else if (activeToken.address != address) {
      console.error("That profile tokenId is not owned by your connected wallet")
      return
    } else await requestAndSubmit(params)
  }
}

