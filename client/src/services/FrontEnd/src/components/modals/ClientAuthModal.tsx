import React, { useState } from 'react'
import { useWriteContract, useReadContract, useAccount, useSwitchChain, useChainId } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import ModalWrapper from './ModalWrapper'
import { useClientAuthStore } from '~/store/clientAuthStore'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { CLIENT_ID } from '~/api/actions'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { formatEther } from 'viem'

const ClientAuthModal: React.FC = () => {
  const { isOpen, tokenId, onSuccess, close } = useClientAuthStore()
  const { isDark } = useTheme()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const { writeContractAsync } = useWriteContract()
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wrongChain = isConnected && chainId !== chains.l1.chainId

  // Get LZ quote for the authenticate call (includes auth fee + LZ messaging fee)
  const { data: authQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    address: CAW_NAME_QUOTER_ADDRESS,
    chainId: chains.l1.chainId,
    functionName: 'authenticateQuote',
    args: [CLIENT_ID, tokenId ?? 0, chains.l2.layerZero, false],
    query: { enabled: isOpen && !!tokenId }
  })

  const totalFee = authQuote?.nativeFee ? BigInt(authQuote.nativeFee) : 0n

  const handleAuth = async () => {
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!tokenId) return

      setIsPending(true)
      setError(null)

      try {
        await writeContractAsync({
          address: CAW_NAMES_ADDRESS,
          abi: cawProfileAbi,
          functionName: 'authenticate',
          args: [CLIENT_ID, tokenId, chains.l2.layerZero, 0n],
          value: totalFee,
          chainId: chains.l1.chainId,
        })

        close()
        // Give LayerZero a moment to relay, then retry
        if (onSuccess) {
          setTimeout(onSuccess, 3000)
        }
      } catch (err: any) {
        if (err?.name === 'UserRejectedRequestError' || err?.code === 4001) {
          setError('Transaction rejected')
        } else {
          setError(err?.shortMessage || err?.message || 'Transaction failed')
        }
      } finally {
        setIsPending(false)
      }
    })
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={close} usePortal>
      <div className="p-6">
        <div className="flex items-center justify-center mb-4">
          <div className={`w-14 h-14 rounded-full flex items-center justify-center ${
            isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'
          }`}>
            <svg className="w-7 h-7 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
            </svg>
          </div>
        </div>

        <h2 className={`text-lg font-bold text-center mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
          Activate Your Account
        </h2>

        <p className={`text-sm text-center mb-4 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
          You need to register with this client before you can post, like, or follow.
          This is a one-time on-chain transaction on Ethereum.
        </p>

        {totalFee > 0n && (
          <div className={`text-center text-sm mb-4 px-3 py-2 rounded-lg ${
            isDark ? 'bg-white/5 text-white/50' : 'bg-gray-100 text-gray-500'
          }`}>
            Total cost: {formatEther(totalFee)} ETH
            <span className={`block text-xs mt-0.5 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
              Includes registration fee + network relay.
              Half of all fees are used to buy and burn CAW.
            </span>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-900/20 border border-red-700/50 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        <button
          onClick={handleAuth}
          disabled={isPending || !totalFee}
          className="w-full py-3 rounded-lg font-medium bg-yellow-500 hover:bg-yellow-600 text-black transition-colors disabled:opacity-50 cursor-pointer"
        >
          {isPending
            ? 'Confirming...'
            : wrongChain
            ? 'Switch to Ethereum'
            : 'Activate'}
        </button>

        <button
          onClick={close}
          className={`w-full mt-2 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
            isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          Cancel
        </button>
      </div>
    </ModalWrapper>
  )
}

export default ClientAuthModal
