import React, { useCallback, useState, useEffect } from 'react'
import { useAccount, useChainId, useSwitchChain, useWriteContract, useWaitForTransactionReceipt, usePublicClient } from 'wagmi'
import { readContract } from '@wagmi/core'
import { isAddress, formatEther, formatUnits, erc20Abi, encodeFunctionData, type Address } from 'viem'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeTextSecondary, themeTextMuted, themeBgSubtle, themeSecondaryButton } from '~/utils/theme'
import { useTransferModalStore } from '~/store/transferModalStore'
import { chains } from '~/config/chains'
import { CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { wagmiConfig } from '~/config/Web3Provider'
import { usePriceStore, useTokenDataStore } from '~/store/tokenDataStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { hasPasskeyCredentialForAddress, isPasskeyAddress } from '~/constants/passkeyStorage'
import { apiFetch } from '~/api/client'

const TransferNFTModal: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { isOpen, tokenId, username, close } = useTransferModalStore()
  const { address, isConnected } = useAccount()
  const ensureWallet = useEnsureWallet()
  const { isSigning } = useIdentitySigning()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitchingChain } = useSwitchChain()
  const { writeContract, data: hash, isPending: isSubmitting, error: writeError, reset } = useWriteContract()
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash })
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  // Pop-B (passkey) relay path
  const { population } = useWalletPopulation()
  const isPopB = population === 'B'
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  const [popBPending, setPopBPending] = useState(false)
  const [popBSuccess, setPopBSuccess] = useState(false)
  const [popBError, setPopBError] = useState<string | null>(null)

  const [recipient, setRecipient] = useState('')
  const [inputError, setInputError] = useState<string | null>(null)
  const [lzFee, setLzFee] = useState<bigint | null>(null)
  const [isQuoting, setIsQuoting] = useState(false)
  // Pop-B relay gas estimate (real per-batch estimateGas via /execute-estimate),
  // shown as a USD figure under the Transfer button. null until it resolves.
  const [relayFeeUsd, setRelayFeeUsd] = useState<number | null>(null)
  // Reactive gas-currency affordability (Pop-B). The relayer can be repaid in
  // CAW or ETH; we read both fees + both owner-EOA L1 balances up front so the
  // modal can say WHICH currency it'll use (or offer a toggle when BOTH work),
  // instead of silently picking one and only surfacing a vague "insufficient".
  const [feeCawWei, setFeeCawWei] = useState<bigint | null>(null)   // null = CAW price unavailable
  const [feeEthWei, setFeeEthWei] = useState<bigint | null>(null)
  const [eoaCawWei, setEoaCawWei] = useState<bigint | null>(null)
  const [eoaEthWei, setEoaEthWei] = useState<bigint | null>(null)
  // User's explicit gas-currency choice, only honoured when BOTH are affordable.
  const [gasCurrency, setGasCurrency] = useState<'CAW' | 'ETH' | null>(null)

  // Build the transfer batch's inner call (transferAndSync, self-funding its LZ
  // fee) WITHOUT the fee leg — shared by the gas estimate and handlePopBTransfer.
  const buildTransferCall = useCallback((): ExecCall | null => {
    if (tokenId === null || !recipient || !isAddress(recipient)) return null
    return {
      to: CAW_NAMES_ADDRESS,
      value: lzFee ?? 0n, // self-funded LZ fee
      data: encodeFunctionData({
        abi: cawProfileAbi,
        functionName: 'transferAndSync',
        args: [recipient as Address, BigInt(tokenId), chains.l1.layerZero, 0n],
      }),
    }
  }, [tokenId, recipient, lzFee])

  const isOnL1 = chainId === chains.l1.chainId
  const needsChainSwitch = isConnected && !isOnL1

  // Quote the LZ fee when recipient changes and is valid
  useEffect(() => {
    if (!isOpen || !recipient || !isAddress(recipient) || tokenId === null) {
      setLzFee(null)
      return
    }

    let cancelled = false
    setIsQuoting(true)

    readContract(wagmiConfig, {
      address: CAW_NAME_QUOTER_ADDRESS,
      abi: cawProfileQuoterAbi,
      functionName: 'syncTransferQuote',
      args: [tokenId, recipient as `0x${string}`, chains.l1.layerZero, false],
      chainId: chains.l1.chainId
    })
      .then((quote: any) => {
        if (!cancelled) {
          // Add 10% buffer for fee fluctuation
          const fee = (quote.nativeFee * 110n) / 100n
          setLzFee(fee)
        }
      })
      .catch((err) => {
        console.warn('[Transfer] Failed to quote LZ fee:', err)
        if (!cancelled) setLzFee(null)
      })
      .finally(() => {
        if (!cancelled) setIsQuoting(false)
      })

    return () => { cancelled = true }
  }, [isOpen, recipient, tokenId])

  // Pop-B: estimate the real relay gas for THIS transfer batch (via
  // /execute-estimate — per-call estimateGas at the execute chain's live gas
  // price, not the flat 800K × mainnet-gas ceiling that over-quotes) so we can
  // show a USD figure under the button. Re-runs when the recipient / LZ fee
  // settle. Non-fatal: on failure we just hide the estimate line.
  useEffect(() => {
    const clear = () => { setRelayFeeUsd(null); setFeeCawWei(null); setFeeEthWei(null); setEoaCawWei(null); setEoaEthWei(null) }
    if (!isOpen || !isPopB || !eoaAccount || !l1Client) { clear(); return }
    const call = buildTransferCall()
    if (!call) { clear(); return }
    let cancelled = false
    ;(async () => {
      try {
        // Estimate the FULL batch (transfer + a placeholder fee leg) so the
        // displayed fee matches what handlePopBTransfer signs and the relay
        // enforces — quoting only the transfer call under-counted the fee-leg gas.
        const feeLegForEstimate = {
          to: CAW_ADDRESS as Address,
          value: '0',
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [eoaAccount as Address, 1n] }),
        }
        const [est, cawBal, ethBal] = await Promise.all([
          apiFetch<{ minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string; feeEthUsd?: number | null }>(
            '/api/sponsor/execute-estimate',
            {
              method: 'POST',
              body: JSON.stringify({
                eoaAddress: eoaAccount,
                calls: [
                  { to: call.to, value: call.value.toString(), data: call.data },
                  feeLegForEstimate,
                ],
                forwardedValueWei: '0',
              }),
            },
          ),
          l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
          l1Client.getBalance({ address: eoaAccount as Address }),
        ])
        if (cancelled) return
        setRelayFeeUsd(typeof est.feeEthUsd === 'number' ? est.feeEthUsd : null)
        setFeeCawWei(est.priceAvailable ? BigInt(est.minFeeCawWei) : null)
        setFeeEthWei(BigInt(est.minFeeEthWei))
        setEoaCawWei(cawBal)
        setEoaEthWei(ethBal)
      } catch {
        if (!cancelled) clear()
      }
    })()
    return () => { cancelled = true }
  }, [isOpen, isPopB, eoaAccount, l1Client, buildTransferCall])

  // Optimistically settle the transfer in local state the instant it confirms,
  // so no refresh is needed. The critical rule: NEVER clear this token's passkey
  // credential unless the recipient is provably NOT the user's own passkey
  // address — clearing it wrongly (transfer to your OWN passkey address) makes
  // the profile unsignable until re-enroll (observed live: #89 → 0x96944…).
  //   - Recipient is one of the user's OWN addresses — either a known key in
  //     tokensByAddress OR a passkey address this browser holds a credential/
  //     marker for → MOVE the profile there (keeps its credential; appears under
  //     the new owner immediately, even if that key didn't exist yet).
  //   - Otherwise (a foreign address the user gave it to) → REMOVE it (also
  //     clears the credential — it's useless once we don't control the owner).
  const settleTransfer = useCallback((to: string) => {
    if (tokenId === null) return
    const store = useTokenDataStore.getState()
    const toLc = to.toLowerCase()
    // Capture the profile's PRE-transfer owner: every transfer bumps the on-chain
    // session epoch for the previous owner (CawProfileLedger._setOwnerOf →
    // ownerSessionEpoch[prev]++ / tokenSessionEpoch[tokenId]++), so any Quick Sign
    // session registered under that owner is now epoch-DEAD on-chain. If we leave
    // it in the local session store, the FE keeps signing this profile's actions
    // with a session that reverts InvalidSig at the validator. Clear it so QS
    // resolves the NEW owner (re-register, or wallet-sign for a Pop-A owner)
    // instead of signing-and-failing. Observed live: gilgakey56 (#94) → 0xf71338.
    const prevOwner = Object.entries(store.tokensByAddress)
      .find(([, toks]) => toks.some(t => t.tokenId === tokenId))?.[0]
    const isKnownOwnedKey = Object.keys(store.tokensByAddress).some(a => a.toLowerCase() === toLc)
    // Recipient is one of the user's passkey addresses this browser can sign for:
    // it holds a credential for some token there, or is marked a passkey account.
    const isOwnPasskeyAddr =
      hasPasskeyCredentialForAddress(toLc, store.tokensByAddress) || isPasskeyAddress(toLc)
    if (isKnownOwnedKey || isOwnPasskeyAddr) {
      store.moveTokenToAddress(tokenId, to as Address)
    } else {
      store.removeToken(tokenId)
    }
    // Kill the old owner's (now epoch-invalidated) session UNCONDITIONALLY: the
    // on-chain ownerSessionEpoch[prevOwner] bump invalidates ALL of that owner's
    // wallet-scoped sessions on any transfer out, so every one is epoch-dead and
    // would sign-and-fail. Clearing forces a correct re-register (the session key
    // is ephemeral + on-chain-registered; losing the plaintext costs nothing).
    if (prevOwner) {
      useSessionKeyStore.getState().clearSessionForAddress(prevOwner)
    }
  }, [tokenId])

  // Pop-A (wallet) transfer confirmed → settle immediately.
  useEffect(() => {
    if (isSuccess && recipient) settleTransfer(recipient)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess])

  // ── Gas-currency affordability (Pop-B) ──────────────────────────────────────
  // The ETH leg must also cover the self-funded LZ fee attached to transferAndSync
  // (0 on the bypassLZ L1 path, but keep it honest). CAW covers only the relayer
  // gas repayment.
  const transferLzFee = lzFee ?? 0n
  const canPayCaw = feeCawWei != null && eoaCawWei != null && eoaCawWei >= feeCawWei
  const canPayEth = feeEthWei != null && eoaEthWei != null && eoaEthWei >= (transferLzFee + feeEthWei)
  const feesLoaded = feeEthWei != null && eoaEthWei != null && eoaCawWei != null
  // Resolved currency: honour the user's explicit pick ONLY when both are
  // affordable; otherwise auto-pick whichever they can cover (prefer CAW).
  const resolvedGasCurrency: 'CAW' | 'ETH' | null =
    canPayCaw && canPayEth ? (gasCurrency ?? 'CAW')
    : canPayCaw ? 'CAW'
    : canPayEth ? 'ETH'
    : null
  const needsTopUp = feesLoaded && !canPayCaw && !canPayEth
  const feeCawDisplay = feeCawWei != null ? Number(formatUnits(feeCawWei, 18)) : null

  // Warn when transferring the wallet's LAST profile to a FOREIGN address while it
  // still holds funds — after the transfer the wallet drops from the UI and its
  // CAW/ETH becomes hard to reach (recoverable via AccountSettings/backup, but
  // easy to forget). Only for passkey wallets, only when the recipient isn't one
  // the user controls (moveTokenToAddress keeps those visible), and only above dust.
  const strandsFunds = (() => {
    if (!isPopB || !eoaAccount) return false
    const store = useTokenDataStore.getState()
    const owned = store.tokensByAddress[eoaAccount.toLowerCase() as Address] || []
    const isLastProfile = owned.length <= 1
    const hasFunds = (eoaCawWei != null && eoaCawWei > 0n) || (eoaEthWei != null && eoaEthWei > 0n)
    // Skip the warning when the recipient is an address the user also controls.
    const toLc = recipient.toLowerCase()
    const toSelf =
      Object.keys(store.tokensByAddress).some(a => a.toLowerCase() === toLc) ||
      hasPasskeyCredentialForAddress(toLc, store.tokensByAddress) ||
      isPasskeyAddress(toLc)
    return isLastProfile && hasFunds && !toSelf && isAddress(recipient)
  })()

  const handleClose = () => {
    setRecipient('')
    setInputError(null)
    setLzFee(null)
    setPopBError(null)
    setPopBSuccess(false)
    setPopBPending(false)
    reset()
    close()
  }

  const validateRecipient = (value: string): boolean => {
    if (!value.trim()) {
      setInputError(t('transfer_nft.error.address_required'))
      return false
    }
    if (!isAddress(value)) {
      setInputError(t('transfer_nft.error.invalid_address'))
      return false
    }
    if (value.toLowerCase() === address?.toLowerCase()) {
      setInputError(t('transfer_nft.error.cannot_self'))
      return false
    }
    setInputError(null)
    return true
  }

  const handleTransfer = async () => {
    if (isPopB) {
      handlePopBTransfer()
      return
    }
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      if (!validateRecipient(recipient)) return
      if (!address || tokenId === null) return

      // Use transferAndSync to transfer + sync L2 ownership in one tx.
      // lzDestId = L1's own LayerZero eid (mainnet/bypassLZ) — on a
      // bypassLZ-co-deployment this is a no-op flush; cross-chain L2
      // owner-sync happens later via syncTransfer(otherEid).
      writeContract({
        address: CAW_NAMES_ADDRESS,
        abi: cawProfileAbi,
        functionName: 'transferAndSync',
        args: [recipient as `0x${string}`, BigInt(tokenId), chains.l1.layerZero, 0n],
        value: lzFee ?? 0n,
        chainId: chains.l1.chainId
      })
    })
  }

  // Pop-B relay: transferAndSync (payable LZ fee self-funded) + fee leg.
  const handlePopBTransfer = useCallback(async () => {
    if (!isPopB || !eoaAccount || tokenId === null || !l1Client) return
    if (!validateRecipient(recipient)) return
    setPopBError(null)
    setPopBPending(true)
    try {
      const transferCall = buildTransferCall()
      if (!transferCall) throw new Error('INVALID_PARAMS')
      const transferLzFee = lzFee ?? 0n

      // Price against the FULL batch we'll actually submit — the transfer PLUS a
      // fee-leg call — so the FE-signed floor matches the floor the relay
      // re-derives from body.calls at submit. Quoting only the transfer call
      // under-estimated by the fee-leg's gas (~40K+), so the 15% headroom didn't
      // cover it and the relay rejected FEE_TOO_LOW even with plenty of CAW. A
      // placeholder CAW.transfer leg (amount irrelevant to gas) makes the
      // estimate's call-set identical to the real batch.
      const placeholderFeeLeg = {
        to: CAW_ADDRESS as Address,
        value: '0',
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [eoaAccount as Address, 1n] }),
      }
      const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean; minFeeEthWei: string }>(
        '/api/sponsor/execute-estimate',
        {
          method: 'POST',
          body: JSON.stringify({
            eoaAddress: eoaAccount,
            calls: [
              { to: transferCall.to, value: transferCall.value.toString(), data: transferCall.data },
              placeholderFeeLeg,
            ],
            forwardedValueWei: '0',
          }),
        },
      )
      // Sign for the estimate + 15% HEADROOM. The relayer re-derives the fee
      // floor from its OWN estimateExecuteFee at submit time; gas price drifts
      // between our quote and that re-derivation, and the fee is signature-bound
      // (can't be topped up after signing), so a bare estimate loses a race to a
      // tick-up in gas → FEE_TOO_LOW. The buffer absorbs that drift; any surplus
      // just makes the relayer whole. Kept modest — it's ~cents on a sub-dollar fee.
      const withHeadroom = (v: bigint) => (v * 115n) / 100n
      const feeCaw = quote.priceAvailable ? withHeadroom(BigInt(quote.minFeeCawWei)) : null
      const feeEth = withHeadroom(BigInt(quote.minFeeEthWei))

      const [cawBalNow, ethBalNow] = await Promise.all([
        l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoaAccount as Address] }) as Promise<bigint>,
        l1Client.getBalance({ address: eoaAccount as Address }),
      ])
      const affordCaw = feeCaw != null && cawBalNow >= feeCaw
      const affordEth = ethBalNow >= transferLzFee + feeEth
      if (!affordCaw && !affordEth) throw new Error('INSUFFICIENT_FEE_CAW')
      // Honour the user's toggle when both work; else use whichever is affordable
      // (prefer CAW). Matches resolvedGasCurrency shown in the UI.
      const payInCaw = affordCaw && affordEth ? (gasCurrency ?? 'CAW') === 'CAW' : affordCaw

      const calls: ExecCall[] = [transferCall]
      if (payInCaw) {
        calls.push({ to: CAW_ADDRESS as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw!] }) })
      } else {
        calls.push({ to: quote.relayer as Address, value: feeEth, data: '0x' })
      }
      await smartEoaExecute(calls)
      setPopBSuccess(true)
      // Optimistically settle the transfer the instant it confirms — move to the
      // recipient if the user also owns it (appears under the new owner right
      // away, keeps the passkey credential), else remove it (clears credential).
      settleTransfer(recipient)
    } catch (err: any) {
      const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
      if (/NotAllowed|abort|cancel|denied|rejected/i.test(raw)) setPopBError(t('transfer_nft.error.tx_rejected'))
      else if (/SIMULATION_FAILED|INSUFFICIENT_FEE_CAW|insufficient|FEE_TOO_LOW/i.test(raw)) setPopBError(t('transfer_nft.popb_insufficient_fee'))
      else if (/not the token owner/i.test(raw)) setPopBError(t('transfer_nft.error.not_owner'))
      else setPopBError(t('transfer_nft.error.tx_failed'))
    } finally {
      setPopBPending(false)
    }
  }, [isPopB, eoaAccount, tokenId, l1Client, recipient, lzFee, gasCurrency, buildTransferCall, settleTransfer, smartEoaExecute, t])

  // Pop-B: the gas fee/currency reads are still resolving for a valid recipient.
  const popBEstimating = isPopB && !!recipient && isAddress(recipient) && !feesLoaded

  const getButtonText = () => {
    // Passkey (Pop-B): "Confirm with passkey…" only DURING the biometric ceremony
    // (isSigning); once signed, the relay submits + mines (~30s), so show
    // "Transferring…" instead of leaving the button on "Confirm with passkey".
    if (popBPending) return isSigning ? t('transfer_nft.btn.confirm_with_passkey') : t('transfer_nft.btn.transferring')
    if (popBSuccess) return t('transfer_nft.btn.transferred')
    if (needsChainSwitch) return isSwitchingChain ? t('transfer_nft.btn.switching') : t('transfer_nft.btn.switch_network')
    if (isQuoting || popBEstimating) return t('transfer_nft.btn.estimating_fee')
    if (isSubmitting) return t('transfer_nft.btn.confirm_in_wallet')
    if (isConfirming) return t('transfer_nft.btn.confirming')
    if (isSuccess) return t('transfer_nft.btn.transferred')
    return t('transfer_nft.btn.transfer')
  }

  const isButtonDisabled = isSubmitting || isConfirming || isSuccess || isSwitchingChain || isQuoting || popBPending || popBSuccess ||
    // Pop-B: wait for the fee/currency info before allowing submit, and block a
    // doomed transfer when neither CAW nor ETH can cover gas (top-up note shown).
    (isPopB && (popBEstimating || needsTopUp))

  return (
    <ModalWrapper isOpen={isOpen} onClose={handleClose} maxWidth="max-w-md" usePortal zIndex={9999}>
      <div className="p-6">
        <ModalHeader title={t('transfer_nft.title')} onClose={handleClose} border={false} size="lg" className="mb-4 px-0" />

        <p className={`text-sm mb-1 ${themeTextSecondary(isDark)}`}>
          {t('transfer_nft.intro_before')}<span className="font-semibold">@{username}</span>{t('transfer_nft.intro_token', { tokenId: tokenId ?? '' })}
        </p>
        <p className={`text-xs mb-5 ${isDark ? 'text-yellow-500/80' : 'text-yellow-600'}`}>
          {t('transfer_nft.warning')}
        </p>

        {!isSuccess && (
          <div className="mb-5">
            <label className={`block text-sm font-medium mb-2 ${themeTextSecondary(isDark)}`}>
              {t('transfer_nft.recipient_label')}
            </label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value)
                if (inputError) setInputError(null)
              }}
              placeholder="0x..."
              disabled={isSubmitting || isConfirming}
              className={`w-full px-3 py-2 rounded-lg text-sm font-mono transition ${
                isDark
                  ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-yellow-500/50'
                  : 'bg-gray-50 border border-gray-200 text-gray-900 placeholder-gray-400 focus:border-yellow-500'
              } ${inputError ? (isDark ? 'border-red-500/50' : 'border-red-400') : ''} outline-none`}
            />
            {inputError && (
              <p className="mt-1 text-xs text-error-dim">{inputError}</p>
            )}
          </div>
        )}

        {/* Strands-funds warning: last profile → foreign address, wallet holds funds. */}
        {!isSuccess && !popBSuccess && strandsFunds && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${isDark ? 'bg-orange-500/10 text-orange-300' : 'bg-orange-50 text-orange-700'}`}>
            {t('transfer_nft.strands_warning')}
          </div>
        )}

        {/* Show LZ fee estimate */}
        {!isSuccess && lzFee !== null && lzFee > 0n && (
          <div className={`mb-4 p-3 rounded-lg text-xs ${themeBgSubtle(isDark)} ${themeTextMuted(isDark)}`}>
            {t('transfer_nft.l2_fee_label')}: ~{formatEther(lzFee)} ETH{ethPrice > 0 && ` (~$${(Number(formatEther(lzFee)) * ethPrice).toFixed(2)})`}
            <span className={`block mt-1 ${themeTextMuted(isDark)}`}>
              {t('transfer_nft.l2_fee_note')}
            </span>
          </div>
        )}

        {(writeError || popBError) && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-error-dim text-sm">
            {popBError
              ? popBError
              : writeError?.message?.includes('User rejected')
                ? t('transfer_nft.error.tx_rejected')
                : writeError?.message?.includes('caller is not the token owner')
                  ? t('transfer_nft.error.not_owner')
                  : t('transfer_nft.error.tx_failed')}
          </div>
        )}

        {/* Relay in flight (passkey signed, submitting + mining ~30s). Distinct
            from the biometric ceremony (isSigning) so the user knows it's working,
            not stuck, during the wait. */}
        {popBPending && !isSigning && !popBSuccess && (
          <div className={`mb-4 p-3 rounded-lg text-sm flex items-center gap-2 ${isDark ? 'bg-blue-500/10 text-blue-300' : 'bg-blue-50 text-blue-700'}`}>
            <span className="inline-block w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
            {t('transfer_nft.pending')}
          </div>
        )}

        {(isSuccess || popBSuccess) && (
          <div className={`mb-4 p-3 rounded-lg text-sm ${isDark ? 'bg-green-500/10 text-green-400' : 'bg-green-50 text-green-700'}`}>
            {t('transfer_nft.success', { username: username || '' })}
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={handleClose}
            className={`px-4 py-2 rounded-lg text-sm transition cursor-pointer ${themeSecondaryButton(isDark)}`}
          >
            {isSuccess ? t('transfer_nft.btn.close') : t('transfer_nft.btn.cancel')}
          </button>
          {!isSuccess && !popBSuccess && (
            <button
              onClick={handleTransfer}
              disabled={isButtonDisabled}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition cursor-pointer ${
                isButtonDisabled
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:opacity-90'
              } ${needsChainSwitch ? 'bg-blue-500 text-white' : 'bg-red-500 text-white'}`}
            >
              {getButtonText()}
            </button>
          )}
        </div>

        {/* Pop-B gas: which currency + (when both affordable) a toggle.
            (While estimating, the button itself reads "Estimating network fee…"
            and is disabled, so the "Paying gas in X" note never surprise-pops.) */}
        {isPopB && !isSuccess && !popBSuccess && feesLoaded && (
          <div className="mt-3 space-y-2">
            {/* Both affordable → let the user choose. */}
            {canPayCaw && canPayEth && (
              <div className="flex items-center justify-end gap-2">
                <span className={`text-[11px] ${themeTextMuted(isDark)}`}>{t('transfer_nft.gas.pay_with')}</span>
                {(['CAW', 'ETH'] as const).map(cur => {
                  const active = resolvedGasCurrency === cur
                  return (
                    <button
                      key={cur}
                      type="button"
                      onClick={() => setGasCurrency(cur)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition cursor-pointer ${
                        active
                          ? 'bg-yellow-500 text-black'
                          : isDark ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/60 hover:bg-black/10'
                      }`}
                    >
                      {cur}
                    </button>
                  )
                })}
              </div>
            )}
            {/* Note which currency it will use + the amount. */}
            {resolvedGasCurrency != null && (
              <p className={`text-[11px] text-right ${themeTextMuted(isDark)}`}>
                {resolvedGasCurrency === 'CAW' && feeCawDisplay != null
                  ? t('transfer_nft.gas.paying_caw', { amount: feeCawDisplay.toLocaleString(undefined, { maximumFractionDigits: 2 }) })
                  : relayFeeUsd != null
                    ? t('transfer_nft.gas.paying_eth', { amount: relayFeeUsd < 0.01 ? '<0.01' : relayFeeUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })
                    : t('transfer_nft.gas.paying_eth_generic')}
              </p>
            )}
            {/* Neither affordable → specific top-up guidance (NOT a bare "insufficient"). */}
            {needsTopUp && (
              <div className={`p-2.5 rounded-lg text-[11px] ${isDark ? 'bg-orange-500/10 text-orange-400' : 'bg-orange-50 text-orange-600'}`}>
                <p className="text-center whitespace-pre-line">{t('transfer_nft.gas.topup')}</p>
                {eoaAccount && (
                  <p className="mt-1 text-center font-mono break-all">{eoaAccount}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </ModalWrapper>
  )
}

export default TransferNFTModal
