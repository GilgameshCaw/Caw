// Server twin of FrontEnd/src/utils/localePrefix.ts. Locale list MUST
// stay in sync with src/services/FrontEnd/src/i18n/index.ts LOADERS.
// English is bare; every other locale is URL-prefixed.

const SUPPORTED_LOCALES = new Set<string>([
  'es','zh','hi','ar','pt','ru','ja','de','fr','ko','it','tr','fa','pl',
  'nl','vi','th','id','tl','uk','he',
])

export const ALL_LOCALES = ['en', ...SUPPORTED_LOCALES]

export function hasLocale(code: string): boolean {
  return code === 'en' || SUPPORTED_LOCALES.has(code)
}

export interface ParsedPath {
  locale: string | null
  restPath: string
}

export function parseLocaleFromPath(pathname: string): ParsedPath {
  const m = pathname.match(/^\/([a-z]{2,3})(?=\/|$)(.*)$/)
  if (!m) return { locale: null, restPath: pathname }
  const candidate = m[1]
  if (candidate === 'en') return { locale: null, restPath: m[2] || '/' }
  if (!SUPPORTED_LOCALES.has(candidate)) return { locale: null, restPath: pathname }
  return { locale: candidate, restPath: m[2] || '/' }
}

export function withLocalePrefix(path: string, locale: string | null): string {
  if (!locale || locale === 'en') return path
  if (!path.startsWith('/')) path = '/' + path
  return `/${locale}${path}`
}

export function stripLocalePrefix(path: string): string {
  return parseLocaleFromPath(path).restPath
}
