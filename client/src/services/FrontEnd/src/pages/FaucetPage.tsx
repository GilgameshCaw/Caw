import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiRefresh } from 'react-icons/hi'
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { parseUnits, formatUnits } from 'viem'
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
  const { isDark } = useTheme()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const [selectedAmount, setSelectedAmount] = useState(MINT_AMOUNTS[1].value)

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

  const handleMint = async () => {
    if (!address) return

    writeContract({
      address: CAW_ADDRESS,
      abi: mintableCawAbi,
      functionName: 'mint',
      args: [address, parseUnits(selectedAmount, 18)],
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
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings/resources"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              Testnet Faucet
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Mint mCAW tokens for testing
            </p>
          </div>
        </div>

        {/* Info Box */}
        <div className={`p-4 rounded-xl mb-6 ${
          isDark ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-yellow-50 border border-yellow-200'
        }`}>
          <p className={`text-sm ${isDark ? 'text-yellow-200' : 'text-yellow-800'}`}>
            This faucet mints <strong>mCAW (Mintable CAW)</strong> tokens on Sepolia testnet.
            These tokens have no real value and are only for testing the CAW protocol.
          </p>
        </div>

        {/* Balance */}
        {isConnected && (
          <div className={`p-4 rounded-xl mb-6 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  Your mCAW Balance
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
            Mint mCAW
          </h2>

          {/* Amount Selection */}
          <div className="mb-6">
            <label className={`block text-sm font-medium mb-2 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              Select Amount
            </label>
            <div className="grid grid-cols-2 gap-2">
              {MINT_AMOUNTS.map((amt) => (
                <button
                  key={amt.value}
                  onClick={() => setSelectedAmount(amt.value)}
                  className={`p-3 rounded-lg text-sm font-medium transition-colors ${
                    selectedAmount === amt.value
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
          </div>

          {/* Mint Button */}
          {!isConnected ? (
            <button
              onClick={openConnectModal}
              className="w-full py-3 px-4 bg-yellow-500 text-black font-semibold rounded-xl hover:bg-yellow-400 transition-colors"
            >
              Connect Wallet
            </button>
          ) : (
            <button
              onClick={handleMint}
              disabled={isPending || isConfirming}
              className="w-full py-3 px-4 bg-yellow-500 text-black font-semibold rounded-xl hover:bg-yellow-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isPending ? 'Confirm in Wallet...' : isConfirming ? 'Minting...' : 'Mint mCAW'}
            </button>
          )}

          {/* Status Messages */}
          {writeError && (
            <div className={`mt-4 p-3 rounded-lg ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
              <p className="text-sm">Error: {writeError.message}</p>
            </div>
          )}

          {isSuccess && (
            <div className={`mt-4 p-3 rounded-lg ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-600'}`}>
              <p className="text-sm">Successfully minted {MINT_AMOUNTS.find(a => a.value === selectedAmount)?.label} mCAW!</p>
            </div>
          )}
        </div>

        {/* Contract Info */}
        <div className={`mt-6 p-4 rounded-xl ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
          <h3 className={`text-sm font-medium mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            Contract Address
          </h3>
          <code className={`text-xs break-all ${isDark ? 'text-yellow-500' : 'text-yellow-700'}`}>
            {CAW_ADDRESS}
          </code>
          <p className={`text-xs mt-2 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
            Network: Sepolia Testnet
          </p>
        </div>
      </div>
    </MainLayout>
  )
}

export default FaucetPage
