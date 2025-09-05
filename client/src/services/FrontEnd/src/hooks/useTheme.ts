import { useEffect } from 'react'
import { useThemeStore } from '~/store/themeStore'

export const useTheme = () => {
  const { isDark, toggle } = useThemeStore()

  console.log('useTheme hook - isDark:', isDark, 'toggle function:', typeof toggle)

  useEffect(() => {
    console.log('Theme changed to:', isDark ? 'dark' : 'light')
    // Apply theme to HTML element
    const html = document.documentElement
    console.log('Current HTML classes:', html.className)
    
    if (isDark) {
      html.classList.add('dark')
      console.log('Added dark class to HTML')
    } else {
      html.classList.remove('dark')
      console.log('Removed dark class from HTML')
    }
    
    console.log('HTML classes after change:', html.className)
  }, [isDark])

  return { isDark, toggle }
}
