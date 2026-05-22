/**
 * OnrampOnboarding — card-payment onboarding for users without a wallet.
 *
 * Flow:
 *   1. Generate a fresh EOA private key in the browser.
 *   2. Estimate how much ETH the user needs (profile cost + gas headroom).
 *   3. Show the Moonpay iframe pre-filled with the EOA address and amount.
 *   4. Poll the L1 balance every 5s until ETH arrives.
 *   5. Persist the private key in localStorage with a "back this up" warning
 *      (see keyManager.ts — TODO: wrap in passkey encryption before prod).
 *   6. Navigate to /usernames/new with the EOA address in state so the
 *      existing Pop-A mintAndDepositZap flow can run normally.
 *
 * This is a Population-A path: the user's own ETH pays gas, no sponsor needed.
 *
 * The Moonpay widget is rendered as an <iframe> using the URL-based integration
 * (no SDK). Sandbox (VITE_MOONPAY_BASE_URL = https://buy-sandbox.moonpay.com)
 * does not require URL signing. Production requires a server-side HMAC signature
 * from /api/moonpay/sign — see services/onramp/moonpay.ts for details.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '~/utils/localizedRouter'
import { formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { usePriceStore } from '~/store/tokenDataStore'
import { generateOnrampAccount, loadOnrampAccount } from '~/services/onramp/keyManager'
import { buildMoonpayUrl, estimateMoonpayAmount } from '~/services/onramp/moonpay'
import { useEthBalancePoll } from '~/hooks/useEthBalancePoll'
import { getJSON, setJSON } from '~/utils/safeStorage'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** L1 ETH-denominated gas estimate for a mintAndDepositZap call (~300k gas at
 *  a generous 30 gwei). We use 2× of this in the Moonpay amount estimate. */
const GAS_ESTIMATE_ETH = 0.009 // ~$30 at $3300/ETH — intentionally conservative

/** localStorage key that stores the last-generated onramp EOA address so we
 *  can restore state after a page reload / redirect back from Moonpay. */
const PENDING_ADDRESS_KEY = 'caw:onramp-pending-address'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a bigint wei value to a human-readable ETH string (4 dp). */
function fmtEth(wei: bigint): string {
  const s = formatEther(wei)
  const [whole, dec = ''] = s.split('.')
  return `${whole}.${dec.slice(0, 4).padEnd(4, '0')}`
}

/** Derive USD-denominated minimum ETH needed from current prices. */
function computeMinUsd(ethPriceUsd: number): number {
  if (ethPriceUsd <= 0) return 30 // fallback if prices haven't loaded
  const gasCostUsd = GAS_ESTIMATE_ETH * ethPriceUsd
  // Profile cost in ETH ≈ 0.01 ETH (rough worst-case for a short username);
  // actual cost is CAW-denominated and converted at current rate. Using a
  // conservative ETH estimate keeps the UI simple for MVP.
  const profileCostUsd = 0.01 * ethPriceUsd
  return estimateMoonpayAmount(profileCostUsd, gasCostUsd)
}

