import React, { Fragment, useEffect, useState } from 'react'
import { Listbox, Transition } from '@headlessui/react'
import { useQueryClient } from '@tanstack/react-query'
import { HiTranslate } from 'react-icons/hi'
import { useLocation, useNavigate } from 'react-router-dom'
import { LANGUAGES } from '~/constants/languages'
import { apiFetch } from '~/api/client'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useUserByToken } from '~/hooks/useUserData'
import { useTheme } from '~/hooks/useTheme'
import { stripLocalePrefix, withLocalePrefix } from '~/utils/localePrefix'

export const VIEWER_LANG_STORAGE_KEY = 'caw:viewer-lang'

export function getStoredViewerLanguage(): string {
  try { return localStorage.getItem(VIEWER_LANG_STORAGE_KEY) || '' } catch { return '' }
}

interface Props {
  className?: string
  // 'bottom' (default): panel drops below the button — desktop header /
  //   in-app placements that have room underneath.
  // 'right': panel opens to the right of the button, aligned to its top.
  //   Used in the mobile landing drawer, where the button sits low-left
  //   and a downward panel would collide with the mobile browser chrome.
  placement?: 'bottom' | 'right'
}

const LanguageSwitcher: React.FC<Props> = ({ className = '', placement = 'bottom' }) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isTokenAuthorized = useAuthStore(s => s.isTokenAuthorized)
  const { data: user, refetch } = useUserByToken(tokenId)
  const queryClient = useQueryClient()
  // Bypass the localizedRouter wrapper here — switching to a non-current
  // locale is the one place we WANT to rewrite the prefix explicitly.
  const navigate = useNavigate()
  const location = useLocation()

  const [value, setValue] = useState<string>(() => getStoredViewerLanguage())

  useEffect(() => {
    const userPref = (user?.preferredLanguage as string | undefined) ?? ''
    if (userPref) setValue(userPref)
  }, [user?.preferredLanguage])

  const onChange = async (code: string) => {
    setValue(code)
    try { localStorage.setItem(VIEWER_LANG_STORAGE_KEY, code) } catch { /* private mode, etc. */ }
    window.dispatchEvent(new Event('caw:viewer-lang-changed'))

    // Rewrite the URL to reflect the new locale. Without this the URL
    // would stay /es/users/maria after switching to French — and the
    // I18nProvider (which reads URL first) would keep showing Spanish UI
    // until the user navigated. Strip any existing locale prefix first,
    // then add the new one (no-op for English; bare paths are canonical
    // for English).
    const bare = stripLocalePrefix(location.pathname)
    const targetPath = withLocalePrefix(bare, code || null)
    const target = `${targetPath}${location.search}${location.hash}`
    if (target !== location.pathname + location.search + location.hash) {
      navigate(target, { replace: true })
    }

    // Only persist server-side when the viewer actually has a session for
    // this tokenId. Skipping the PATCH for a stale/unauthenticated token
    // avoids the apiFetch 401 → VerifyWalletModal pop on the splash, where
    // a first-time visitor picks a language before signing in.
    if (tokenId && isTokenAuthorized(tokenId)) {
      try {
        await apiFetch(`/api/users/${tokenId}/language`, {
          method: 'PATCH',
          body: JSON.stringify({ preferredLanguage: code === '' ? null : code }),
        })
        queryClient.invalidateQueries({ queryKey: ['userByToken', tokenId] })
        refetch()
      } catch (e) {
        console.error('Failed to persist language pref:', e)
      }
    }
  }

  // rounded-lg (not full) so the button reads as a square-ish control,
  // visually distinct from the circular profile avatar that can sit
  // next to it in the captive header.
  const buttonClass = `w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer border ${
    isDark
      ? 'bg-white/10 text-white border-transparent hover:border-white/40'
      : 'bg-black/5 text-black border-transparent hover:border-black/30'
  }`
  const panelPos = placement === 'right'
    ? 'left-0 top-0'
    : 'right-0 mt-1'
  const panelClass = `absolute ${panelPos} w-56 rounded-xl border shadow-lg z-[60] overflow-hidden ${
    isDark ? 'bg-neutral-900 border-white/10' : 'bg-white border-gray-200'
  }`

  return (
    <Listbox value={value} onChange={onChange}>
      <div className={`relative ${className}`}>
        <Listbox.Button className={buttonClass} aria-label="Select language">
          <HiTranslate className="w-5 h-5" />
        </Listbox.Button>
        <Transition as={Fragment} leave="transition ease-in duration-100" leaveFrom="opacity-100" leaveTo="opacity-0">
          <Listbox.Options className={panelClass}>
            <div className="max-h-72 overflow-auto p-1">
              {LANGUAGES.map(l => {
                const label = l.name + (l.name !== l.native ? ` (${l.native})` : '')
                return (
                  <Listbox.Option key={l.code} value={l.code}>
                    {({ active, selected }) => (
                      <div
                        className={`px-3 py-2 rounded-lg text-sm cursor-pointer select-none flex items-center justify-between gap-2 ${
                          selected
                            ? isDark
                              ? 'bg-yellow-500/20 text-yellow-200'
                              : 'bg-yellow-100 text-yellow-800'
                            : ''
                        } ${
                          active && !selected
                            ? isDark
                              ? 'bg-white/10 text-white'
                              : 'bg-gray-100 text-gray-900'
                            : ''
                        } ${!active && !selected ? (isDark ? 'text-white' : 'text-gray-900') : ''}`}
                      >
                        <span className="truncate">{label}</span>
                        {selected && (
                          <svg className={`h-4 w-4 flex-shrink-0 ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    )}
                  </Listbox.Option>
                )
              })}
            </div>
          </Listbox.Options>
        </Transition>
      </div>
    </Listbox>
  )
}

export default LanguageSwitcher
