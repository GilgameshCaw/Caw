import { useEffect, useLayoutEffect } from 'react'
import { useThemeStore } from '~/store/themeStore'
import { themeRootBgColor } from '~/utils/theme'

const THEME_SWITCHING_CLASS = 'theme-switching'

export const useTheme = () => {
  const { isDark, toggle } = useThemeStore()

  useLayoutEffect(() => {
    // Apply theme to HTML element
    const html = document.documentElement
    const rootBgColor = themeRootBgColor(isDark)
    html.classList.add(THEME_SWITCHING_CLASS)
    html.style.colorScheme = isDark ? 'dark' : 'light'
    document.body.style.colorScheme = isDark ? 'dark' : 'light'

    const themeBg = document.getElementById('theme-bg')
    if (isDark) {
      html.classList.add('dark')
      html.style.backgroundColor = rootBgColor
      document.body.style.backgroundColor = rootBgColor
      if (themeBg) themeBg.style.backgroundColor = rootBgColor
    } else {
      html.classList.remove('dark')
      html.style.backgroundColor = rootBgColor
      document.body.style.backgroundColor = rootBgColor
      if (themeBg) themeBg.style.backgroundColor = rootBgColor
    }

    const frame = window.requestAnimationFrame(() => {
      html.classList.remove(THEME_SWITCHING_CLASS)
    })

    return () => {
      window.cancelAnimationFrame(frame)
      html.classList.remove(THEME_SWITCHING_CLASS)
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
