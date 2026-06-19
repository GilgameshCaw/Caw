/**
 * UsernameStep.tsx
 *
 * Step 1 of /onboarding: pick a username and verify it is available on-chain.
 * Uses wagmi's useReadContract to call cawProfileMinter.idByUsername(username)
 * — returns 0n when the name is free, a non-zero tokenId when taken.
 *
 * Availability check is debounced so we don't fire per-keystroke RPC calls.
 *
 * When giftCaw is provided (sponsored flow), the username is also gated by:
 *  - cawCostForLength(len) * 1e18 <= giftCaw  (name must fit in the gift)
 *  - len >= minUsernameLength                 (minimum length enforced by code)
 * The deposit remainder (giftCaw - burnCost) is shown read-only so the user
 * knows what they'll receive. No separate deposit step exists.
 */

import { useState, useEffect, useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { cawCostForLength } from '~/utils/cawCostSchedule'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { usePriceStore } from '~/store/tokenDataStore'
import { formatUsd } from '~/utils/numberFormat'
import UsernameCaptiveBody from '~/components/username/UsernameCaptiveBody'
import UsernameInputCard, { BoxedPricingTrigger } from '~/components/username/UsernameInputCard'
import QuickSignCard from '~/components/username/QuickSignCard'

const DEBOUNCE_MS = 500

// Lowercase alphanumeric + underscore; min 3, max 24 chars
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/


// Compact CAW formatter. Keeps ONE significant decimal (dropping a trailing
// ".0") so the displayed number reflects the real value — e.g. 57.3M, not a
// lossy "57M"/"100M" from rounding to whole units.
function formatCawCompact(caw: number): string {
  const fmt = (n: number, suffix: string) => {
    const s = n.toFixed(1).replace(/\.0$/, '')
    return `${s}${suffix}`
  }
  if (caw >= 1_000_000_000_000) return fmt(caw / 1_000_000_000_000, 'T')
  if (caw >= 1_000_000_000) return fmt(caw / 1_000_000_000, 'B')
  if (caw >= 1_000_000) return fmt(caw / 1_000_000, 'M')
  if (caw >= 1_000) return fmt(caw / 1_000, 'K')
  return Math.round(caw).toString()
}

/** Format a bigint wei amount as a compact CAW string (e.g. "1.2B CAW") */
function formatWeiAsCaw(wei: bigint): string {
  const whole = Number(wei / 10n ** 18n)
  return `${formatCawCompact(whole)} CAW`
}

/** "$X.XX" USD value of a wei CAW amount, or '' when the price isn't loaded. */
function formatWeiAsUsd(wei: bigint, cawPriceUsd?: number): string {
  if (cawPriceUsd === undefined || cawPriceUsd <= 0) return ''
  const whole = Number(wei / 10n ** 18n)
  const usd = whole * cawPriceUsd
  if (usd <= 0) return ''
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`
}

export interface UsernameStepProps {
  username: string
  usernameAvailable: boolean | null
  onUsernameChange: (value: string) => void
  onAvailabilityChange: (available: boolean | null) => void
  onNext: () => void
  /**
   * Total CAW gift in wei (bigint). When present, enables gift-based gating:
   * the username burn cost must fit within the gift, and the remainder
   * (giftCaw - burnCost) is shown as the auto-deposit.
   * Undefined means the gift hasn't loaded yet — Next is disabled.
   */
  giftCaw?: bigint
  /**
   * Live redeem-gas the server deducts from the gift at signup, in WHOLE CAW.
   * The deposit the user nets is giftCaw − burnCost − (gasCostCaw × 1e18), so we
   * fold it into both the affordability gate and the shown deposit to stay
   * byte-identical to Onboarding's signed derivedDepositAmount. 0 / undefined
   * when prices are unavailable (gas just isn't deducted that moment).
   */
  gasCostCaw?: bigint
  /**
   * Minimum username length enforced by this invite code.
   * Undefined means no server-enforced minimum (the format regex min of 3 applies).
   */
  minUsernameLength?: number
  /** True while the /api/sponsor/code fetch is in flight. Disables Next. */
  giftLoading?: boolean

  // Quick Sign config — the SAME card as /usernames/new (QuickSignCard),
  // rendered below the username form on this sponsored flow. State lives in the
  // Onboarding parent so the chosen params can be threaded into the post-mint
  // registerSponsoredSession. All optional: when omitted the card isn't shown.
  cawPriceUsd?: number
  quickSignEnabled?: boolean
  onQuickSignEnabledChange?: (v: boolean) => void
  quickSignExpanded?: boolean
  onQuickSignExpandedChange?: (v: boolean) => void
  qsSpendLimit?: bigint
  onQsSpendLimitChange?: (v: bigint) => void
  qsDuration?: number
  onQsDurationChange?: (v: number) => void
  qsTipCeiling?: bigint
  onQsTipCeilingChange?: (v: bigint) => void
  qsWalletProtect?: boolean
  onQsWalletProtectChange?: (v: boolean) => void
}

export default function UsernameStep({
  username,
  usernameAvailable,
  onUsernameChange,
  onAvailabilityChange,
  onNext,
  giftCaw,
  gasCostCaw,
  minUsernameLength,
  giftLoading = false,
  quickSignEnabled,
  onQuickSignEnabledChange,
  quickSignExpanded,
  onQuickSignExpandedChange,
  qsSpendLimit,
  onQsSpendLimitChange,
  qsDuration,
  onQsDurationChange,
  qsTipCeiling,
  onQsTipCeilingChange,
  qsWalletProtect,
  onQsWalletProtectChange,
}: UsernameStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined

  // Cost depends on username length — shorter = much more expensive. The
  // burn cost is paid in CAW at mint time and locked forever.
  const cawCost = useMemo(() => cawCostForLength(username.length), [username])
  const usdCost = cawPriceUsd !== undefined && cawCost > 0
    ? cawCost * cawPriceUsd
    : null

  // ── Gift-based gating ─────────────────────────────────────────────────────
  // All math in BigInt wei to avoid float precision issues with large numbers.
  const burnCostWei = useMemo(
    () => BigInt(cawCost) * 10n ** 18n,
    [cawCost],
  )

  // On-chain deposit floor: the sponsor server rejects a bootstrap whose
  // deposit is below SPONSOR_MIN_DEPOSIT_CAW (default 1,000,000 CAW) with
  // ZERO_DEPOSIT. So the username burn must leave AT LEAST this much, not just
  // a non-zero remainder — otherwise the name "fits the gift" in the FE but the
  // mint fails server-side. 1M CAW in wei.
  const MIN_DEPOSIT_WEI = 1_000_000n * 10n ** 18n

  // Live redeem-gas (whole CAW → wei) the server also deducts from the gift at
  // signup. Folded into both the affordability gate and the shown deposit so the
  // FE preview matches Onboarding's signed derivedDepositAmount exactly.
  const gasWei = useMemo(() => (gasCostCaw ?? 0n) * 10n ** 18n, [gasCostCaw])

  // Is the name too expensive? It's too expensive if the burn cost PLUS gas would
  // leave less than the minimum deposit (i.e. burn + gas > gift - MIN_DEPOSIT).
  // This also covers the exact-spend case — the user must keep enough to fund a
  // real profile, never spend the whole gift on the name + gas.
  const nameTooExpensive = useMemo(
    () => giftCaw !== undefined && burnCostWei + gasWei > giftCaw - MIN_DEPOSIT_WEI,
    [giftCaw, burnCostWei, gasWei],
  )

  // Is the name too short per the code's minimum?
  const belowMinLength = useMemo(
    () => minUsernameLength !== undefined && username.length > 0 && username.length < minUsernameLength,
    [minUsernameLength, username.length],
  )

  // Deposit the user will receive after username burn. Null when it wouldn't
  // clear the deposit floor (nameTooExpensive already blocks Next in that case).
  const depositAmount = useMemo((): bigint | null => {
    if (giftCaw === undefined) return null
    const remainder = giftCaw - burnCostWei - gasWei
    return remainder >= MIN_DEPOSIT_WEI ? remainder : null
  }, [giftCaw, burnCostWei, gasWei])

  // Debounced value used for the RPC call — avoids a query per keystroke
  const [debouncedUsername, setDebouncedUsername] = useState(username)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUsername(username), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [username])

  const isValidFormat = USERNAME_REGEX.test(debouncedUsername)

  // Also enforce minUsernameLength in the RPC-triggering regex gate
  const meetsMinLength = minUsernameLength === undefined || debouncedUsername.length >= minUsernameLength
  const isValidForRpc = isValidFormat && meetsMinLength

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'idByUsername',
    args: [debouncedUsername],
    // staleTime: 0 — a username's availability changes the instant someone mints
    // it (including the user's OWN just-failed mint attempt). With wagmi's default
    // caching, idByUsername(name)=0 was cached as "available" and kept serving 0
    // even after the name got taken, so the user got bounced back here with the
    // name still showing "available" and the mint failing USERNAME_TAKEN forever.
    // Forcing a fresh read makes the just-taken name correctly show as taken.
    query: { enabled: isValidForRpc, staleTime: 0, gcTime: 0 },
  })

  // Sync availability to parent whenever the input or check result changes.
  //
  // The `username` (live value) dependency is load-bearing. The parent resets
  // usernameAvailable→null on EVERY keystroke (handleUsernameChange). wagmi
  // caches idByUsername, so deleting a char and retyping the SAME name returns
  // the identical cached `existingId` with `checkingUsername` false, and the
  // debounced value never actually changes (setState bails an equal value) — so
  // without depending on the live `username` the effect would NOT re-run after
  // the keystrokes blanked the parent's state, leaving it stuck at null ("checks
  // a name once, won't re-confirm it"). Depending on `username` re-runs the
  // effect every keystroke; we only PUSH a definitive result once typing has
  // settled (username === debouncedUsername), otherwise we report null (typing).
  useEffect(() => {
    const settled = username === debouncedUsername
    if (!settled || !isValidForRpc || checkingUsername) {
      onAvailabilityChange(null)
      return
    }
    // existingId === 0 or undefined means free; non-zero means taken
    // idByUsername returns uint32 — wagmi types it as number
    const available = existingId === undefined || existingId === 0
    onAvailabilityChange(available)
  }, [existingId, checkingUsername, isValidForRpc, username, debouncedUsername, onAvailabilityChange])

  const isTyping = username !== debouncedUsername || checkingUsername

  // canProceed: available + gift loaded + name fits in gift + meets min length
  const canProceed =
    usernameAvailable === true &&
    !giftLoading &&
    giftCaw !== undefined &&
    !nameTooExpensive &&
    !belowMinLength

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  // The shared UsernameInputCard's in-field status mark takes a single nullable
  // bool. Collapse the page's three gate conditions (taken / too-expensive /
  // below-min) into it so the green-check / red-x affordance matches the
  // original inline logic exactly.
  const showGreen = !isTyping && usernameAvailable === true && !nameTooExpensive && !belowMinLength
  const showRed = !isTyping && (usernameAvailable === false || nameTooExpensive || belowMinLength) && username.length > 0
  const availabilityForCard: boolean | null = showGreen ? true : showRed ? false : null

  return (
    /* The SAME two-column shell as /usernames/new (UsernameCaptiveBody): left
       preview card + right form card. sponsoredAmount={giftCaw} marks this as
       the sponsored flow (no deposit section). The heading uses the onboarding
       copy; the subtitle + gift summary + form live in the children. */
    <UsernameCaptiveBody
      username={username}
      sponsoredAmount={giftCaw}
      heading={t('onboarding.username.title')}
      showFaucetLink={false}
      showMarketplaceLink={false}
    >
      <div className="space-y-6">
      <p className={`text-sm ${mutedClass} -mt-2`}>
        {t('onboarding.username.subtitle')}
      </p>

      {/* Gift summary — shown once giftCaw is loaded */}
      {giftCaw !== undefined && (
        <div className={`rounded-xl p-4 text-sm ${isDark ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-yellow-50 border border-yellow-200'}`}>
          <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-800'}`}>
            Your invite includes {formatWeiAsCaw(giftCaw)}
            {formatWeiAsUsd(giftCaw, cawPriceUsd) && ` (${formatWeiAsUsd(giftCaw, cawPriceUsd)})`}
          </p>
          <p className={`mt-1 ${isDark ? 'text-yellow-300/70' : 'text-yellow-700'}`}>
            The username cost and network fees are deducted; the rest auto-deposits to your profile.
          </p>
        </div>
      )}

      {/* Loading state for gift fetch */}
      {giftLoading && (
        <div className={`flex items-center gap-2 text-sm ${mutedClass}`}>
          <svg className="w-4 h-4 animate-spin text-yellow-500 flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading invite details…</span>
        </div>
      )}

      <div className="space-y-2">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.username.label')}
        </label>

        {/* Username input + pricing popover — shared UsernameInputCard (boxed
            variant), also used by /usernames/new (pill variant). The boxed
            status mark (spinner / check / x) is driven by availabilityForCard,
            which folds the gift-gate conditions into a single nullable bool.
            The cost/hint row is page-specific (gift-gate copy) so it stays here;
            BoxedPricingTrigger owns the inline pricing popover. */}
        <UsernameInputCard
          variant="boxed"
          username={username}
          onUsernameChange={val => onUsernameChange(val.toLowerCase())}
          placeholder={t('onboarding.username.placeholder')}
          maxLength={24}
          cawPriceUsd={cawPriceUsd}
          giftCaw={giftCaw}
          isTyping={isTyping}
          usernameAvailable={availabilityForCard}
          showAvailabilityMark={true}
          costRow={
            <div className="min-h-[1.25rem] flex items-start justify-between gap-3">
              <div className="flex-1 text-left">
                {cawCost > 0 && (
                  <p className={`text-xs ${nameTooExpensive ? 'text-red-500' : mutedClass} flex items-center gap-1`}>
                    <span>Mint cost:</span>
                    <span className={nameTooExpensive ? 'text-red-500 font-semibold' : strongClass}>
                      {formatCawCompact(cawCost)} CAW
                    </span>
                    {usdCost !== null && !nameTooExpensive && (
                      <span className={mutedClass}>(~${formatUsd(usdCost)})</span>
                    )}
                    <BoxedPricingTrigger cawPriceUsd={cawPriceUsd} giftCaw={giftCaw} />
                  </p>
                )}
                {username.length > 0 && !isValidFormat && !isTyping && (
                  <p className="text-xs text-red-500 mt-0.5">
                    {t('onboarding.username.format_hint')}
                  </p>
                )}
                {/* Gift gate: name too expensive */}
                {nameTooExpensive && giftCaw !== undefined && username.length > 0 && !isTyping && (
                  <p className="text-xs text-red-500 mt-0.5">
                    This name costs {formatCawCompact(cawCost)} CAW — your invite includes {formatWeiAsCaw(giftCaw)}. Try a longer name.
                  </p>
                )}
                {/* Gift gate: name too short per code minimum. No separate copy —
                    the "too expensive" line above already states the exact CAW the
                    invite covers vs the name's cost, which is the actionable info.
                    belowMinLength still gates Next / red state below. */}
              </div>
              <div className="text-right">
                {!isTyping && usernameAvailable === true && !nameTooExpensive && !belowMinLength && (
                  <p className="text-xs text-green-500">
                    {t('onboarding.username.available')}
                  </p>
                )}
                {!isTyping && usernameAvailable === false && (
                  <p className="text-xs text-red-500">
                    {t('onboarding.username.taken')}
                  </p>
                )}
              </div>
            </div>
          }
        />
      </div>

      {/* Auto-deposit summary — shown when name is valid and gift is loaded */}
      {depositAmount !== null && usernameAvailable === true && !nameTooExpensive && !belowMinLength && !isTyping && (
        <div className={`rounded-xl p-3 text-sm flex items-center gap-2 ${isDark ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
          <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className={isDark ? 'text-green-300' : 'text-green-800'}>
            You'll receive <span className="font-semibold">{formatWeiAsCaw(depositAmount)}</span> deposited to your profile.
          </span>
        </div>
      )}

      {/* Quick Sign — the SAME card as /usernames/new (QuickSignCard). Shown
          only when the parent threads its QS state (sponsored onboarding flow).
          The chosen spend limit / tip-per-action / expiry feed the post-mint
          registerSponsoredSession in Onboarding.tsx. */}
      {onQuickSignEnabledChange && onQuickSignExpandedChange &&
        onQsSpendLimitChange && onQsDurationChange && onQsTipCeilingChange && onQsWalletProtectChange && (
        <QuickSignCard
          enabled={quickSignEnabled ?? true}
          onEnabledChange={onQuickSignEnabledChange}
          expanded={quickSignExpanded ?? true}
          onExpandedChange={onQuickSignExpandedChange}
          spendLimit={qsSpendLimit ?? 0n}
          onSpendLimitChange={onQsSpendLimitChange}
          duration={qsDuration ?? 0}
          onDurationChange={onQsDurationChange}
          tipCeiling={qsTipCeiling ?? 0n}
          onTipCeilingChange={onQsTipCeilingChange}
          walletProtect={qsWalletProtect ?? false}
          onWalletProtectChange={onQsWalletProtectChange}
        />
      )}

      <button
        onClick={onNext}
        disabled={!canProceed}
        className={`
          w-full py-3 rounded-full font-semibold text-sm transition-all
          ${canProceed
            ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
            : isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
          }
        `}
      >
        {giftLoading ? 'Loading…' : t('common.next')}
      </button>
      </div>
    </UsernameCaptiveBody>
  )
}
