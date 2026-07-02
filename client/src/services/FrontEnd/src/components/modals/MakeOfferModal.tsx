import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, useBalance, usePublicClient } from 'wagmi'
import { useConnectModalBridge as useConnectModal } from '~/hooks/useConnectModalBridge'
import { formatEther, formatUnits, parseEther, parseUnits, erc20Abi, maxUint256, encodeFunctionData, type Address } from 'viem'
import ModalWrapper from './ModalWrapper'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { themeTextMuted, themeBgSubtle } from '~/utils/theme'
import { formatUsd } from '~/utils/numberFormat'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { usePriceStore, useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { sepolia } from 'wagmi/chains'
import { CAW_NAME_MARKETPLACE_ADDRESS, WETH_ADDRESS, CAW_ADDRESS, USDC_ADDRESS, USDT_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import UsernameSvg from '~/components/UsernameSvg'
import CopyAddressButton from '~/components/CopyAddressButton'

const PAYMENT_OPTIONS = [
  { value: '0x0000000000000000000000000000000000000000', label: 'ETH', decimals: 18 },
  { value: WETH_ADDRESS, label: 'WETH', decimals: 18 },
  { value: CAW_ADDRESS, label: 'CAW', decimals: 18 },
  { value: USDC_ADDRESS, label: 'USDC', decimals: 6 },
  { value: USDT_ADDRESS, label: 'USDT', decimals: 6 },
]

const DURATION_OPTIONS = [
  { labelKey: 'make_offer.duration.5min', seconds: 300 },
  { labelKey: 'make_offer.duration.1day', seconds: 86400 },
  { labelKey: 'make_offer.duration.3days', seconds: 259200 },
  { labelKey: 'make_offer.duration.7days', seconds: 604800 },
  { labelKey: 'make_offer.duration.14days', seconds: 1209600 },
  { labelKey: 'make_offer.duration.30days', seconds: 2592000 },
]

const MakeOfferModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const isOpen = useMarketplaceStore(s => s.makeOfferModal.isOpen)
  const tokenId = useMarketplaceStore(s => s.makeOfferModal.tokenId)
  const username = useMarketplaceStore(s => s.makeOfferModal.username)
  const close = useMarketplaceStore(s => s.closeMakeOffer)
  const triggerRefresh = useMarketplaceStore(s => s.triggerRefresh)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const activeToken = useActiveToken()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // Pop-B (passkey) users have no wagmi wallet — offers route through the sponsor
  // relay (SmartEOA.executeBatch) instead of a direct writeContract. The offer
  // value is self-funded from the EOA's own balance; the relayer fronts only gas.
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })

  const [selectedToken, setSelectedToken] = useState(PAYMENT_OPTIONS[0])
  const [amount, setAmount] = useState('')
  const [duration, setDuration] = useState(DURATION_OPTIONS[2]) // default 7 days
  // Pop-B relay flow state (mirrors CreateListingModal's popB* state).
  const [popBPending, setPopBPending] = useState(false)
  const [popBSuccess, setPopBSuccess] = useState(false)
  const [popBError, setPopBError] = useState<string | null>(null)
  const [eoaBalanceWei, setEoaBalanceWei] = useState<bigint | null>(null)

  const isEth = selectedToken.value === '0x0000000000000000000000000000000000000000'
  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Parse amount to wei
  const amountWei = useMemo(() => {
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return 0n
    try {
      return selectedToken.decimals === 18
        ? parseEther(amount)
        : parseUnits(amount, selectedToken.decimals)
    } catch {
      return 0n
    }
  }, [amount, selectedToken])

  // Check balances
  const { data: ethBalance } = useBalance({
    address,
    chainId: chains.l1.chainId,
    query: { enabled: !!address && isEth },
  })
  const { data: tokenBalance } = useReadContract({
    address: selectedToken.value as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address!],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !isEth },
  })

  // Balance shown + capped against: the Pop-B EOA's own balance (relay path funds
  // the offer from there), else the wagmi wallet balance for Pop-A/C.
  const wagmiBalance = isEth ? (ethBalance?.value ?? 0n) : (tokenBalance ?? 0n)
  const userBalance = isPopB ? (eoaBalanceWei ?? 0n) : wagmiBalance
  // Cap the offer at the funding balance. For Pop-B we always know the EOA balance
  // (read below); for Pop-A/C we only trust it once connected.
  const balanceKnown = isPopB ? eoaBalanceWei !== null : isConnected
  const insufficientBalance = balanceKnown && amountWei > 0n && amountWei > userBalance

  // Pop-B funding state. These passkey wallets are usually EMPTY — the user has never
  // touched crypto. When the wallet can't cover the selected token, the modal shifts
  // its emphasis from "what offer?" to "fund your wallet first".
  const eoaIsEmpty = isPopB && eoaBalanceWei !== null && eoaBalanceWei === 0n
  const eoaNeedsFunding = isPopB && eoaBalanceWei !== null && (eoaIsEmpty || insufficientBalance)
  const eoaExplorerUrl = eoaAccount ? `${sepolia.blockExplorers.default.url}/address/${eoaAccount}` : undefined

  // Read the Pop-B EOA's balance for the selected token (native ETH or ERC20) so the
  // balance display + cap work for passkey users, whose wagmi address is empty.
  useEffect(() => {
    if (!isPopB || !eoaAccount || !l1Client || !isOpen) { return }
    let cancelled = false
    const read = async () => {
      try {
        const bal = isEth
          ? await l1Client.getBalance({ address: eoaAccount as Address })
          : (await l1Client.readContract({
              address: selectedToken.value as Address, abi: erc20Abi,
              functionName: 'balanceOf', args: [eoaAccount as Address],
            })) as bigint
        if (!cancelled) setEoaBalanceWei(bal)
      } catch { if (!cancelled) setEoaBalanceWei(null) }
    }
    read()
    return () => { cancelled = true }
  }, [isPopB, eoaAccount, l1Client, isEth, selectedToken.value, isOpen])

  // Check ERC20 allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: selectedToken.value as `0x${string}`,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address && !isEth },
  })

  // Approve hook
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })

  // Offer hook
  const { writeContract: writeOffer, data: offerHash, isPending: isSubmitting, error: writeError, reset: resetOffer } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: offerHash })
  // Track that we've submitted — covers the gap between wallet confirm and receipt polling
  const isWaitingForReceipt = !!offerHash && !isSuccess && !writeError

  useEffect(() => {
    if (isApproveSuccess) refetchAllowance()
  }, [isApproveSuccess])

  // Notify the username owner when offer tx confirms
  useEffect(() => {
    if (!isSuccess || !offerHash) return
    triggerRefresh()
    // Send authenticated notification with the active tokenId
    if (activeToken?.tokenId) {
      apiFetch('/api/marketplace/offers/notify', {
        method: 'POST',
        body: JSON.stringify({ senderTokenId: activeToken.tokenId, txHash: offerHash }),
      }).catch(err => console.warn('[MakeOfferModal] Failed to send offer notification:', err))
    }
  }, [isSuccess])

  const needsApproval = !isEth && amountWei > 0n && (!allowance || allowance < amountWei)
  const hasApproval = isEth || (allowance && allowance >= amountWei) || isApproveSuccess

  const usdDisplay = useMemo(() => {
    if (!amount || parseFloat(amount) <= 0) return null
    const num = parseFloat(amount)
    let rate = 0
    if (selectedToken.label === 'ETH' || selectedToken.label === 'WETH') rate = ethPrice
    else if (selectedToken.label === 'CAW') rate = cawPrice
    else if (selectedToken.label === 'USDC' || selectedToken.label === 'USDT') return `~$${num.toFixed(2)}`
    if (!rate) return null
    const usd = num * rate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [amount, selectedToken, ethPrice, cawPrice])

  const handleApprove = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeApprove({
        address: selectedToken.value as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [CAW_NAME_MARKETPLACE_ADDRESS, maxUint256],
        chainId: chains.l1.chainId,
      })
    })
  }

  const handleSubmitOffer = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (tokenId === null || amountWei === 0n) return

      if (isEth) {
        writeOffer({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'createOfferETH',
          args: [tokenId, BigInt(duration.seconds)],
          value: amountWei,
          chainId: chains.l1.chainId,
        })
      } else {
        writeOffer({
          address: CAW_NAME_MARKETPLACE_ADDRESS,
          abi: cawProfileMarketplaceAbi,
          functionName: 'createOfferERC20',
          args: [tokenId, selectedToken.value as `0x${string}`, amountWei, BigInt(duration.seconds)],
          chainId: chains.l1.chainId,
        })
      }
    })
  }

  // Pop-B (passkey) offer via the sponsor relay. The offer value self-funds from the
  // EOA (createOfferETH{value} / ERC20 approve+transferFrom); the relayer fronts only
  // gas, repaid by an in-batch CAW.transfer or raw-ETH fee leg. Mirrors
  // CreateListingModal.handlePopBList.
  const handlePopBOffer = useCallback(async () => {
    if (!isPopB || !eoaAccount || tokenId === null || amountWei === 0n || !l1Client) return
    setPopBError(null)
    setPopBPending(true)
    try {
      // The offer value the relayer must NOT front (self-funded ETH only). ERC20
      // offers pull tokens via approve+transferFrom → nothing forwarded either.
      const forwardedValueWei = 0n
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        `/api/sponsor/execute-quote?forwardedValueWei=${forwardedValueWei}`,
      )
      const feeCaw = quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null
      const feeEth = BigInt(quote.minFeeEthWei)

      // Fresh balances at submit-time. The EOA must cover: the offer value (ETH offer
      // only) + a gas fee leg (CAW preferred, else ETH). Hard pre-flight so a doomed
      // batch never reaches relay simulation.
      const [cawBalNow, ethBalNow, tokenBalNow] = await Promise.all([
        l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount as Address }),
        isEth ? Promise.resolve(0n) : l1Client.readContract({ address: selectedToken.value as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
      ])
      setEoaBalanceWei(isEth ? ethBalNow : tokenBalNow)

      // The offer funds themselves must be present in the EOA.
      if (isEth) {
        if (ethBalNow < amountWei) throw new Error('INSUFFICIENT_OFFER_FUNDS')
      } else {
        if (tokenBalNow < amountWei) throw new Error('INSUFFICIENT_OFFER_FUNDS')
      }

      // Gas fee currency: CAW when the EOA holds enough, else ETH. For an ETH offer the
      // ETH fee leg must fit ALONGSIDE the offer value, so require ethBal ≥ offer+fee.
      const payInCaw = feeCaw != null && cawBalNow >= feeCaw
      const ethNeededForFee = feeEth + (isEth ? amountWei : 0n)
      const payInEth = ethBalNow >= ethNeededForFee
      if (!payInCaw && !payInEth) throw new Error('INSUFFICIENT_FEE_CAW')

      const calls: ExecCall[] = []
      // ERC20 offer: approve the marketplace to pull exactly the offer amount (bound
      // amount — the relay rejects an unbounded/mismatched approve).
      if (!isEth) {
        calls.push({
          to: selectedToken.value as Address,
          value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [CAW_NAME_MARKETPLACE_ADDRESS, amountWei] }),
        })
        calls.push({
          to: CAW_NAME_MARKETPLACE_ADDRESS,
          value: 0n,
          data: encodeFunctionData({
            abi: cawProfileMarketplaceAbi, functionName: 'createOfferERC20',
            args: [tokenId, selectedToken.value as `0x${string}`, amountWei, BigInt(duration.seconds)],
          }),
        })
      } else {
        calls.push({
          to: CAW_NAME_MARKETPLACE_ADDRESS,
          value: amountWei, // self-funded from the EOA's own ETH
          data: encodeFunctionData({
            abi: cawProfileMarketplaceAbi, functionName: 'createOfferETH',
            args: [tokenId, BigInt(duration.seconds)],
          }),
        })
      }
      // Gas fee leg: repay the relayer.
      if (payInCaw) {
        calls.push({
          to: CAW_ADDRESS as Address, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw!] }),
        })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }

      const relayTxHash = await smartEoaExecute(calls)
      setPopBSuccess(true)
      triggerRefresh()
      // Notify the owner. The relay txHash is the on-chain tx that carries the offer,
      // so the indexer-backed lookup resolves it the same as a direct-wallet offer.
      if (activeToken?.tokenId && relayTxHash) {
        apiFetch('/api/marketplace/offers/notify', {
          method: 'POST',
          body: JSON.stringify({ senderTokenId: activeToken.tokenId, txHash: relayTxHash }),
        }).catch(err => console.warn('[MakeOfferModal] offer notify failed:', err))
      }
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      let friendly: string
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) friendly = t('make_offer.tx_rejected')
      else if (/INSUFFICIENT_OFFER_FUNDS/i.test(raw)) friendly = t('make_offer.insufficient_balance')
      else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|FEE_TOO_LOW|transfer amount exceeds/i.test(raw)) friendly = t('make_offer.popb_insufficient_fee')
      else if (/RELAY_UNCONFIGURED|LOOKUP_UNAVAILABLE|PRICE_UNAVAILABLE|temporarily/i.test(raw)) friendly = t('make_offer.relay_unavailable')
      else friendly = t('make_offer.tx_failed')
      setPopBError(friendly)
    } finally {
      setPopBPending(false)
    }
  }, [isPopB, eoaAccount, tokenId, amountWei, l1Client, isEth, selectedToken.value, duration.seconds, smartEoaExecute, triggerRefresh, activeToken?.tokenId, t])

  const handleClose = () => {
    resetApprove()
    resetOffer()
    setAmount('')
    setSelectedToken(PAYMENT_OPTIONS[0])
    setDuration(DURATION_OPTIONS[2])
    setPopBError(null)
    setPopBSuccess(false)
    setPopBPending(false)
    setEoaBalanceWei(null)
    close()
  }

  if (!isOpen || tokenId === null) return null

  // Numeric balance in whole token units.
  const balanceNum = (bal: bigint, dec: number): number =>
    parseFloat(dec === 18 ? formatEther(bal) : formatUnits(bal, dec))

  // Display balance per token: ETH/WETH show up to 6 decimals when > 0 (2 when
  // exactly zero, so "0.00" reads cleanly); CAW shows no decimals; stablecoins 2.
  const fmtBalance = (bal: bigint, dec: number) => {
    const num = balanceNum(bal, dec)
    if (selectedToken.label === 'CAW') return num.toLocaleString(undefined, { maximumFractionDigits: 0 })
    if (selectedToken.label === 'ETH' || selectedToken.label === 'WETH') {
      return num > 0
        ? num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
        : '0.00'
    }
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  // USD value of a token balance, or null when no price is available.
  const balanceUsd = (bal: bigint, dec: number): string | null => {
    const num = balanceNum(bal, dec)
    let rate = 0
    if (selectedToken.label === 'ETH' || selectedToken.label === 'WETH') rate = ethPrice
    else if (selectedToken.label === 'CAW') rate = cawPrice
    else if (selectedToken.label === 'USDC' || selectedToken.label === 'USDT') rate = 1
    if (!rate) return null
    return formatUsd(num * rate)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth={(isSuccess || popBSuccess) ? 'max-w-[420px]' : 'max-w-[480px]'} usePortal zIndex={9999}>
      <div className="p-6">
        {(isSuccess || popBSuccess) ? (
          <div className="text-center py-6">
            <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-4 ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <svg className={`w-7 h-7 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('make_offer.success.title')}</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              {t('make_offer.success.line_before')}{amount} {selectedToken.label}{t('make_offer.success.line_middle')}<span className="font-semibold">@{username}</span>{t('make_offer.success.line_after')}
            </p>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              {t('make_offer.done')}
            </button>
          </div>
        ) : (
          <>
            <div className="flex justify-end mb-1">
              <button
                onClick={handleClose}
                className={`p-1 rounded-full transition-colors cursor-pointer ${
                  isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <h2 className={`text-xl font-bold text-center ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('make_offer.title')}
            </h2>
            <p className={`text-sm text-center mb-4 ${themeTextMuted(isDark)}`}>
              {t('make_offer.subtitle_line1')}<br />{t('make_offer.subtitle_line2')}
            </p>

            {/* Username SVG */}
            <div className="flex justify-center mb-4">
              <div className="w-full max-w-[210px]">
                <UsernameSvg username={username || ''} />
              </div>
            </div>

            {/* Duration selector */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                {t('make_offer.duration_label')}
              </label>
              <div className="flex gap-2 flex-wrap">
                {DURATION_OPTIONS.map(opt => (
                  <button
                    key={opt.seconds}
                    onClick={() => setDuration(opt)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition cursor-pointer ${
                      duration.seconds === opt.seconds
                        ? 'bg-yellow-500 text-black'
                        : isDark
                          ? 'bg-white/10 text-white hover:bg-white/20'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {t(opt.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            {/* Payment token selector */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                {t('make_offer.payment_token_label')}
              </label>
              <div className="flex gap-2 flex-wrap">
                {PAYMENT_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => { setSelectedToken(opt); resetApprove(); resetOffer() }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition cursor-pointer ${
                      selectedToken.value === opt.value
                        ? 'bg-yellow-500 text-black'
                        : isDark
                          ? 'bg-white/10 text-white hover:bg-white/20'
                          : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount input */}
            <div className="mb-4">
              <label className={`block text-sm font-medium mb-1.5 ${isDark ? 'text-white' : 'text-gray-700'}`}>
                {t('make_offer.amount_label')}
              </label>
              <div className="relative">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.0"
                  className={`w-full px-4 py-3 pr-16 rounded-xl text-base transition ${
                    isDark
                      ? 'bg-white/5 border border-white/10 text-white placeholder-white/30 focus:border-yellow-500/50'
                      : 'bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
                  } focus:outline-none`}
                />
                <span className={`absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium ${themeTextMuted(isDark)}`}>
                  {selectedToken.label}
                </span>
              </div>
              {usdDisplay && (
                <p className={`text-xs mt-1 ${themeTextMuted(isDark)}`}>{usdDisplay}</p>
              )}
            </div>

            {/* Pop-B (passkey) wallet callout. These users are crypto-new; make it
                explicit WHERE the offer comes from and that they must fund THAT wallet.
                Emphasised (amber card) when the wallet can't cover the offer. */}
            {isPopB && eoaAccount && (
              <div className={`p-3 rounded-xl mb-4 text-sm border ${
                eoaNeedsFunding
                  ? (isDark ? 'bg-amber-500/10 border-amber-500/30' : 'bg-amber-50 border-amber-200')
                  : (isDark ? 'bg-white/[0.04] border-white/10' : 'bg-black/[0.03] border-black/10')
              }`}>
                <div className={`${themeTextMuted(isDark)} mb-1`}>{t('make_offer.popb.wallet_label')}</div>
                {/* Address on its own line — colored, linked to the explorer, copyable. */}
                <div className="flex items-center gap-1 flex-wrap">
                  <a
                    href={eoaExplorerUrl} target="_blank" rel="noopener noreferrer"
                    className={`font-mono text-xs break-all hover:underline ${isDark ? 'text-yellow-400' : 'text-yellow-700'}`}
                  >
                    {eoaAccount}
                  </a>
                  <CopyAddressButton address={eoaAccount} iconOnly />
                </div>
                {eoaBalanceWei !== null && (
                  <div className="flex justify-between mt-2">
                    <span className={themeTextMuted(isDark)}>{t('make_offer.your_balance')}</span>
                    <span className={insufficientBalance ? (isDark ? 'text-red-400' : 'text-red-500') : (isDark ? 'text-white' : 'text-gray-900')}>
                      {fmtBalance(userBalance, selectedToken.decimals)} {selectedToken.label}
                      {balanceUsd(userBalance, selectedToken.decimals) && (
                        <span className={themeTextMuted(isDark)}> ({balanceUsd(userBalance, selectedToken.decimals)})</span>
                      )}
                    </span>
                  </div>
                )}
                {eoaNeedsFunding && (
                  <p className={`mt-2 text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                    {eoaIsEmpty
                      ? t('make_offer.popb.fund_empty', { token: selectedToken.label })
                      : t('make_offer.popb.fund_more', { token: selectedToken.label })}
                  </p>
                )}
              </div>
            )}

            {/* Pop-A/C balance info (wagmi wallet). */}
            {!isPopB && isConnected && (
              <div className={`p-3 rounded-xl ${themeBgSubtle(isDark)} text-sm mb-4`}>
                <div className="flex justify-between">
                  <span className={themeTextMuted(isDark)}>{t('make_offer.your_balance')}</span>
                  <span className={insufficientBalance ? (isDark ? 'text-red-400' : 'text-red-500') : (isDark ? 'text-white' : 'text-gray-900')}>
                    {fmtBalance(userBalance, selectedToken.decimals)} {selectedToken.label}
                    {balanceUsd(userBalance, selectedToken.decimals) && (
                      <span className={themeTextMuted(isDark)}> ({balanceUsd(userBalance, selectedToken.decimals)})</span>
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Non-Pop-B insufficient banner (Pop-B gets the funding callout above). */}
            {insufficientBalance && !isPopB && (
              <div className={`text-xs mb-4 p-3 rounded-lg text-center ${isDark ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-500'}`}>
                {t('make_offer.insufficient_balance')}
              </div>
            )}

            {/* Errors */}
            {(approveError || writeError || popBError) && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {popBError
                  ? popBError
                  : (approveError || writeError)?.message?.includes('User rejected')
                    ? t('make_offer.tx_rejected')
                    : t('make_offer.tx_failed')}
              </div>
            )}

            {/* Pop-B (passkey): single relay button — approve (ERC20) + createOffer +
                fee leg are bundled into one signed batch, so no separate approve step. */}
            {isPopB ? (
              <button
                onClick={() => { setPopBError(null); handlePopBOffer() }}
                disabled={popBPending || insufficientBalance || amountWei === 0n || eoaNeedsFunding}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
              >
                {popBPending ? t('make_offer.btn.submitting')
                  : eoaNeedsFunding ? t('make_offer.popb.fund_cta', { token: selectedToken.label })
                  : t('make_offer.btn.submit_offer')}
              </button>
            ) : (
              <>
                {/* Approve button (ERC20 only) */}
                {needsApproval && !hasApproval && (
                  <button
                    onClick={() => { if (approveError) resetApprove(); handleApprove() }}
                    disabled={isApproving || isApproveConfirming || isSwitchingChain}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mb-2"
                  >
                    {needsChainSwitch ? (isSwitchingChain ? t('make_offer.btn.switching') : t('make_offer.btn.switch_network'))
                      : isApproving ? t('make_offer.btn.confirm_in_wallet')
                      : isApproveConfirming ? t('make_offer.btn.approving')
                      : t('make_offer.btn.approve_token', { token: selectedToken.label })}
                  </button>
                )}

                {/* Submit offer button */}
                {(isEth || hasApproval) && (
                  <button
                    onClick={() => { if (writeError) resetOffer(); handleSubmitOffer() }}
                    disabled={isSubmitting || isWaitingForReceipt || isSwitchingChain || insufficientBalance || amountWei === 0n}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
                  >
                    {needsChainSwitch ? (isSwitchingChain ? t('make_offer.btn.switching') : t('make_offer.btn.switch_network'))
                      : isSubmitting ? t('make_offer.btn.confirm_in_wallet')
                      : isWaitingForReceipt ? t('make_offer.btn.submitting')
                      : t('make_offer.btn.submit_offer')}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </ModalWrapper>
  )
}

export default MakeOfferModal
