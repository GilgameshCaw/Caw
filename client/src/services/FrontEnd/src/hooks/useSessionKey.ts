import { useCallback } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSignTypedData, useWriteContract, usePublicClient } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { readContract } from '@wagmi/core'
import { wagmiConfig } from '~/config/Web3Provider'
import { useActiveToken } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { CAW_NAMES_L2_ADDRESS } from '~/../../../abi/addresses'
import { cawNameL2Abi } from '~/../../../abi/generated'

const SESSION_DURATION = 72 * 60 * 60 // 72 hours

// Default scope: CAW(0), LIKE(1), UNLIKE(2), RECAW(3), FOLLOW(4), UNFOLLOW(5)
const DEFAULT_SCOPE = 0x3F // 0b00111111

const SESSION_DOMAIN = {
  name:              'CawNameL2',
  version:           '1',
  chainId:           baseSepolia.id,
  verifyingContract: CAW_NAMES_L2_ADDRESS,
} as const

const DELEGATION_TYPES = {
  SessionDelegation: [
    { name: 'tokenId',        type: 'uint32'  },
    { name: 'sessionKey',     type: 'address' },
    { name: 'expiry',         type: 'uint64'  },
    { name: 'scopeBitmap',    type: 'uint8'   },
    { name: 'transferNonce',  type: 'uint32'  },
  ],
} as const

function splitSignature(sig: `0x${string}`) {
  const r = `0x${sig.slice(2, 66)}` as `0x${string}`
  const s = `0x${sig.slice(66, 130)}` as `0x${string}`
  const v = parseInt(sig.slice(130, 132), 16)
  return { v, r, s }
}

export function useCreateSession() {
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const activeToken = useActiveToken()
  const setSession = useSessionKeyStore(s => s.setSession)

  return useCallback(async () => {
    if (!activeToken?.tokenId) throw new Error('No active token')

    // Read current transfer nonce from chain
    const currentNonce = await readContract(wagmiConfig, {
      address:      CAW_NAMES_L2_ADDRESS,
      abi:          cawNameL2Abi,
      functionName: 'transferNonce',
      args:         [activeToken.tokenId],
      chainId:      baseSepolia.id,
    })

    const transferNonce = Number(currentNonce)
    const expiry = Math.floor(Date.now() / 1000) + SESSION_DURATION

    // Generate ephemeral keypair
    const privateKey = generatePrivateKey()
    const sessionAccount = privateKeyToAccount(privateKey)

    const message = {
      tokenId:       activeToken.tokenId,
      sessionKey:    sessionAccount.address,
      expiry:        BigInt(expiry),
      scopeBitmap:   DEFAULT_SCOPE,
      transferNonce,
    }

    // Owner signs the delegation (one wallet popup)
    const signature = await signTypedDataAsync({
      domain:      SESSION_DOMAIN,
      types:       DELEGATION_TYPES,
      primaryType: 'SessionDelegation',
      message,
    })

    const { v, r, s } = splitSignature(signature)

    // Register on-chain
    const hash = await writeContractAsync({
      address:      CAW_NAMES_L2_ADDRESS,
      abi:          cawNameL2Abi,
      functionName: 'registerSession',
      args:         [activeToken.tokenId, sessionAccount.address, BigInt(expiry), DEFAULT_SCOPE, v, r, s],
      chainId:      baseSepolia.id,
    })

    await publicClient?.waitForTransactionReceipt({ hash })

    // Store locally
    setSession(activeToken.tokenId, {
      privateKey,
      address: sessionAccount.address,
      expiry,
      scopeBitmap: DEFAULT_SCOPE,
    })

    return { address: sessionAccount.address, expiry }
  }, [activeToken?.tokenId, signTypedDataAsync, writeContractAsync, publicClient, setSession])
}

export function useRevokeSession() {
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()
  const activeToken = useActiveToken()
  const sessions = useSessionKeyStore(s => s.sessions)
  const clearSession = useSessionKeyStore(s => s.clearSession)

  return useCallback(async () => {
    if (!activeToken?.tokenId) throw new Error('No active token')

    const session = sessions[activeToken.tokenId]
    if (!session) throw new Error('No active session to revoke')

    const hash = await writeContractAsync({
      address:      CAW_NAMES_L2_ADDRESS,
      abi:          cawNameL2Abi,
      functionName: 'revokeSession',
      args:         [activeToken.tokenId, session.address],
      chainId:      baseSepolia.id,
    })

    await publicClient?.waitForTransactionReceipt({ hash })

    clearSession(activeToken.tokenId)
  }, [activeToken?.tokenId, sessions, writeContractAsync, publicClient, clearSession])
}
