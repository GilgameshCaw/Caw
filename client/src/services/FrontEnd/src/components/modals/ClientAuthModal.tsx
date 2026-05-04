import React, { useEffect, useState } from 'react'
import { useWriteContract, useReadContract } from 'wagmi'
import ModalWrapper from './ModalWrapper'
import { useClientAuthStore } from '~/store/clientAuthStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { CLIENT_ID } from '~/api/actions'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { formatEther } from 'viem'
import { usePriceStore } from '~/store/tokenDataStore'

const ClientAuthModal: React.FC = () => {
  const { isOpen, tokenId, close } = useClientAuthStore()
  const { isDark } = useTheme()
  const t = useT()
  const ensureWallet = useEnsureWallet()
  const { writeContractAsync } = useWriteContract()
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset transient state every time the modal opens — otherwise a stale
  // "Transaction rejected" from the previous open lingers when the user
  // pops the modal again from a different action.
  useEffect(() => {
    if (isOpen) {
      setError(null)
      setIsPending(false)
    }
  }, [isOpen])

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
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const totalEth = Number(formatEther(totalFee))
  const totalUsd = totalEth * ethPrice
  const domainName = typeof window !== 'undefined' ? window.location.hostname : ''

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

        // Give LayerZero a moment to relay before firing onSuccess (which
        // will retry the original action) — succeed() reads onSuccess off
        // the store and clears state, so capture it for the delayed call.
        const cb = useClientAuthStore.getState().onSuccess
        useClientAuthStore.setState({ isOpen: false, tokenId: undefined, onSuccess: undefined, onCancel: undefined })
        if (cb) setTimeout(cb, 3000)
      } catch (err: any) {
        if (err?.name === 'UserRejectedRequestError' || err?.code === 4001) {
          setError(t('client_auth.error.tx_rejected'))
        } else {
          setError(err?.shortMessage || err?.message || t('client_auth.error.tx_failed'))
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
          {t('client_auth.title')}
        </h2>

        <p className={`text-sm text-center mb-4 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
          {t('client_auth.body', { domain: domainName || t('client_auth.this_client') })}
        </p>

        {totalFee > 0n && (
          <div className={`text-center mb-4 px-3 py-3 rounded-lg ${
            isDark ? 'bg-white/5' : 'bg-gray-100'
          }`}>
            <div className={`text-xs uppercase tracking-wide mb-1 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
              {t('client_auth.total_cost')}
            </div>
            <div className={`text-2xl font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {ethPrice > 0 ? `$${totalUsd.toFixed(2)}` : `${totalEth.toFixed(5)} ETH`}
            </div>
            {ethPrice > 0 && (
              <div className={`text-xs mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
                ~{totalEth.toFixed(5)} ETH
              </div>
            )}
            <span className={`block text-xs mt-2 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
              {t('client_auth.fee_breakdown')}
            </span>
            <span className={`block text-xs mt-1 ${isDark ? 'text-yellow-600/70' : 'text-yellow-700/70'}`}>
              {t('client_auth.burn_note')}
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
          {isPending ? t('client_auth.btn.confirming') : t('client_auth.btn.activate')}
        </button>

        <button
          onClick={close}
          className={`w-full mt-2 py-2 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
            isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'
          }`}
        >
          {t('client_auth.btn.cancel')}
        </button>
      </div>
    </ModalWrapper>
  )
}

export default ClientAuthModal
