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

  return { isDark, toggle }
}
