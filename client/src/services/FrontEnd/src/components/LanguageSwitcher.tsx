import React, { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LANGUAGES } from '~/constants/languages'
import { apiFetch } from '~/api/client'
import { useActiveToken } from '~/store/tokenDataStore'
import { useUserByToken } from '~/hooks/useUserData'
import ThemedListbox from '~/components/forms/ThemedListbox'
import { useTheme } from '~/hooks/useTheme'

export const VIEWER_LANG_STORAGE_KEY = 'caw:viewer-lang'

export function getStoredViewerLanguage(): string {
  try { return localStorage.getItem(VIEWER_LANG_STORAGE_KEY) || '' } catch { return '' }
}

interface Props {
  className?: string
  /** When true, shows only the native label (compact form). */
  compact?: boolean
}

const LanguageSwitcher: React.FC<Props> = ({ className = '', compact = false }) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const { data: user, refetch } = useUserByToken(tokenId)
  const queryClient = useQueryClient()

  const [value, setValue] = useState<string>(() => getStoredViewerLanguage())

  useEffect(() => {
    const userPref = (user?.preferredLanguage as string | undefined) ?? ''
    if (userPref) setValue(userPref)
  }, [user?.preferredLanguage])

  const onChange = async (code: string) => {
    setValue(code)
    try { localStorage.setItem(VIEWER_LANG_STORAGE_KEY, code) } catch {}
    window.dispatchEvent(new Event('caw:viewer-lang-changed'))

    if (tokenId) {
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

  return (
    <ThemedListbox
      isDark={isDark}
      value={value}
      onChange={onChange}
      className={className}
      options={LANGUAGES.map(l => ({
        value: l.code,
        label: compact ? l.native : (l.name + (l.name !== l.native ? ` (${l.native})` : '')),
      }))}
    />
  )
}

export default LanguageSwitcher
