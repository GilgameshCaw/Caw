import React, { useCallback, useEffect, useState } from 'react'
import { useWriteContract, useReadContract, usePublicClient } from 'wagmi'
import ModalWrapper from './ModalWrapper'
import { useClientAuthStore } from '~/store/clientAuthStore'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { CLIENT_ID } from '~/api/actions'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { formatEther, erc20Abi, encodeFunctionData, type Address } from 'viem'
import { usePriceStore } from '~/store/tokenDataStore'
import NetworkFeesPanel from '~/components/NetworkFeesPanel'
import { apiFetch } from '~/api/client'

const ClientAuthModal: React.FC = () => {
  const { isOpen, tokenId, close } = useClientAuthStore()
  const { isDark } = useTheme()
  const t = useT()
  const ensureWallet = useEnsureWallet()
  const { writeContractAsync } = useWriteContract()
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Pop-B (passkey) relay path
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })

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
    if (isPopB) {
      handlePopBAuth()
      return
    }
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

  // Pop-B relay: authenticate (payable LZ fee self-funded) + fee leg.
  const handlePopBAuth = useCallback(async () => {
    if (!isPopB || !eoaAccount || !tokenId || !l1Client) return
    setIsPending(true)
    setError(null)
    try {
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        `/api/sponsor/execute-quote?forwardedValueWei=0`,
      )
      const feeCaw = quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null
      const feeEth = BigInt(quote.minFeeEthWei)

      const [cawBalNow, ethBalNow] = await Promise.all([
        l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount as Address }),
      ])
      const payInCaw = feeCaw != null && cawBalNow >= feeCaw
      const payInEth = ethBalNow >= totalFee + feeEth
      if (!payInCaw && !payInEth) throw new Error('INSUFFICIENT_FEE_CAW')

      const calls: ExecCall[] = [
        {
          to: CAW_NAMES_ADDRESS,
          value: totalFee, // self-funded LZ + auth fee
          data: encodeFunctionData({
            abi: cawProfileAbi,
            functionName: 'authenticate',
            args: [CLIENT_ID, tokenId, chains.l2.layerZero, 0n],
          }),
        },
      ]
      if (payInCaw) {
        calls.push({ to: CAW_ADDRESS as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw!] }) })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }
      await smartEoaExecute(calls)

      const cb = useClientAuthStore.getState().onSuccess
      useClientAuthStore.setState({ isOpen: false, tokenId: undefined, onSuccess: undefined, onCancel: undefined })
      if (cb) setTimeout(cb, 3000)
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) setError(t('client_auth.error.tx_rejected'))
      else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|FEE_TOO_LOW/i.test(raw)) setError(t('client_auth.popb_insufficient_fee'))
      else setError(t('client_auth.error.tx_failed'))
    } finally {
      setIsPending(false)
    }
  }, [isPopB, eoaAccount, tokenId, l1Client, totalFee, smartEoaExecute, t])

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

        <NetworkFeesPanel
          networkId={CLIENT_ID}
          show={['auth']}
          omitZeroRows
          className="mb-4"
        />

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
