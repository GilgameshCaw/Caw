import { useEffect } from 'react'
import { useThemeStore } from '~/store/themeStore'

export const useTheme = () => {
  const { isDark, toggle } = useThemeStore()

  useEffect(() => {
    // Apply theme to HTML element
    const html = document.documentElement

    if (isDark) {
      html.classList.add('dark')
    } else {
      html.classList.remove('dark')
    }
  }, [isDark])

  return { isDark, toggle }
}
