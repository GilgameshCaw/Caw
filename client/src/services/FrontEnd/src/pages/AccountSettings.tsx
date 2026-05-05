import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { clearKeyCache } from '~/services/DmCryptoService'
import { useAccount } from 'wagmi'
import { HiArrowLeft, HiClipboard, HiCheck, HiExternalLink, HiCurrencyDollar, HiUser, HiIdentification, HiKey, HiExclamation } from 'react-icons/hi'
import { formatCAWAmount } from '~/utils/numberFormat'
import ModalWrapper from '~/components/modals/ModalWrapper'
import Tooltip from '~/components/Tooltip'
import { getUserAvatar } from '~/utils/defaultAvatar'
import Avatar from '~/components/Avatar'
import XLogo from '~/components/icons/x-logo.svg?react'
import { apiFetch, API_HOST, AuthError } from '~/api/client'
import { useFollowerCounts } from '~/hooks/useFollowerCounts'
import { usePinnedProfilesStore } from '~/store/pinnedProfilesStore'
import { formatAddress } from '~/utils'
import { ThumbtackIcon } from '~/components/icons/ThumbtackIcon'
import { useT } from '~/i18n/I18nProvider'

// 401s on the X verification flow are expected when the user's session
// has expired or never authenticated for the active token — apiFetch's
// AuthError path already shows the verify-wallet modal as needed, so
// surfacing a red "Failed to start" toast on top of that is just noise.
function isAuthError(e: unknown): boolean {
  if (e instanceof AuthError) return true
  const msg = (e as { message?: string })?.message || ''
  return /^API 401\b/.test(msg)
}
import { formatFollowerBucket } from '~/components/XBadge'

interface XLink {
  xHandle: string
  xFollowerBucket: number | null
  linkedAt: string
}
interface WalletProfile {
  tokenId: number
  username: string
  xBadgeVisible: boolean
}
interface WalletStatus {
  link: XLink | null
  profiles: WalletProfile[]
}

/**
 * Build the OAuth callback URL the FE expects to land on. The redirect
 * has to come back to our backend (it's the route that exchanges the
 * code for a token), so we use the same API host apiFetch is currently
 * using. In dev that's empty (Vite proxy → same-origin), so we fall
 * through to window.location.origin.
 *
 * Important for decentralized mirrors: the X dev app must register
 * EVERY (FE → API) host pairing the operator supports as a Callback
 * URI. The backend doesn't enforce a strict allowlist — X does.
 */
function getRedirectUri(): string {
  const base = (API_HOST || window.location.origin).replace(/\/+$/, '')
  return `${base}/api/verify/x/callback`
}

/**
 * Mobile detection for the X OAuth flow. We use a top-level redirect on
 * mobile (no popup) because mobile popups are clunky — they open as a
 * sheet, in-app browsers (Twitter/Discord/Slack/Mastodon) hard-ban
 * cross-popup window.opener, and popup-blockers fire even on synchronous
 * opens in some configurations.
 *
 * Touch + narrow viewport is sufficient: phones and tablets get the
 * redirect path; desktops with touchscreens stay on the popup path
 * (they have the screen real estate for a popup window without it
 * feeling like a takeover).
 */
function isMobileDevice(): boolean {
  if (typeof window === 'undefined') return false
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const isNarrow = window.innerWidth < 768
  return hasTouch && isNarrow
}

/**
 * "Connected accounts" panel. Currently only X (Twitter) — links a CAW
 * wallet to an X handle and pulls the bucketed follower count once at
 * link time. The Connect button opens the OAuth start endpoint in a popup;
 * the callback page postMessages back when done. We don't store OAuth
 * tokens, so "Refresh follower count" walks the user through OAuth again.
 *
 * Wallet-scoped: every CAW profile owned by the linked wallet inherits
 * the X identity. Per-profile show/hide is controlled by the toggles
 * below — the profile that initiated the OAuth flow defaults to ON;
 * sibling profiles default to OFF until the user opts them in here.
 */
