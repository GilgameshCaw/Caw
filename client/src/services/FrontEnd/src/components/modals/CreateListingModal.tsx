import React, { useState, useMemo, useCallback } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, useReadContract, usePublicClient } from 'wagmi'
import { useConnectModalBridge as useConnectModal } from '~/hooks/useConnectModalBridge'
import { parseEther, parseUnits, encodeFunctionData, erc20Abi, formatUnits, type Address } from 'viem'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { apiFetch } from '~/api/client'
import { useActiveToken } from '~/store/tokenDataStore'
import { Link } from 'react-router-dom'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton, themeInput, themeBorder } from '~/utils/theme'
import ThemedListbox from '~/components/forms/ThemedListbox'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { usePriceStore, useTokenDataStore } from '~/store/tokenDataStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_MARKETPLACE_ADDRESS, WETH_ADDRESS, CAW_ADDRESS, USDC_ADDRESS, USDT_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi } from '~/../../../abi/generated'
import { cawProfileMarketplaceAbi } from '~/../../../abi/generated'
import { useT } from '~/i18n/I18nProvider'

type ListingStep = 'type' | 'params' | 'approve' | 'confirm'

// LISTING_TYPES: built inside the component so labels/descs go through t().
// Defined separately as numeric values aren't user-facing.

const PAYMENT_OPTIONS = [
  { value: '0x0000000000000000000000000000000000000000', label: 'ETH', decimals: 18 },
  { value: WETH_ADDRESS, label: 'WETH', decimals: 18 },
  { value: CAW_ADDRESS, label: 'CAW', decimals: 18 },
  { value: USDC_ADDRESS, label: 'USDC', decimals: 6 },
  { value: USDT_ADDRESS, label: 'USDT', decimals: 6 },
]

// CAW burn cost schedule (before 10^18 multiplier) — mirrors CawProfileMinter
const MINT_COST: Record<number, number> = {
  1: 1_000_000_000_000,
  2: 240_000_000_000,
  3: 60_000_000_000,
  4: 6_000_000_000,
  5: 200_000_000,
  6: 20_000_000,
  7: 10_000_000,
}
const MINT_COST_DEFAULT = 1_000_000 // 8+ chars

function getMintCostCaw(nameLength: number): number {
  if (nameLength <= 0) return 0
  return MINT_COST[nameLength] ?? MINT_COST_DEFAULT
}

const CreateListingModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const LISTING_TYPES = [
    { value: 0, label: t('create_listing.type.fixed.label'), desc: t('create_listing.type.fixed.desc') },
    { value: 1, label: t('create_listing.type.dutch.label'), desc: t('create_listing.type.dutch.desc') },
    { value: 2, label: t('create_listing.type.english.label'), desc: t('create_listing.type.english.desc') },
  ]
  const isOpen = useMarketplaceStore(s => s.createListingModal.isOpen)
  const tokenId = useMarketplaceStore(s => s.createListingModal.tokenId)
  const username = useMarketplaceStore(s => s.createListingModal.username)
  const close = useMarketplaceStore(s => s.closeCreateListing)
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const ensureWallet = useEnsureWallet()
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const tokenOwner = useMemo(() => {
    for (const [addr, tokens] of Object.entries(tokensByAddress)) {
      if (tokens.some(t => t.tokenId === tokenId)) return addr.toLowerCase()
    }
    return null
  }, [tokensByAddress, tokenId])
  // Population-B (passkey) users have no wagmi wallet, so the wagmi `address`
  // check would always fail. They list via a relayed SmartEOA.executeBatch
  // (approve + createListing + CAW/ETH fee leg) signed by their passkey.
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const activeToken = useActiveToken()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  // Owner for Pop-B is the passkey EOA that owns this token. When listing your
  // own active profile, activeToken.owner is the EOA.
  const popBOwner = (isPopB ? (eoaAccount ?? activeToken?.owner)?.toLowerCase() : null) ?? null
  const isOwner = isPopB
    ? (!!popBOwner && !!tokenOwner && popBOwner === tokenOwner)
    : (!!address && !!tokenOwner && address.toLowerCase() === tokenOwner)

  // Separate write hooks for approve and listing
  const { writeContract: writeApprove, data: approveHash, isPending: isApproving, error: approveError, reset: resetApprove } = useWriteContract()
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess } = useWaitForTransactionReceipt({ hash: approveHash })
  const { writeContract: writeListing, data: listingHash, isPending: isSubmitting, error: writeError, reset: resetListing } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: listingHash })

  // Check if marketplace is approved to transfer NFTs
  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: 'isApprovedForAll',
    args: [address!, CAW_NAME_MARKETPLACE_ADDRESS],
    chainId: chains.l1.chainId,
    query: { enabled: !!address },
  })

  // Refetch approval status after successful approve tx
  React.useEffect(() => {
    if (isApproveSuccess) refetchApproval()
  }, [isApproveSuccess])

  // Trigger marketplace refresh after successful listing
  React.useEffect(() => {
    if (isSuccess) {
      // Small delay to let the indexer pick it up
      setTimeout(() => useMarketplaceStore.getState().triggerRefresh(), 3000)
    }
  }, [isSuccess])

  const [step, setStep] = useState<ListingStep>('type')
  const [listingType, setListingType] = useState(0)
  const [paymentToken, setPaymentToken] = useState(PAYMENT_OPTIONS[0].value)
  const [startPrice, setStartPrice] = useState('')
  const [endPrice, setEndPrice] = useState('')

  const getRateForToken = (tokenValue: string) => {
    const opt = PAYMENT_OPTIONS.find(o => o.value === tokenValue)
    if (!opt) return 0
    if (opt.label === 'ETH' || opt.label === 'WETH') return usePriceStore.getState().priceMap['ethereum'] ?? 0
    if (opt.label === 'CAW') return usePriceStore.getState().priceMap['a-hunters-dream'] ?? 0
    if (opt.label === 'USDC' || opt.label === 'USDT') return 1
    return 0
  }

  const formatConverted = (value: number, tokenValue: string) => {
    const opt = PAYMENT_OPTIONS.find(o => o.value === tokenValue)
    if (!opt) return String(value)
    if (opt.label === 'CAW') return Math.round(value).toString()
    if (opt.label === 'USDC' || opt.label === 'USDT') return value.toFixed(2)
    // ETH/WETH
    return value < 0.0001 ? value.toFixed(8) : value.toFixed(4)
  }

  const handleCurrencyChange = (newToken: string) => {
    const oldRate = getRateForToken(paymentToken)
    const newRate = getRateForToken(newToken)

    if (oldRate && newRate && startPrice) {
      const usd = parseFloat(startPrice) * oldRate
      setStartPrice(formatConverted(usd / newRate, newToken))
    }
    if (oldRate && newRate && endPrice) {
      const usd = parseFloat(endPrice) * oldRate
      setEndPrice(formatConverted(usd / newRate, newToken))
    }
    setPaymentToken(newToken)
  }
  const [durationHours, setDurationHours] = useState('24')

  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const [showMintCostTip, setShowMintCostTip] = useState(false)

  const mintCostUsd = useMemo(() => {
    if (!username || !cawPrice) return null
    const cawAmount = getMintCostCaw(username.length)
    const usd = cawAmount * cawPrice
    return usd < 0.01 ? '<$0.01' : `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [username, cawPrice])

  const usdRate = useMemo(() => {
    const selected = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
    if (!selected) return 0
    if (selected.label === 'ETH' || selected.label === 'WETH') return ethPrice
    if (selected.label === 'CAW') return cawPrice
    if (selected.label === 'USDC' || selected.label === 'USDT') return 1
    return 0
  }, [paymentToken, ethPrice, cawPrice])

  const formatUsd = (amount: string) => {
    const num = parseFloat(amount)
    if (!num || !usdRate) return null
    const usd = num * usdRate
    return usd < 0.01 ? '<$0.01' : `~$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  const currentRateLabel = useMemo(() => {
    const selected = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
    if (!selected || !usdRate) return null
    if (selected.label === 'CAW') {
      // Show how much CAW you get per $0.01
      const cawPerCent = 0.01 / usdRate
      return `$0.01 = ${cawPerCent.toLocaleString(undefined, { maximumFractionDigits: 1 })} CAW`
    }
    // ETH / WETH — show 1 token = $X
    return `1 ${selected.label} = $${usdRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }, [paymentToken, usdRate])

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  const handleClose = () => {
    setStep('type')
    setListingType(0)
    setStartPrice('')
    setEndPrice('')
    setDurationHours('24')
    resetApprove()
    resetListing()
    close()
  }

  const handleApprove = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      writeApprove({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'setApprovalForAll',
        args: [CAW_NAME_MARKETPLACE_ADDRESS, true],
        chainId: chains.l1.chainId,
      })
    })
  }

  const handleCreateListing = () => {
    ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (tokenId === null) return

      const duration = BigInt(parseInt(durationHours) * 3600)
      let startPriceWei: bigint
      let endPriceWei: bigint

      const selectedToken = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
      const decimals = selectedToken?.decimals ?? 18

      if (paymentToken === '0x0000000000000000000000000000000000000000') {
        startPriceWei = parseEther(startPrice)
        endPriceWei = listingType === 1 ? parseEther(endPrice) : 0n
      } else {
        startPriceWei = parseUnits(startPrice, decimals)
        endPriceWei = listingType === 1 ? parseUnits(endPrice, decimals) : 0n
      }

      writeListing({
        address: CAW_NAME_MARKETPLACE_ADDRESS,
        abi: cawProfileMarketplaceAbi,
        functionName: 'createListing',
        args: [tokenId, listingType, paymentToken as `0x${string}`, startPriceWei, endPriceWei, duration],
        chainId: chains.l1.chainId,
      })
    })
  }

  // ── Population-B (passkey) relayed listing ──────────────────────────────────
  // One passkey signature → SmartEOA.executeBatch of [setApprovalForAll?,
  // createListing, fee leg]. The relayer fronts L1 gas and is repaid in the same
  // signed batch — in CAW (CAW.transfer(relayer)) OR ETH (raw transfer to the
  // relayer), whichever the EOA can cover. No LZ fee (pure L1) → forwardedValue=0.
  const [popBPending, setPopBPending] = useState(false)
  const [popBSuccess, setPopBSuccess] = useState(false)
  const [popBError, setPopBError] = useState<string | null>(null)
  const [feeCawWei, setFeeCawWei] = useState<bigint | null>(null)
  const [feeEthWei, setFeeEthWei] = useState<bigint | null>(null)
  const [eoaCawWei, setEoaCawWei] = useState<bigint | null>(null)
  const [eoaEthWei, setEoaEthWei] = useState<bigint | null>(null)

  // Fetch both fee quotes (CAW + ETH) and both EOA balances when a Pop-B owner
  // reaches the confirm step, so we can pick whichever currency the wallet can
  // cover and gate on "enough of EITHER to pay the relayer".
  React.useEffect(() => {
    if (!isPopB || step !== 'confirm' || !isOwner || !eoaAccount || !l1Client) return
    let cancelled = false
    ;(async () => {
      try {
        const [quote, cawBal, ethBal] = await Promise.all([
          apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
            `/api/sponsor/execute-quote?forwardedValueWei=0`,
          ),
          l1Client.readContract({
            address: CAW_ADDRESS as Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [eoaAccount],
          }) as Promise<bigint>,
          l1Client.getBalance({ address: eoaAccount }),
        ])
        if (cancelled) return
        setFeeCawWei(quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null)
        setFeeEthWei(BigInt(quote.minFeeEthWei))
        setEoaCawWei(cawBal)
        setEoaEthWei(ethBal)
      } catch {
        if (!cancelled) { setFeeCawWei(null); setFeeEthWei(null); setEoaCawWei(null); setEoaEthWei(null) }
      }
    })()
    return () => { cancelled = true }
  }, [isPopB, step, isOwner, eoaAccount, l1Client])

  // Can the EOA cover the fee in CAW? in ETH? Prefer CAW when available.
  const canPayCaw = feeCawWei != null && eoaCawWei != null && eoaCawWei >= feeCawWei
  const canPayEth = feeEthWei != null && eoaEthWei != null && eoaEthWei >= feeEthWei
  const feeLoaded = feeEthWei != null && eoaEthWei != null // ETH quote is always available; gates "loaded"
  const needsTopUp = feeLoaded && !canPayCaw && !canPayEth
  const feeCawDisplay = feeCawWei != null ? Number(formatUnits(feeCawWei, 18)) : null
  const feeEthDisplay = feeEthWei != null ? Number(formatUnits(feeEthWei, 18)) : null

  const handlePopBList = useCallback(async () => {
    if (!isPopB || !eoaAccount || tokenId === null || !l1Client) return
    setPopBError(null)
    setPopBPending(true)
    try {
      // Fresh quote at submit time (price/gas can drift since the effect ran).
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        `/api/sponsor/execute-quote?forwardedValueWei=0`,
      )
      const feeCaw = quote.priceAvailable ? BigInt(quote.minFeeCawWei) : null
      const feeEth = BigInt(quote.minFeeEthWei)

      // Pick the fee currency: prefer CAW when the EOA holds enough, else ETH.
      // Hard pre-flight (not just the disabled button) so a race where the gate
      // data hadn't loaded can't submit a doomed batch that would only revert at
      // relay simulation (SIMULATION_FAILED).
      const [cawBalNow, ethBalNow] = await Promise.all([
        l1Client.readContract({
          address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount],
        }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount }),
      ])
      setEoaCawWei(cawBalNow); setEoaEthWei(ethBalNow)
      setFeeCawWei(feeCaw); setFeeEthWei(feeEth)
      const payInCaw = feeCaw != null && cawBalNow >= feeCaw
      const payInEth = ethBalNow >= feeEth
      if (!payInCaw && !payInEth) throw new Error('INSUFFICIENT_FEE_CAW')

      const selectedToken = PAYMENT_OPTIONS.find(o => o.value === paymentToken)
      const decimals = selectedToken?.decimals ?? 18
      const duration = BigInt(parseInt(durationHours) * 3600)
      const startPriceWei = paymentToken === '0x0000000000000000000000000000000000000000'
        ? parseEther(startPrice) : parseUnits(startPrice, decimals)
      const endPriceWei = listingType === 1
        ? (paymentToken === '0x0000000000000000000000000000000000000000'
            ? parseEther(endPrice) : parseUnits(endPrice, decimals))
        : 0n

      // Skip the approve call if the marketplace is already an operator for the EOA.
      const alreadyApproved = (await l1Client.readContract({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'isApprovedForAll',
        args: [eoaAccount, CAW_NAME_MARKETPLACE_ADDRESS],
      })) as boolean

      const calls: ExecCall[] = []
      if (!alreadyApproved) {
        calls.push({
          to: CAW_NAMES_ADDRESS,
          value: 0n,
          data: encodeFunctionData({
            abi: cawProfileAbi,
            functionName: 'setApprovalForAll',
            args: [CAW_NAME_MARKETPLACE_ADDRESS, true],
          }),
        })
      }
      calls.push({
        to: CAW_NAME_MARKETPLACE_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: cawProfileMarketplaceAbi,
          functionName: 'createListing',
          args: [tokenId, listingType, paymentToken as `0x${string}`, startPriceWei, endPriceWei, duration],
        }),
      })
      // Fee leg: repay the relayer (gas only, no forwarded value). Prefer CAW when
      // the EOA holds enough; otherwise a raw ETH transfer to the relayer (the
      // relay accepts either — CAW.transfer(relayer) OR to=relayer/empty-data/value).
      if (payInCaw) {
        calls.push({
          to: CAW_ADDRESS as Address,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [quote.relayer as Address, feeCaw!],
          }),
        })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }

      await smartEoaExecute(calls)
      setPopBSuccess(true)
      setTimeout(() => useMarketplaceStore.getState().triggerRefresh(), 3000)
    } catch (err: any) {
      // Translate relay/wallet errors into plain words — never surface a raw
      // "API 400: SIMULATION_FAILED" string. apiFetch throws "API <status>: <code>",
      // so match on the code substring after stripping the prefix.
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      let friendly: string
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) {
        friendly = t('profile.error.tx_rejected')
      } else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|transfer amount exceeds balance|FEE_TOO_LOW/i.test(raw)) {
        // Nearly always: the EOA can't cover the CAW fee leg (or lacks the NFT).
        friendly = t('create_listing.error.insufficient_fee')
      } else if (/LISTING_TOKEN_NOT_OWNED|not owned/i.test(raw)) {
        friendly = t('create_listing.error.not_owned')
      } else if (/RELAY_UNCONFIGURED|LOOKUP_UNAVAILABLE|temporarily/i.test(raw)) {
        friendly = t('create_listing.error.relay_unavailable')
      } else {
        friendly = t('marketplace.error.tx_failed')
      }
      setPopBError(friendly)
    } finally {
      setPopBPending(false)
    }
  }, [isPopB, eoaAccount, tokenId, l1Client, paymentToken, durationHours, startPrice, endPrice, listingType, smartEoaExecute, t])

  const inputClass = `w-full px-3 py-2 rounded-lg text-sm border outline-none transition ${themeInput(isDark)} ${themeBorder(isDark)}`

  // Format a raw number string with commas for display, preserving decimals
  const displayWithCommas = (val: string) => {
    if (!val) return ''
    const parts = val.split('.')
    const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.length > 1 ? `${intPart}.${parts[1]}` : intPart
  }

  // Strip commas from input to get raw number
  const handlePriceInput = (val: string, setter: (v: string) => void) => {
    const raw = val.replace(/,/g, '')
    if (raw === '' || /^\d*\.?\d*$/.test(raw)) setter(raw)
  }

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-[522px]" usePortal zIndex={9999}>
      <div className="p-6">
        {isSuccess ? (
          <div className="text-center py-6">
            <div className={`inline-flex items-center justify-center w-14 h-14 rounded-full mb-4 ${isDark ? 'bg-green-500/10' : 'bg-green-50'}`}>
              <svg className={`w-7 h-7 ${isDark ? 'text-green-400' : 'text-green-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>Listed Successfully!</h2>
            <p className={`text-sm mb-6 ${themeTextMuted(isDark)}`}>
              Your listing for <a href={`/users/${username}`} target="_blank" rel="noopener noreferrer" className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>@{username}</a> will appear on the marketplace shortly.
            </p>
            <button
              onClick={handleClose}
              className="px-6 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer"
            >
              Done
            </button>
          </div>
        ) : step === 'type' ? (
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
              List for Sale
            </h2>
            <p className={`text-sm text-center mb-6 ${themeTextMuted(isDark)}`}>
              List <span className="font-semibold">@{username}</span> on the marketplace.
            </p>
            <div className={`text-xs mb-4 p-3 rounded-lg ${isDark ? 'bg-yellow-500/10 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
              Any CAW staked on this username will transfer to the buyer along with the NFT.
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <button
                type="button"
                onClick={() => setStep('type')}
                className={`text-xs transition ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
              >
                &larr; Change listing type
              </button>
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
              {LISTING_TYPES[listingType].label}
            </h2>
            <p className={`text-sm text-center mb-6 ${themeTextMuted(isDark)}`}>{LISTING_TYPES[listingType].desc}</p>
          </>
        )}

        {/* Step: Choose listing type */}
        {step === 'type' && (
          <div className="space-y-3 mb-4">
            {LISTING_TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => { setListingType(t.value); setStep('params') }}
                className={`w-full text-left p-4 rounded-xl border transition cursor-pointer ${
                  isDark ? 'border-white/10 hover:border-yellow-500/30 hover:bg-white/5' : 'border-gray-200 hover:border-yellow-500 hover:bg-gray-50'
                }`}
              >
                <span className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{t.label}</span>
                <p className={`text-sm mt-0.5 ${themeTextMuted(isDark)}`}>{t.desc}</p>
              </button>
            ))}
          </div>
        )}

        {/* Step: Set parameters */}
        {step === 'params' && !isSuccess && (
          <div className="space-y-4 mb-4">
            <div>
              <label className={`block text-sm font-medium mb-1 ${themeTextSecondary(isDark)}`}>Payment Token</label>
              <ThemedListbox
                isDark={isDark}
                value={paymentToken}
                onChange={(v: string) => handleCurrencyChange(v)}
                options={PAYMENT_OPTIONS}
              />
            </div>

            <div>
              <div className="flex items-end justify-between mb-2">
                <div className="flex items-end gap-2">
                  <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>
                    {listingType === 0 ? t('create_listing.price') : listingType === 1 ? t('create_listing.start_price') : t('create_listing.minimum_bid')}
                  </label>
                  {mintCostUsd && (
                    <div className="relative">
                      <button
                        type="button"
                        onMouseEnter={() => setShowMintCostTip(true)}
                        onMouseLeave={() => setShowMintCostTip(false)}
                        onClick={() => setShowMintCostTip(p => !p)}
                        className={`rounded-full p-0.5 transition ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
                      >
                        <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                      </button>
                      {showMintCostTip && (
                        <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg text-xs whitespace-nowrap z-50 ${
                          isDark ? 'bg-gray-800 text-gray-200 border border-white/10' : 'bg-gray-900 text-white'
                        }`}>
                          Creating a {username?.length}-character username today costs {mintCostUsd}
                          <div className={`absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 ${
                            isDark ? 'bg-gray-800 border-r border-b border-white/10' : 'bg-gray-900'
                          }`} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {usdRate > 0 && (
                  <div className="flex gap-1.5">
                    {[10, 100, 1000, 10000].map(usd => {
                      const tokenAmount = usd / usdRate
                      const rounded = tokenAmount < 1 ? tokenAmount.toPrecision(3) : tokenAmount.toFixed(2)
                      const isActive = startPrice === rounded
                      return (
                        <button
                          key={usd}
                          type="button"
                          onClick={() => setStartPrice(rounded)}
                          className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                            isActive
                              ? 'bg-yellow-500 text-black border-yellow-500'
                              : isDark
                                ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                                : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                          }`}
                        >
                          ${usd.toLocaleString()}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
              <input
                type="text"
                inputMode="decimal"
                value={displayWithCommas(startPrice)}
                onChange={e => handlePriceInput(e.target.value, setStartPrice)}
                placeholder="0.0"
                className={inputClass}
              />
              <div className="flex items-center justify-between mt-1">
                <span className={`text-xs ${themeTextMuted(isDark)}`}>
                  {formatUsd(startPrice) ? `${formatUsd(startPrice)} USD` : '\u00A0'}
                </span>
                {currentRateLabel && (
                  <span className={`text-xs ${themeTextMuted(isDark)}`}>{currentRateLabel}</span>
                )}
              </div>
            </div>

            {listingType === 1 && (
              <div>
                <div className="flex items-end justify-between mb-2">
                  <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>Floor Price</label>
                  {usdRate > 0 && (
                    <div className="flex gap-1.5">
                      {[10, 100, 1000, 10000].map(usd => {
                        const tokenAmount = usd / usdRate
                        const rounded = tokenAmount < 1 ? tokenAmount.toPrecision(3) : tokenAmount.toFixed(2)
                        const isActive = endPrice === rounded
                        return (
                          <button
                            key={usd}
                            type="button"
                            onClick={() => setEndPrice(rounded)}
                            className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                              isActive
                                ? 'bg-yellow-500 text-black border-yellow-500'
                                : isDark
                                  ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                                  : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            ${usd.toLocaleString()}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={displayWithCommas(endPrice)}
                  onChange={e => handlePriceInput(e.target.value, setEndPrice)}
                  placeholder="0.0"
                  className={inputClass}
                />
                <div className="flex items-center justify-between mt-1">
                  <span className={`text-xs ${themeTextMuted(isDark)}`}>
                    {formatUsd(endPrice) ? `${formatUsd(endPrice)} USD` : '\u00A0'}
                  </span>
                  {currentRateLabel && (
                    <span className={`text-xs ${themeTextMuted(isDark)}`}>{currentRateLabel}</span>
                  )}
                </div>
              </div>
            )}

            <div>
              <div className="flex items-end justify-between mb-2">
                <label className={`text-sm font-medium ${themeTextSecondary(isDark)}`}>Duration <span className={themeTextMuted(isDark)}>(hours)</span></label>
                <div className="flex gap-1.5">
                  {[
                    { label: '1d', hours: 24 },
                    { label: '3d', hours: 72 },
                    { label: '7d', hours: 168 },
                    { label: '14d', hours: 336 },
                    { label: '30d', hours: 720 },
                  ].map(opt => {
                    const isActive = parseInt(durationHours) === opt.hours
                    return (
                      <button
                        key={opt.hours}
                        type="button"
                        onClick={() => setDurationHours(String(opt.hours))}
                        className={`px-2 py-1 rounded-md text-[11px] font-medium transition cursor-pointer border ${
                          isActive
                            ? 'bg-yellow-500 text-black border-yellow-500'
                            : isDark
                              ? 'border-white/10 text-gray-300 hover:border-white/20 hover:bg-white/5'
                              : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <input
                type="number"
                min="1"
                max="720"
                value={durationHours}
                onChange={e => setDurationHours(e.target.value)}
                placeholder={t('create_listing.custom_hours')}
                className={inputClass}
              />
            </div>

            {listingType === 2 && (
              <div className={`text-xs p-3 rounded-lg text-center ${isDark ? 'bg-blue-500/10 text-blue-400' : 'bg-blue-50 text-blue-700'}`}>
                If a bid is placed in the last 10 minutes,<br />the auction extends by 10 minutes so others can respond.
              </div>
            )}

            <div className={`text-xs text-center space-y-1 ${themeTextMuted(isDark)}`}>
              <p>If no one {listingType === 2 ? 'bids' : 'buys'}, the listing expires and you keep your profile.</p>
              <p className={`mt-2 ${isDark ? 'text-green-400' : 'text-green-600'}`}>0% marketplace fees — forever.</p>
            </div>

            {(approveError || writeError) && (
              <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">
                {(approveError || writeError)?.message?.includes('User rejected')
                  ? t('profile.error.tx_rejected')
                  : t('marketplace.error.tx_failed')}
              </div>
            )}

            {isConnected && !isOwner && (
              <div className={`p-3 rounded-lg text-sm text-center ${isDark ? 'bg-orange-500/10 text-orange-400' : 'bg-orange-50 text-orange-600'}`}>
                Switch to the wallet that owns this username to list it.
              </div>
            )}

            {/* ── Population-B (passkey) single-signature relayed listing ── */}
            {isPopB ? (
              <div className="space-y-3">
                {popBError && (
                  <div className="p-3 rounded-lg bg-red-500/10 text-red-500 text-sm text-center">{popBError}</div>
                )}
                {feeLoaded && !popBSuccess && (
                  <p className={`text-xs text-center ${themeTextMuted(isDark)}`}>
                    {canPayCaw && feeCawDisplay != null
                      ? t('create_listing.popb.fee_caw', { amount: feeCawDisplay.toLocaleString(undefined, { maximumFractionDigits: 2 }) })
                      : canPayEth && feeEthDisplay != null
                        ? t('create_listing.popb.fee_eth', { amount: feeEthDisplay.toLocaleString(undefined, { maximumFractionDigits: 6 }) })
                        : t('create_listing.popb.fee_either')}
                  </p>
                )}
                {needsTopUp && !popBSuccess && (
                  <div className={`p-3 rounded-lg text-sm text-center ${isDark ? 'bg-orange-500/10 text-orange-400' : 'bg-orange-50 text-orange-600'}`}>
                    {t('create_listing.popb.topup')}{' '}
                    <Link to="/staking" onClick={close} className="underline font-medium">{t('create_listing.popb.topup_link')}</Link>
                  </div>
                )}
                <div className="flex justify-center">
                  <button
                    onClick={handlePopBList}
                    disabled={!isOwner || popBPending || popBSuccess || needsTopUp || !feeLoaded || !startPrice || parseFloat(startPrice) <= 0 || (listingType === 1 && (!endPrice || parseFloat(endPrice) >= parseFloat(startPrice)))}
                    className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {popBSuccess ? t('marketplace.button.listed')
                      : popBPending ? t('marketplace.button.confirming')
                      : !feeLoaded ? t('marketplace.button.estimating_fee')
                      : t('create_listing.button.list')}
                  </button>
                </div>
              </div>
            ) : (<>
            {!isApproved && !isApproveSuccess && (
              <div className="flex justify-center">
                <button
                  onClick={() => { resetApprove(); handleApprove() }}
                  disabled={(isConnected && !isOwner) || isApproving || isApproveConfirming || isSwitchingChain}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-yellow-500"
                >
                  {!isOwner ? t('post_form.button.wrong_wallet')
                    : needsChainSwitch ? (isSwitchingChain ? t('staking.button.switching') : t('marketplace.button.switch_network'))
                    : isApproving ? t('marketplace.button.confirm_in_wallet')
                    : isApproveConfirming ? t('staking.button.approving')
                    : t('create_listing.button.approve')}
                </button>
              </div>
            )}

            {(isApproved || isApproveSuccess) && (
              <div className="flex justify-center">
                <button
                  onClick={() => { resetListing(); handleCreateListing() }}
                  disabled={(isConnected && !isOwner) || isSuccess || isSubmitting || isConfirming || isSwitchingChain || !startPrice || parseFloat(startPrice) <= 0 || (listingType === 1 && (!endPrice || parseFloat(endPrice) >= parseFloat(startPrice)))}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-400 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {!isOwner ? t('post_form.button.wrong_wallet')
                    : needsChainSwitch ? (isSwitchingChain ? t('staking.button.switching') : t('marketplace.button.switch_network'))
                    : isSubmitting ? t('marketplace.button.confirm_in_wallet')
                    : isConfirming ? t('marketplace.button.confirming')
                    : t('create_listing.button.list')}
                </button>
              </div>
            )}
            </>)}
          </div>
        )}
      </div>
    </ModalWrapper>
  )
}

export default CreateListingModal
