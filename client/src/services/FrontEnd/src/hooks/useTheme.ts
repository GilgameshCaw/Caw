import { useEffect } from 'react'
import { useThemeStore } from '~/store/themeStore'

export const useTheme = () => {
  const { isDark, toggle } = useThemeStore()

  useEffect(() => {
    // Apply theme to HTML element
    const html = document.documentElement

    if (isDark) {
      html.classList.add('dark')
      html.style.background = '#000'
    } else {
      html.classList.remove('dark')
      html.style.background = 'transparent'
    }
  }, [isDark])

  // Sync theme across tabs: when the theme-storage localStorage entry changes
  // in another tab, rehydrate the Zustand store so this tab updates too.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'theme-storage' || !e.newValue) return
      try {
        const parsed = JSON.parse(e.newValue)
        const nextIsDark = parsed?.state?.isDark
        if (typeof nextIsDark === 'boolean' && nextIsDark !== useThemeStore.getState().isDark) {
          useThemeStore.setState({ isDark: nextIsDark })
        }
      } catch {
        // Ignore malformed values
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  return { isDark, toggle }
}