const ConnectedAccountsSection: React.FC<{ isDark: boolean; tokenId: number }> = ({ isDark, tokenId }) => {
  const [status, setStatus] = useState<WalletStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingTokenIds, setPendingTokenIds] = useState<Set<number>>(new Set())

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    try {
      const s = await apiFetch<WalletStatus>(`/api/verify/x/wallet-status?tokenId=${tokenId}`)
      setStatus(s)
    } catch (e: any) {
      if (isAuthError(e)) {
        // The verify-wallet modal (driven by apiFetch) handles re-auth.
        // Don't double up with a red toast here.
        console.warn('[xverify] wallet-status auth error, ignoring')
      } else {
        setError(e?.message || 'Failed to load')
      }
    } finally {
      if (!opts?.silent) setLoading(false)
    }
  }, [tokenId])

  useEffect(() => { refresh() }, [refresh])

  // Popup → opener channel via localStorage. Modern browsers sever
  // window.opener and lie about window.closed when a popup navigates
  // cross-origin (to x.com and back), so postMessage(opener) and
  // w.closed polling both fail silently. localStorage is shared across
  // same-origin tabs, and the `storage` event fires in OTHER documents
  // when a key changes — so when the callback page (same origin as us)
  // writes the result key, we receive it here.
  //
  // We accept the payload, optimistic-update, refresh from the server,
  // and clear the key so subsequent attempts don't replay the same
  // value. There's no "popup closed" path to handle separately —
  // either the result key is written or it isn't (e.g. user closed
  // popup early); in the latter case `busy` stays true. We add a
  // bounded fallback timeout so the user isn't stuck forever.
  const handleResult = useCallback((p: any) => {
    console.log('[xverify] handleResult', p)
    setBusy(false)
    if (p?.ok) {
      setError(null)
      if (typeof p.xHandle === 'string') {
        setStatus(prev => ({
          link: {
            xHandle:         p.xHandle,
            xFollowerBucket: typeof p.bucket === 'number' ? p.bucket : null,
            linkedAt:        new Date().toISOString(),
          },
          profiles: prev?.profiles ?? [],
        }))
      }
      refresh({ silent: true })
    } else {
      setError(humanizeError(p?.error))
    }
  }, [refresh])

  useEffect(() => {
    const STORAGE_KEY = 'caw:xverify:result'
    const consume = (raw: string | null) => {
      if (!raw) return
      let env: any
      try { env = JSON.parse(raw) } catch { return }
      if (env?.source !== 'caw-xverify' || !env?.payload) return
      // Clear the key BEFORE acting so we never re-fire on the next
      // storage event (different tab pattern, same browser session).
      try { localStorage.removeItem(STORAGE_KEY) } catch {}
      handleResult(env.payload)
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return
      console.log('[xverify] storage event', { newValue: e.newValue?.slice(0, 100) })
      consume(e.newValue)
    }
    window.addEventListener('storage', onStorage)
    // If the callback page wrote the key BEFORE we mounted (race on slow
    // initial render), pick it up on mount.
    consume(typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null)
    return () => window.removeEventListener('storage', onStorage)
  }, [handleResult])

  const startOAuth = useCallback(() => {
    // Session token lives in localStorage (not a cookie), so a popup can't
    // carry it. Authed POST to /start-popup returns the X auth URL.
    //
    // We send redirectUri so the backend doesn't have to assume what host
    // the FE is on — important for decentralized mirrors where the FE
    // and API may not share INSTANCE_API_URL.
    //
    // Two paths:
    //
    //   Desktop (popup): open a same-origin placeholder popup
    //     SYNCHRONOUSLY in the click handler so Safari's user-gesture
    //     check is satisfied, then navigate the popup to the X URL once
    //     the fetch resolves. The callback page writes the result to
    //     localStorage and self-closes; the storage event wakes us up.
    //
    //   Mobile (top-level redirect): popups on mobile are clunky (sheet
    //     UI, in-app browser quirks, opener-isolation hard-bans) and
    //     popup-blockers fire even with synchronous open in some
    //     configurations. So we send `returnTo` to the backend, which
    //     stashes it in the OAuth state, and after the callback page
    //     writes the result to localStorage it window.location.replace's
    //     us back to where we came from. AccountSettings' mount-time
    //     localStorage read picks up the result with no storage event
    //     needed.
    setBusy(true)
    setError(null)
    // Pre-clear any stale result from a previous attempt so the storage
    // listener can't fire on it when this attempt completes.
    try { localStorage.removeItem('caw:xverify:result') } catch {}

    const isMobile = isMobileDevice()
    let popup: Window | null = null

    if (!isMobile) {
      // Open the popup synchronously with a placeholder URL. Safari blocks
      // window.open() that isn't directly inside a user-gesture handler;
      // by opening *first* and navigating later, we stay inside the gesture.
      popup = window.open('about:blank', 'caw-xverify', 'width=600,height=700')
      if (!popup) {
        setBusy(false)
        setError('Popup was blocked. Allow popups for this site and try again.')
        return
      }
      // Friendly placeholder so the popup isn't a blank tab during the fetch.
      try {
        popup.document.write(
          '<!doctype html><meta charset="utf-8"><title>Connecting to X…</title>' +
          '<style>body{font:14px system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#000;color:#fff}</style>' +
          '<div>Connecting to X…</div>'
        )
      } catch { /* cross-origin doc.write can throw in some envs; harmless */ }
    }

    apiFetch<{ url: string }>('/api/verify/x/start-popup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tokenId,
        redirectUri: getRedirectUri(),
        // Only sent on mobile — backend uses presence to decide whether
        // the callback should redirect (mobile) or self-close (desktop).
        ...(isMobile ? { returnTo: window.location.href } : {}),
      }),
    })
      .then((res) => {
        if (isMobile) {
          // Top-level redirect — the user leaves this tab entirely. The
          // callback page will redirect back to returnTo when done.
          window.location.href = res.url
          return
        }
        // Navigate the already-open popup to the X auth URL.
        try { popup!.location.href = res.url } catch {
          // If the popup got closed before the fetch resolved, this throws.
          setBusy(false)
          setError('Popup was closed before connecting. Please try again.')
          return
        }
        // No w.closed watchdog — modern browsers lie about w.closed when
        // the popup is cross-origin, so we'd false-fire constantly. The
        // localStorage `storage` event is the success path. As a
        // fallback for the user-cancels-without-completing case, time
        // the busy state out so the button isn't stuck forever.
        setTimeout(() => {
          setBusy(prev => {
            if (!prev) return prev
            // Last-ditch refresh in case the link succeeded but the
            // storage event was missed (e.g. localStorage disabled,
            // private mode quirks). Cheap and harmless.
            refresh({ silent: true })
            return false
          })
        }, 60_000)
      })
      .catch((e) => {
        setBusy(false)
        // Close the placeholder popup so the user isn't left staring at
        // "Connecting to X…" forever.
        try { popup?.close() } catch {}
        if (isAuthError(e)) {
          console.warn('[xverify] start-popup auth error, ignoring')
        } else {
          setError(e?.message || 'Failed to start')
        }
      })
  }, [tokenId, refresh])

  const unlink = useCallback(async () => {
    if (!confirm('Unlink your X account from this wallet? Every profile owned by this wallet will lose its badge.')) return
    setBusy(true)
    setError(null)
    try {
      await apiFetch('/api/verify/x', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tokenId }),
      })
      await refresh()
    } catch (e: any) {
      if (isAuthError(e)) {
        console.warn('[xverify] unlink auth error, ignoring')
      } else {
        setError(e?.message || 'Failed to unlink')
      }
    } finally {
      setBusy(false)
    }
  }, [refresh, tokenId])

  // Toggle xBadgeVisible for a sibling profile. Optimistic flip locally;
  // mark the row pending so the toggle can show progress; reconcile on
  // server response. The auth on /x/visibility uses requireAuth({field}),
  // so we send each toggle's tokenId — but we only allow toggling tokens
  // we already know are owned by this wallet (server-side check is the
  // actual boundary; this just keeps the UX honest).
  const toggleVisibility = useCallback(async (targetTokenId: number, next: boolean) => {
    setPendingTokenIds(prev => new Set(prev).add(targetTokenId))
    setStatus(prev => prev && {
      ...prev,
      profiles: prev.profiles.map(p => p.tokenId === targetTokenId ? { ...p, xBadgeVisible: next } : p),
    })
    try {
      await apiFetch('/api/verify/x/visibility', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tokenId: targetTokenId, visible: next }),
      })
    } catch (e: any) {
      if (isAuthError(e)) {
        console.warn('[xverify] visibility-toggle auth error, ignoring')
      } else {
        setError(e?.message || 'Failed to update visibility')
      }
      // Roll back optimistic flip regardless — server didn't accept it
      setStatus(prev => prev && {
        ...prev,
        profiles: prev.profiles.map(p => p.tokenId === targetTokenId ? { ...p, xBadgeVisible: !next } : p),
      })
    } finally {
      setPendingTokenIds(prev => {
        const next = new Set(prev)
        next.delete(targetTokenId)
        return next
      })
    }
  }, [])

  const link      = status?.link ?? null
  const profiles  = status?.profiles ?? []
  const followers = formatFollowerBucket(link?.xFollowerBucket)

  return (
    <section className="mb-8">
      <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
        Connected Accounts
      </h2>
      <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-100'}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isDark ? 'bg-black text-white' : 'bg-black text-white'}`}>
              <XLogo className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>X (Twitter)</p>
              <p className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                {loading
                  ? 'Loading…'
                  : link
                    ? `@${link.xHandle}${followers ? ` · ${followers} followers` : ''}`
                    : 'Prove this wallet controls an X handle to earn a verified badge.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {link ? (
              <>
                <button
                  type="button"
                  onClick={startOAuth}
                  disabled={busy}
                  className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                    isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-white border border-gray-300 hover:bg-gray-100 text-gray-900'
                  } ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={unlink}
                  disabled={busy}
                  className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                    isDark ? 'text-red-400 hover:bg-red-500/10' : 'text-red-600 hover:bg-red-50'
                  } ${busy ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  Unlink
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={startOAuth}
                disabled={busy || loading}
                className={`px-5 py-1.5 text-sm font-semibold rounded-full transition-colors bg-yellow-500 hover:bg-yellow-400 text-black ${
                  busy || loading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                }`}
              >
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            )}
          </div>
        </div>

        {/* Per-profile visibility — only meaningful once the wallet has
            an X link. Hidden until then so the panel stays clean. */}
        {link && profiles.length > 0 && (
          <div className={`mt-4 pt-4 border-t ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
            <p className={`text-xs uppercase tracking-wide mb-2 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
              Show badge on
            </p>
            <ul className="space-y-1">
              {profiles.map(p => (
                <li key={p.tokenId} className="flex items-center justify-between gap-3 py-1">
                  <span className={`text-sm truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    @{p.username}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleVisibility(p.tokenId, !p.xBadgeVisible)}
                    disabled={pendingTokenIds.has(p.tokenId)}
                    aria-pressed={p.xBadgeVisible}
                    className={`relative w-10 min-w-[40px] h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${
                      p.xBadgeVisible ? 'bg-yellow-500' : (isDark ? 'bg-white/15' : 'bg-gray-300')
                    } ${pendingTokenIds.has(p.tokenId) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {/* Use a <div> not a <span> for the thumb — Tailwind's
                        w/h work on spans only after position:absolute
                        promotes them, and some upstream resets on `span`
                        leak through to break dimensions. The reference
                        toggle in pages/Profile/New.tsx uses div for the
                        same reason. */}
                    <div
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                        p.xBadgeVisible ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-500 mt-2">{error}</p>
        )}
      </div>
    </section>
  )
}

function humanizeError(code?: string): string {
  switch (code) {
    case 'cancelled':                return 'X authorization was cancelled.'
    case 'invalid_state':            return 'The authorization link expired. Try again.'
    case 'token_exchange_failed':    return 'Could not exchange the X authorization. Try again.'
    case 'me_fetch_failed':          return 'X authorization succeeded but we could not read your profile. Try again.'
    case 'malformed_x_response':     return 'X returned an unexpected response. Try again.'
    case 'x_account_already_linked': return 'That X account is already linked to a different CAW profile.'
    default:                         return 'Something went wrong. Please try again.'
  }
}

const AccountSettings: React.FC = () => {
  const t = useT()
  const { isDark } = useTheme()
  const { address, isConnected } = useAccount()
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [showClearDataModal, setShowClearDataModal] = useState(false)
  const [showLogoutModal, setShowLogoutModal] = useState(false)

  // The store has both a (deprecated) global activeTokenId and a
  // per-address activeTokenIdByAddress; useActiveToken() walks the
  // fallback chain (global → per-address → first owned) so this page
  // works regardless of which one is populated.
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const setActiveTokenId = useTokenDataStore(s => s.setActiveTokenId)
  const setLastAddress   = useTokenDataStore(s => s.setLastAddress)

  // Mirror ProfileChooser.handleSelectProfile so the All Usernames rows
  // act as a profile-switcher. setLastAddress drives useTokenDataUpdate
  // to re-fetch for this token's owner.
  const handleSelectProfile = (token: { tokenId: number; address?: string }) => {
    if (token.tokenId === activeTokenId) return
    setActiveTokenId(token.tokenId)
    if (token.address) setLastAddress(token.address.toLowerCase())
  }

  // Show every wallet the user has profiles in, grouped. Within each wallet
  // sort by pinned-first (most-recent pin wins), then follower count desc.
  // Active token's wallet is placed FIRST so the user lands on their
  // current context, then sees other wallets below.
  const allTokens = Object.values(tokensByAddress).flat()
  const followerCounts = useFollowerCounts(allTokens.map(t => t.tokenId))
  const pinnedAt = usePinnedProfilesStore(s => s.pinnedAt)
  const togglePin = usePinnedProfilesStore(s => s.togglePin)

  const activeOwnerKey = activeToken?.address?.toLowerCase()
  const walletKeys = Object.keys(tokensByAddress)
  const otherWallets = walletKeys.filter(k => k.toLowerCase() !== activeOwnerKey)
  const orderedWalletKeys = [
    ...(activeOwnerKey && walletKeys.some(k => k.toLowerCase() === activeOwnerKey)
        ? [walletKeys.find(k => k.toLowerCase() === activeOwnerKey)!]
        : []),
    ...otherWallets,
  ]
  const tokensByWalletSorted: Array<{ address: string; tokens: typeof allTokens }> = orderedWalletKeys
    .map(addr => ({
      address: addr,
      tokens: (tokensByAddress[addr.toLowerCase() as `0x${string}`] || [])
        .slice()
        .sort((a, b) => {
          const ap = pinnedAt[a.tokenId]
          const bp = pinnedAt[b.tokenId]
          if (ap && bp) return bp.localeCompare(ap)
          if (ap) return -1
          if (bp) return 1
          return (followerCounts[b.tokenId] ?? 0) - (followerCounts[a.tokenId] ?? 0)
        }),
    }))
    .filter(g => g.tokens.length > 0)

  const handleLogoutCurrentAccount = () => {
    if (!activeTokenId) return
    // Clear DM keys for this account only
    clearKeyCache(activeTokenId)
    // Clear session key (wallet-level, but appropriate for logout)
    useSessionKeyStore.getState().clearSession()
    // Remove this token from the profile chooser and deactivate it
    useTokenDataStore.getState().removeToken(activeTokenId)
    // Clear auth session
    useAuthStore.getState().clearSession()
    setShowLogoutModal(false)
    window.location.reload()
  }

  const handleClearAllData = () => {
    // Clear Zustand persisted stores
    useTokenDataStore.getState().removeActiveToken?.()
    useAuthStore.getState().clearSession()
    // Clear session key
    useSessionKeyStore.getState().clearSession()
    // Clear DM key cache
    clearKeyCache()
    // Clear all CAW-related localStorage keys
    const keysToRemove = [
      'caw-token-data', 'caw-auth-session', 'caw-session-keys',
      'mutedThreads', 'mutedWords', 'hiddenPosts', 'mutedAccounts',
      'caw-blocked-users', 'reportedPosts', 'notificationPreferences',
      'lastStakeTime', 'hideMuteConfirmModal'
    ]
    keysToRemove.forEach(key => localStorage.removeItem(key))
    setShowClearDataModal(false)
    // Reload to reset all in-memory state
    window.location.reload()
  }

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  const InfoRow: React.FC<{
    icon: React.ReactNode
    label: string
    value: string
    copyable?: boolean
    copyValue?: string
    link?: string
  }> = ({ icon, label, value, copyable, copyValue, link }) => (
    <div className={`flex items-center justify-between py-4 border-b ${
      isDark ? 'border-white/10' : 'border-gray-100'
    }`}>
      <div className="flex items-center gap-3">
        <div className={isDark ? 'text-white/60' : 'text-gray-500'}>
          {icon}
        </div>
        <div>
          <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
            {label}
          </p>
          <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {value}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {copyable && (
          <Tooltip text="Copy to clipboard">
            <button
              onClick={() => copyToClipboard(copyValue || value, label)}
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
              }`}
            >
              {copiedField === label ? (
                <HiCheck className="w-5 h-5 text-green-500" />
              ) : (
                <HiClipboard className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
              )}
            </button>
          </Tooltip>
        )}
        {link && (
          <Tooltip text="View on explorer">
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className={`p-2 rounded-lg transition-colors ${
                isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
              }`}
            >
              <HiExternalLink className={`w-5 h-5 ${isDark ? 'text-white/60' : 'text-gray-500'}`} />
            </a>
          </Tooltip>
        )}
      </div>
    </div>
  )

  return (
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('account.title')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('account.subtitle')}
            </p>
          </div>
        </div>

        {/* All Usernames Section — grouped by owning wallet, sorted by follower
            count desc within each group. Active token's wallet renders first. */}
        {allTokens.length > 1 && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              {t('account.section.all_usernames')} ({allTokens.length})
            </h2>

            <div className="space-y-6">
              {tokensByWalletSorted.map(group => (
                <div key={group.address}>
                  <div className="flex items-center justify-between mb-2 px-1">
                    <span className={`text-xs font-mono ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {formatAddress(group.address)}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {group.tokens.map(token => {
                      const isActive = token.tokenId === activeTokenId
                      const isPinned = !!pinnedAt[token.tokenId]
                      return (
                      <div
                        key={token.tokenId}
                        className={`flex items-center justify-between p-4 rounded-lg transition-colors ${
                          isActive
                            ? isDark ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-50 border border-yellow-200'
                            : isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectProfile(token)}
                          disabled={isActive}
                          aria-current={isActive ? 'true' : undefined}
                          className={`flex items-center gap-3 flex-1 text-left ${isActive ? 'cursor-default' : 'cursor-pointer'}`}
                        >
                          <Avatar
                            src={getUserAvatar(token)}
                            alt={token.username}
                            className="w-10 h-10 rounded-full"
                            size="small"
                          />
                          <div>
                            <p className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                              @{token.username}
                            </p>
                            <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                              Token #{token.tokenId}
                              {followerCounts[token.tokenId] !== undefined && (
                                <span className="ml-2">· {followerCounts[token.tokenId]} followers</span>
                              )}
                            </p>
                          </div>
                        </button>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {isActive && (
                            <span className={`text-xs px-2 py-1 rounded-full ${
                              isDark ? 'bg-yellow-500/20 text-yellow-500' : 'bg-yellow-100 text-yellow-700'
                            }`}>
                              {t('account.active')}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => togglePin(token.tokenId)}
                            aria-label={isPinned ? 'Unpin profile' : 'Pin profile'}
                            aria-pressed={isPinned}
                            title={isPinned ? 'Unpin profile' : 'Pin profile to top of dropdown'}
                            className={`p-2 rounded-full transition-colors ${
                              isPinned
                                ? isDark ? 'text-yellow-400 hover:bg-white/10' : 'text-yellow-600 hover:bg-gray-200'
                                : isDark ? 'text-white/30 hover:text-white/60 hover:bg-white/10' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-200'
                            }`}
                          >
                            <ThumbtackIcon className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Wallet Section */}
        {isConnected && address && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              {t('account.section.wallet')}
            </h2>

            <InfoRow
              icon={<HiKey className="w-5 h-5" />}
              label={t('account.label.address')}
              value={truncateAddress(address)}
              copyable
              copyValue={address}
              link={`https://etherscan.io/address/${address}`}
            />
          </section>
        )}

        {/* Active Username Section */}
        {activeToken && (
          <section className="mb-8">
            <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
              isDark ? 'text-white/40' : 'text-gray-400'
            }`}>
              {t('account.section.active_username')}
            </h2>

            <InfoRow
              icon={<HiUser className="w-5 h-5" />}
              label={t('account.label.username')}
              value={`@${activeToken.username}`}
            />

            <InfoRow
              icon={<HiIdentification className="w-5 h-5" />}
              label={t('account.label.token_id')}
              value={`#${activeToken.tokenId}`}
            />

            <InfoRow
              icon={<HiCurrencyDollar className="w-5 h-5" />}
              label={t('account.label.staked')}
              value={formatCAWAmount(activeToken.stakedAmount || '0')}
            />
          </section>
        )}

        {/* Connected Accounts */}
        {activeTokenId && (
          <ConnectedAccountsSection isDark={isDark} tokenId={activeTokenId} />
        )}

        {/* Contract Info */}
        <section className="mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            {t('account.section.contract')}
          </h2>

          <div className={`p-4 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
            <div className="flex items-center justify-between mb-3">
              <span className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                CAW Token
              </span>
              <a
                href="https://etherscan.io/token/0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                target="_blank"
                rel="noopener noreferrer"
                className={`text-sm flex items-center gap-1 ${
                  isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-600 hover:text-yellow-700'
                }`}
              >
                0xf3b9...e452
                <HiExternalLink className="w-4 h-4" />
              </a>
            </div>
            <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              {t('account.contract.note')}
            </p>
          </div>
        </section>

        {/* Manage Profile Link */}
        {activeToken && (
          <Link
            to={`/users/${activeToken.username}`}
            className={`flex items-center justify-between py-4 px-4 rounded-lg transition-colors ${
              isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
            }`}
          >
            <div>
              <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('account.view_profile.title')}
              </h3>
              <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                {t('account.view_profile.description')}
              </p>
            </div>
            <svg
              className={`w-5 h-5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        )}

        {/* Browser Data */}
        <section className="mt-12 mb-8">
          <h2 className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
            isDark ? 'text-white/40' : 'text-gray-400'
          }`}>
            {t('account.section.browser_data')}
          </h2>

          {/* Log out current account */}
          {activeToken && (
            <button
              onClick={() => setShowLogoutModal(true)}
              className={`w-full flex items-center justify-between py-4 px-4 rounded-lg transition-colors cursor-pointer mb-3 ${
                isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
              }`}
            >
              <div className="text-left">
                <h3 className={`font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {t('account.logout.title', { username: activeToken.username })}
                </h3>
                <p className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  {t('account.logout.description')}
                </p>
              </div>
              <svg className={`w-5 h-5 ${isDark ? 'text-white/40' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          )}

          {/* Clear all data */}
          <button
            onClick={() => setShowClearDataModal(true)}
            className={`w-full flex items-center justify-between py-4 px-4 rounded-lg transition-colors cursor-pointer ${
              isDark ? 'bg-red-500/10 hover:bg-red-500/20' : 'bg-red-50 hover:bg-red-100'
            }`}
          >
            <div className="text-left">
              <h3 className={`font-medium ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                {t('account.clear_data.title')}
              </h3>
              <p className={`text-sm ${isDark ? 'text-red-400/60' : 'text-red-500/70'}`}>
                {t('account.clear_data.description')}
              </p>
            </div>
            <HiExclamation className={`w-5 h-5 ${isDark ? 'text-red-400' : 'text-red-500'}`} />
          </button>
        </section>

        {/* Clear Data Confirmation Modal */}
        <ModalWrapper isOpen={showClearDataModal} onClose={() => setShowClearDataModal(false)} maxWidth="max-w-sm">
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-red-500/20">
                <HiExclamation className="w-5 h-5 text-red-500" />
              </div>
              <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Clear All Browser Data?
              </h3>
            </div>

            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
              This will permanently remove all locally stored data from this browser. This action cannot be undone.
            </p>

            <div className={`text-sm space-y-2 p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <p className={`font-medium mb-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>This will:</p>
              <ul className={`space-y-1.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Revoke Quick Sign session keys
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Disable DMs (you'll need to re-enable)
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Remove all attached wallet data
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Clear muted/blocked accounts and hidden posts
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">•</span>
                  Reset notification preferences
                </li>
              </ul>
            </div>

            <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              Your on-chain data (username, staked CAW, NFTs) is not affected.
            </p>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowClearDataModal(false)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  isDark
                    ? 'bg-white/10 text-white hover:bg-white/20'
                    : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                }`}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleClearAllData}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors cursor-pointer"
              >
                Clear Everything
              </button>
            </div>
          </div>
        </ModalWrapper>

        {/* Logout Current Account Modal */}
        <ModalWrapper isOpen={showLogoutModal} onClose={() => setShowLogoutModal(false)} maxWidth="max-w-sm">
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-full ${isDark ? 'bg-white/10' : 'bg-gray-100'}`}>
                <svg className={`w-5 h-5 ${isDark ? 'text-white' : 'text-gray-700'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </div>
              <h3 className={`text-lg font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                Log Out @{activeToken?.username}?
              </h3>
            </div>

            <p className={`text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
              This will log out the current account from this browser. Other accounts are not affected.
            </p>

            <div className={`text-sm space-y-2 p-3 rounded-lg ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
              <p className={`font-medium mb-2 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>This will:</p>
              <ul className={`space-y-1.5 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                <li className="flex items-start gap-2">
                  <span className="text-yellow-500 mt-0.5">•</span>
                  End your login session
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-yellow-500 mt-0.5">•</span>
                  Revoke Quick Sign session key
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-yellow-500 mt-0.5">•</span>
                  Clear DM encryption keys for this account
                </li>
              </ul>
            </div>

            <p className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              Your muted/blocked lists, preferences, and other accounts are not affected.
            </p>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowLogoutModal(false)}
                className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${
                  isDark
                    ? 'bg-white/10 text-white hover:bg-white/20'
                    : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
                }`}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleLogoutCurrentAccount}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium bg-yellow-500 text-black hover:bg-yellow-600 transition-colors cursor-pointer"
              >
                Log Out
              </button>
            </div>
          </div>
        </ModalWrapper>
      </div>
  )
}

export default AccountSettings
