/** Common theme-aware class name helpers to reduce isDark ternary repetition */

export const themeText = (isDark: boolean) => isDark ? 'text-white' : 'text-gray-900'
export const themeTextMuted = (isDark: boolean) => isDark ? 'text-gray-400' : 'text-gray-500'
export const themeTextSecondary = (isDark: boolean) => isDark ? 'text-gray-300' : 'text-gray-600'
export const themeBg = (isDark: boolean) => isDark ? 'bg-black' : 'bg-white'
export const themeBgSubtle = (isDark: boolean) => isDark ? 'bg-white/5' : 'bg-gray-50'
export const themeBgHover = (isDark: boolean) => isDark ? 'bg-white/10' : 'bg-gray-100'
export const themeBorder = (isDark: boolean) => isDark ? 'border-white/10' : 'border-gray-200'
export const themeBorderStrong = (isDark: boolean) => isDark ? 'border-white/20' : 'border-gray-300'
export const themeDivide = (isDark: boolean) => isDark ? 'divide-white/10' : 'divide-gray-200'
export const themeHoverText = (isDark: boolean) => isDark ? 'hover:text-white' : 'hover:text-black'
export const themeInput = (isDark: boolean) =>
  isDark
    ? 'bg-white/5 border-white/10 text-white placeholder-white/30'
    : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
export const themeSecondaryButton = (isDark: boolean) =>
  isDark
    ? 'bg-white/10 hover:bg-white/20 text-white'
    : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
