/**
 * Wallet.tsx — /wallet page
 *
 * Shows the connected wallet's ETH balance, CAW wallet balance, staked CAW,
 * and withdrawable CAW. Mounts <WithdrawForm /> for L1 CAW withdrawal.
 *
 * Pop A: standard wagmi-connected address.
 * Pop B: passkey EOA address sourced from useWalletPopulation.
 */

import React from 'react'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { erc20Abi, formatEther, formatUnits } from 'viem'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi } from '~/../../../abi/generated'
import { CLIENT_ID } from '~/api/actions'
import { chains } from '~/config/chains'
import { WithdrawForm } from '~/components/WithdrawForm'
import { useTheme } from '~/hooks/useTheme'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { formatUnitsCompact } from '~/utils'
import { useT } from '~/i18n/I18nProvider'

const Wallet = () => {
  const t = useT()
  const { isDark } = useTheme()
  const { address: wagmiAddress } = useAccount()
  const { address: popAddress, population } = useWalletPopulation()
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  // Effective display address — Pop-B uses the EOA even without wagmi connection
  const displayAddress = popAddress ?? wagmiAddress

  // ETH balance on L1
  const { data: ethBalance, refetch: refetchEth } = useBalance({
    address: displayAddress,
    chainId: chains.l1.chainId,
    query: { enabled: !!displayAddress },
  })

  // CAW wallet balance on L1
  const { data: cawBalance, refetch: refetchCaw } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    chainId: chains.l1.chainId,
    functionName: 'balanceOf',
    args: [displayAddress!],
    query: { enabled: !!displayAddress },
  })

  // Staking / withdrawable data reuse from activeToken (same source as Staking.tsx)
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const stakedWei = activeToken?.stakedAmount ?? 0n
  const withdrawableWei = activeToken?.withdrawable ?? 0n

  // Withdrawable amount on-chain (confirmatory read — falls back to tokenDataStore above)
  const { data: onChainWithdrawable } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    chainId: chains.l1.chainId,
    functionName: 'withdrawable',
    args: [Number(tokenId ?? 0)],
    query: { enabled: !!tokenId && !!displayAddress },
  })

  // Use on-chain read when available, otherwise fall back to store value
  const effectiveWithdrawable = onChainWithdrawable != null
    ? (onChainWithdrawable as bigint)
    : withdrawableWei

  const handleWithdrawSuccess = () => {
    refetchEth()
    refetchCaw()
    refetchTokenData?.()
  }

  const strongClass = isDark ? 'text-white' : 'text-black'
  const mutedClass = isDark ? 'text-gray-400' : 'text-gray-600'
  const cardClass = `rounded-lg border px-4 py-3 transition-all duration-300 ${
    isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
  }`

  return (
    <div className="max-w-2xl mx-auto px-6 py-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className={`text-2xl font-bold ${strongClass}`}>{t('wallet.title')}</h1>
        {displayAddress && (
          <p className={`text-xs font-mono mt-1 break-all ${mutedClass}`}>{displayAddress}</p>
        )}
        {population !== 'none' && (
          <span className={`inline-block mt-2 text-xs px-2 py-0.5 rounded-full font-medium ${
            isDark ? 'bg-white/10 text-gray-300' : 'bg-gray-100 text-gray-600'
          }`}>
            {t('wallet.population_label', { pop: population })}
          </span>
        )}
      </div>

      {/* Balance cards */}
      <div className="grid grid-cols-2 gap-4 mb-8">
        {/* ETH balance */}
        <div className={cardClass}>
          <div className={`text-xs ${mutedClass} mb-1`}>{t('wallet.eth_balance')}</div>
          <div className={`text-xl font-bold ${strongClass}`}>
            {ethBalance
              ? `${parseFloat(formatEther(ethBalance.value)).toFixed(4)} ETH`
              : '—'}
          </div>
        </div>

        {/* CAW wallet balance */}
        <div className={cardClass}>
          <div className={`text-xs ${mutedClass} mb-1`}>{t('wallet.caw_balance')}</div>
          <div className={`text-xl font-bold ${strongClass}`}>
            {cawBalance != null
              ? `${formatUnitsCompact(cawBalance as bigint, 18)} CAW`
              : '—'}
          </div>
        </div>

        {/* Staked CAW */}
        <div className={cardClass}>
          <div className={`text-xs ${mutedClass} mb-1`}>{t('wallet.staked_caw')}</div>
          <div className={`text-xl font-bold ${strongClass}`}>
            {activeToken
              ? `${formatUnitsCompact(stakedWei, 18)} CAW`
              : '—'}
          </div>
        </div>

        {/* Withdrawable CAW */}
        <div className={`${cardClass} ${effectiveWithdrawable > 0n
          ? isDark ? 'border-yellow-500/40 bg-yellow-900/10' : 'border-yellow-300 bg-yellow-50'
          : ''
        }`}>
          <div className={`text-xs ${mutedClass} mb-1`}>{t('wallet.withdrawable_caw')}</div>
          <div className={`text-xl font-bold ${
            effectiveWithdrawable > 0n
              ? isDark ? 'text-yellow-300' : 'text-yellow-700'
              : strongClass
          }`}>
            {activeToken
              ? `${formatUnitsCompact(effectiveWithdrawable, 18)} CAW`
              : '—'}
          </div>
        </div>
      </div>

      {/* Withdrawal section */}
      {activeToken && (
        <div className="mb-8">
          <h2 className={`text-lg font-semibold mb-4 ${strongClass}`}>
            {t('wallet.withdraw_section_title')}
          </h2>
          <WithdrawForm
            tokenId={tokenId}
            withdrawableWei={effectiveWithdrawable}
            onSuccess={handleWithdrawSuccess}
          />
        </div>
      )}

      {!activeToken && (
        <p className={`text-sm ${mutedClass}`}>{t('wallet.no_profile')}</p>
      )}

      {/* TODO(pop-B zap): ETH→CAW top-up via depositZap for Pop-B is non-trivial
          (requires relayed batch through useSmartEoaExecute matching the sponsor
          server's depositZap entry point). Pop-A depositZap is wired in Staking.tsx.
          Scaffold below is intentionally not implemented — see report for details. */}
      {/* <ZapSection population={population} address={displayAddress} /> */}

      {/* CLIENT_ID kept for future zap integration */}
      {void CLIENT_ID && null}
      {void formatUnits && null}
    </div>
  )
}

export default Wallet
