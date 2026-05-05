import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiRefresh } from 'react-icons/hi'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useSwitchChain, useChainId } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { parseUnits, formatUnits } from 'viem'
import { useT } from '~/i18n/I18nProvider'
import { chains } from '~/config/chains'

// MintableCaw ABI - just the mint function
const mintableCawAbi = [
  {
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'mint',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const

const MINT_AMOUNTS = [
  { label: '1 Billion', value: '1000000000' },
  { label: '10 Billion', value: '10000000000' },
  { label: '100 Billion', value: '100000000000' },
  { label: '1 Trillion', value: '1000000000000' },
]

const FaucetPage: React.FC = () => {
  const t = useT()
  const { isDark } = useTheme()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const ensureWallet = useEnsureWallet()
  const currentChainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const [selectedAmount, setSelectedAmount] = useState(MINT_AMOUNTS[1].value)
  const [customAmount, setCustomAmount] = useState(MINT_AMOUNTS[1].value)
  const [useCustom, setUseCustom] = useState(false)

  const isOnCorrectChain = currentChainId === chains.l1.chainId

  const { writeContract, data: hash, isPending, error: writeError } = useWriteContract()

  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  })

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: CAW_ADDRESS,
    abi: mintableCawAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: chains.l1.chainId,
    query: {
      enabled: !!address
    }
  })

  const getMintAmount = () => {
    if (useCustom && customAmount) {
      return customAmount
    }
    return selectedAmount
  }

  const isValidAmount = (amount: string) => {
    if (!amount) return false
    // Check if it's a valid number (allows decimals)
    const num = parseFloat(amount)
    return !isNaN(num) && num > 0
  }

  const getDisplayAmount = () => {
    const amount = getMintAmount()
    const num = parseFloat(amount)
    if (isNaN(num)) return '0'
    if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`
    // For small numbers, show up to 4 decimal places if needed
    if (num < 1) return num.toFixed(Math.min(4, amount.split('.')[1]?.length || 0))
    return num.toLocaleString()
  }

  const handleMint = async () => {
    if (!address) return

    const amount = getMintAmount()
    if (!isValidAmount(amount)) return

    writeContract({
      address: CAW_ADDRESS,
      abi: mintableCawAbi,
      functionName: 'mint',
      args: [address, parseUnits(amount, 18)],
      chainId: chains.l1.chainId,
    })
  }

  const formatBalance = (bal: bigint | undefined) => {
    if (!bal) return '0'
    const num = Number(formatUnits(bal, 18))
    if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
    return num.toLocaleString()
  }

  return (
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/help/resources"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('faucet.title')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('faucet.subtitle')}
            </p>
          </div>
        </div>

        {/* Info Box */}
        <div className={`p-4 rounded-xl mb-6 ${
          isDark ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-yellow-50 border border-yellow-200'
        }`}>
          <p className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
            {t('faucet.info_before')}<strong>{t('faucet.info_strong')}</strong>{t('faucet.info_after')}
          </p>
        </div>

        {/* Balance */}
        {isConnected && (
          <div className={`p-4 rounded-xl mb-6 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  {t('faucet.balance_label')}
                </p>
                <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {formatBalance(balance)} mCAW
                </p>
              </div>
              <button
                onClick={() => refetchBalance()}
                className={`p-2 rounded-full transition-colors ${
                  isDark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-gray-200 text-gray-500'
                }`}
              >
                <HiRefresh className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {/* Mint Form */}
        <div className={`p-6 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('faucet.mint_form_title')}
          </h2>

          {/* Amount Selection */}
          <div className="mb-6">
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('faucet.select_amount')}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {MINT_AMOUNTS.map((amt) => (
                <button
                  key={amt.value}
                  onClick={() => {
                    setSelectedAmount(amt.value)
                    setCustomAmount(amt.value)
                    setUseCustom(false)
                  }}
                  className={`p-3 rounded-lg text-sm font-medium transition-colors ${
                    selectedAmount === amt.value && !useCustom
                      ? 'bg-yellow-500 text-black'
                      : isDark
                        ? 'bg-white/10 text-white hover:bg-white/20'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                  }`}
                >
                  {amt.label}
                </button>
              ))}
            </div>

            {/* Custom Amount */}
            <div className="mt-4">
              <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                {t('faucet.custom_amount')}
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={customAmount}
                  onChange={(e) => {
                    const val = e.target.value.replace(/[^0-9.]/g, '')
                    setCustomAmount(val)
                    if (val) setUseCustom(true)
                  }}
                  onFocus={() => customAmount && setUseCustom(true)}
                  placeholder={t('faucet.amount_placeholder')}
                  className={`flex-1 p-3 rounded-lg text-sm transition-colors outline-none ${
                    useCustom && customAmount
                      ? 'ring-2 ring-yellow-500'
                      : ''
                  } ${
                    isDark
                      ? 'bg-white/10 text-white placeholder-white/30'
                      : 'bg-gray-200 text-gray-900 placeholder-gray-400'
                  }`}
                />
                <span className={`p-3 text-sm font-medium ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                  mCAW
                </span>
              </div>
              <p className={`text-xs mt-1 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                {t('faucet.decimals_hint')}
              </p>
            </div>
          </div>

          {/* Mint Button */}
          <button
            onClick={() => ensureWallet({ chainId: chains.l1.chainId }, async () => { handleMint() })}
            disabled={isConnected && (isPending || isConfirming || !isValidAmount(getMintAmount()))}
            className="w-full py-3 px-4 bg-yellow-500 text-black font-semibold rounded-xl hover:bg-yellow-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {isPending ? t('marketplace.button.confirm_in_wallet') : isConfirming ? t('faucet.minting') : t('faucet.mint_button', { amount: getDisplayAmount() })}
          </button>

          {/* Status Messages */}
          {writeError && (
            <div className={`mt-4 p-3 rounded-lg ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
              <p className="text-sm">
                {writeError.message.includes('User rejected')
                  ? t('profile.error.tx_rejected')
                  : writeError.message.split('\n')[0].replace(/^Error:\s*/, '').slice(0, 100)}
              </p>
            </div>
          )}

          {isSuccess && (
            <div className={`mt-4 p-3 rounded-lg ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-600'}`}>
              <p className="text-sm">{t('faucet.success', { amount: getDisplayAmount() })}</p>
            </div>
          )}
        </div>

        {/* Contract Info */}
        <div className={`mt-6 p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <h3 className={`text-sm font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('faucet.contract_address')}
          </h3>
          <code className={`text-xs break-all ${isDark ? 'text-yellow-500' : 'text-yellow-700'}`}>
            {CAW_ADDRESS}
          </code>
          <p className={`text-xs mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
            {t('faucet.network')}
          </p>
        </div>
      </div>
  )
}

export default FaucetPage