/** Convert a USD amount to ETH at the current price (or 0 if price unknown). */
function usdToEth(usd: number, ethPriceUsd: number): number {
  if (ethPriceUsd <= 0) return 0
  return usd / ethPriceUsd
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StepProps {
  isDark: boolean
}

const StepDot: React.FC<StepProps & { active: boolean; done: boolean; label: string }> = ({
  isDark,
  active,
  done,
  label,
}) => (
  <div className="flex flex-col items-center gap-1">
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
        done
          ? 'bg-green-500 text-white'
          : active
          ? 'bg-yellow-500 text-black'
          : isDark
          ? 'bg-white/10 text-white/40'
          : 'bg-gray-200 text-gray-400'
      }`}
    >
      {done ? '✓' : active ? '→' : '·'}
    </div>
    <span
      className={`text-xs font-medium ${
        active
          ? isDark
            ? 'text-yellow-400'
            : 'text-yellow-700'
          : isDark
          ? 'text-white/40'
          : 'text-gray-400'
      }`}
    >
      {label}
    </span>
  </div>
)

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type OnrampStep = 'generate' | 'pay' | 'waiting' | 'ready'

const OnrampOnboarding: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()

  const ethPriceUsd = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const minUsd = useMemo(() => computeMinUsd(ethPriceUsd), [ethPriceUsd])
  const minEth = useMemo(() => usdToEth(minUsd, ethPriceUsd), [minUsd, ethPriceUsd])
  const minEthWei = useMemo(
    () => BigInt(Math.ceil(minEth * 1e18)),
    [minEth]
  )

  // Restore pending address from a previous visit (e.g. redirect back from
  // Moonpay's redirectURL) so we don't generate a second key.
  const [address, setAddress] = useState<`0x${string}` | undefined>(() => {
    const stored = getJSON<string | null>(PENDING_ADDRESS_KEY, null)
    if (stored && stored.startsWith('0x')) {
      // Verify the key is still in storage (user might have cleared it)
      const acct = loadOnrampAccount(stored as `0x${string}`)
      return acct ? acct.address : undefined
    }
    return undefined
  })

  const [step, setStep] = useState<OnrampStep>(address ? 'pay' : 'generate')
  const [copiedKey, setCopiedKey] = useState(false)
  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const privateKey = useMemo(() => {
    if (!address) return null
    return loadOnrampAccount(address)?.privateKey ?? null
  }, [address])

  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Build the Moonpay URL once we have an address.
  const moonpayUrl = useMemo(() => {
    if (!address) return null
    const redirectUrl = `${window.location.origin}/onboarding/onramp/complete`
    return buildMoonpayUrl({
      walletAddress: address,
      baseCurrencyAmountUsd: minUsd,
      redirectUrl,
    })
  }, [address, minUsd])

  // Poll the L1 balance. Active once we're in the 'pay' or 'waiting' step.
  const pollAddress = step === 'pay' || step === 'waiting' ? address : undefined
  const { balance } = useEthBalancePoll(pollAddress, 5_000)

  // Advance to 'ready' once enough ETH has arrived.
  useEffect(() => {
    if (step !== 'pay' && step !== 'waiting') return
    if (balance > 0n) setStep('waiting')
    if (minEthWei > 0n && balance >= minEthWei) {
      setStep('ready')
    }
  }, [balance, minEthWei, step])

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const handleGenerate = () => {
    const acct = generateOnrampAccount()
    setJSON(PENDING_ADDRESS_KEY, acct.address)
    setAddress(acct.address)
    setStep('pay')
  }

  const handleCopyKey = async () => {
    if (!privateKey) return
    try {
      await navigator.clipboard.writeText(privateKey)
      setCopiedKey(true)
      setTimeout(() => setCopiedKey(false), 2000)
    } catch {
      /* clipboard access denied — show the key in plain text instead */
      setShowPrivateKey(true)
    }
  }

  const handleProceed = () => {
    if (!address || !privateKey) return
    // Navigate to /usernames/new, passing the onramp account in router state.
    // NewProfile reads wagmi's connected account — for MVP we surface a
    // "connect this EOA" message. Full wagmi privateKey connector wiring is a
    // follow-up; the state payload here lets us detect the onramp path and
    // pre-fill the address without a full wagmi connector.
    navigate('/usernames/new', {
      state: {
        onrampAddress: address,
        onrampPrivateKey: privateKey,
      },
    })
  }

  // ---------------------------------------------------------------------------
  // Theme helpers
  // ---------------------------------------------------------------------------

  const cardCls = isDark ? 'bg-white/5 border border-white/10' : 'bg-white border border-gray-200 shadow-sm'
  const strongCls = isDark ? 'text-white' : 'text-gray-900'
  const mutedCls = isDark ? 'text-white/60' : 'text-gray-500'
  const infoBgCls = isDark
    ? 'bg-yellow-500/10 border border-yellow-500/20'
    : 'bg-yellow-50 border border-yellow-200'
  const infoTextCls = isDark ? 'text-yellow-200' : 'text-yellow-800'
  const warnBgCls = isDark
    ? 'bg-orange-500/10 border border-orange-500/20'
    : 'bg-orange-50 border border-orange-200'
  const warnTextCls = isDark ? 'text-orange-200' : 'text-orange-800'

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="max-w-2xl mx-auto px-6 py-4">
      {/* Header */}
      <div className="mb-6">
        <h1 className={`text-2xl font-bold ${strongCls}`}>
          {t('onramp.title')}
        </h1>
        <p className={`text-sm mt-1 ${mutedCls}`}>
          {t('onramp.subtitle')}
        </p>
      </div>

      {/* Step indicators */}
      <div className="flex items-start justify-center gap-8 mb-8">
        <StepDot
          isDark={isDark}
          active={step === 'generate'}
          done={step !== 'generate'}
          label={t('onramp.step_generate')}
        />
        <div className={`mt-4 flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
        <StepDot
          isDark={isDark}
          active={step === 'pay'}
          done={step === 'waiting' || step === 'ready'}
          label={t('onramp.step_pay')}
        />
        <div className={`mt-4 flex-1 h-px ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
        <StepDot
          isDark={isDark}
          active={step === 'waiting' || step === 'ready'}
          done={step === 'ready'}
          label={t('onramp.step_ready')}
        />
      </div>

      {/* ── STEP: generate ── */}
      {step === 'generate' && (
        <div className={`rounded-2xl p-6 ${cardCls}`}>
          <div className="text-center mb-6">
            <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-yellow-500/20 flex items-center justify-center">
              <svg className="w-7 h-7 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M3 10h18M7 15h1m4 0h1m-7 4h12a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className={`text-lg font-bold mb-2 ${strongCls}`}>
              {t('onramp.generate_heading')}
            </h2>
            <p className={`text-sm ${mutedCls}`}>
              {t('onramp.generate_body')}
            </p>
          </div>

          <div className={`p-4 rounded-xl mb-6 ${infoBgCls}`}>
            <p className={`text-sm ${infoTextCls}`}>
              {t('onramp.generate_note')}
            </p>
          </div>

          <button
            onClick={handleGenerate}
            className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
          >
            {t('onramp.generate_cta')}
          </button>
        </div>
      )}

      {/* ── STEP: pay ── */}
      {(step === 'pay' || step === 'waiting') && address && moonpayUrl && (
        <div className="space-y-4">
          {/* Address card */}
          <div className={`rounded-2xl p-4 ${cardCls}`}>
            <p className={`text-xs font-semibold uppercase tracking-wider mb-1 ${mutedCls}`}>
              {t('onramp.your_address')}
            </p>
            <code className={`text-xs break-all font-mono ${strongCls}`}>{address}</code>
          </div>

          {/* Amount hint */}
          <div className={`p-4 rounded-xl ${infoBgCls}`}>
            <p className={`text-sm font-semibold ${infoTextCls}`}>
              {t('onramp.buy_at_least', {
                amount: `$${minUsd.toFixed(2)}`,
                eth: minEth > 0 ? `(~${minEth.toFixed(4)} ETH)` : '',
              })}
            </p>
            <p className={`text-xs mt-1 ${infoTextCls}`}>
              {t('onramp.amount_includes_gas')}
            </p>
          </div>

          {/* Private key warning */}
          <div className={`p-4 rounded-xl ${warnBgCls}`}>
            <p className={`text-sm font-semibold ${warnTextCls} mb-2`}>
              {t('onramp.backup_warning_heading')}
            </p>
            <p className={`text-xs ${warnTextCls} mb-3`}>
              {t('onramp.backup_warning_body')}
            </p>
            <button
              onClick={handleCopyKey}
              className="text-xs underline underline-offset-2 cursor-pointer font-medium"
            >
              {copiedKey ? t('onramp.key_copied') : t('onramp.copy_key')}
            </button>
            {showPrivateKey && privateKey && (
              <div className="mt-2">
                <code className={`text-xs break-all font-mono block p-2 rounded ${isDark ? 'bg-black/30' : 'bg-white'}`}>
                  {privateKey}
                </code>
              </div>
            )}
          </div>

          {/* Moonpay iframe */}
          <div className={`rounded-2xl overflow-hidden ${cardCls}`} style={{ height: 540 }}>
            <iframe
              ref={iframeRef}
              src={moonpayUrl}
              title="Moonpay — buy ETH with card"
              allow="accelerometer; autoplay; camera; gyroscope; payment"
              className="w-full h-full border-0"
            />
          </div>

          {/* Balance status */}
          <div className={`p-4 rounded-xl ${cardCls} flex items-center justify-between`}>
            <div>
              <p className={`text-sm font-medium ${strongCls}`}>
                {t('onramp.wallet_balance')}
              </p>
              <p className={`text-xs ${mutedCls}`}>
                {t('onramp.polling_hint')}
              </p>
            </div>
            <div className="text-right">
              <p className={`text-lg font-bold ${balance > 0n ? 'text-green-500' : mutedCls}`}>
                {fmtEth(balance)} ETH
              </p>
              {minEthWei > 0n && balance > 0n && balance < minEthWei && (
                <p className={`text-xs ${isDark ? 'text-orange-400' : 'text-orange-600'}`}>
                  {t('onramp.need_more', {
                    need: fmtEth(minEthWei - balance),
                  })}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── STEP: ready ── */}
      {step === 'ready' && address && (
        <div className={`rounded-2xl p-6 ${cardCls} text-center space-y-4`}>
          <div className="w-14 h-14 mx-auto rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-7 h-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h2 className={`text-lg font-bold ${strongCls}`}>
            {t('onramp.ready_heading')}
          </h2>
          <p className={`text-sm ${mutedCls}`}>
            {t('onramp.ready_body', { eth: fmtEth(balance) })}
          </p>

          {/* Repeat backup warning at the moment of transition */}
          <div className={`p-4 rounded-xl text-left ${warnBgCls}`}>
            <p className={`text-xs font-semibold ${warnTextCls} mb-1`}>
              {t('onramp.backup_reminder_heading')}
            </p>
            <p className={`text-xs ${warnTextCls} mb-2`}>
              {t('onramp.backup_reminder_body')}
            </p>
            <code className={`text-xs break-all font-mono block p-2 rounded ${isDark ? 'bg-black/30' : 'bg-white'}`}>
              {privateKey}
            </code>
            <button
              onClick={handleCopyKey}
              className="mt-2 text-xs underline underline-offset-2 cursor-pointer font-medium"
            >
              {copiedKey ? t('onramp.key_copied') : t('onramp.copy_key')}
            </button>
          </div>

          <button
            onClick={handleProceed}
            className="w-full py-3 bg-yellow-500 text-black font-semibold rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
          >
            {t('onramp.ready_cta')}
          </button>
        </div>
      )}
    </div>
  )
}

export default OnrampOnboarding
