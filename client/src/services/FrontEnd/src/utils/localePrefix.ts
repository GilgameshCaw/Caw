// Locale-prefixed URL helpers. English is bare, every other supported
// locale is prefixed:
//   English:    /users/maria/caw/123-slug
//   Spanish:    /es/users/maria/caw/123-slug
//   Japanese:   /ja/users/maria
//
// The URL is the source of truth for locale when present. I18nProvider
// reads parseLocaleFromPath() first, falls back to user preference.
//
// Bare English keeps every existing share link valid and avoids the
// /en/ vs no-prefix canonical ambiguity that splits Google ranking on
// many multilingual sites.

import { hasLocale } from '~/i18n'

export interface ParsedPath {
  /** Locale code from the URL prefix, or null when bare (English). */
  locale: string | null
  /** The rest of the path after the locale prefix. Always starts with '/'. */
  restPath: string
}

/**
 * Split a pathname into `{ locale, restPath }`. The locale is recognized
 * only when the first segment matches a supported non-English catalog
 * (so /maria — a real username — does not get parsed as locale "maria").
 *
 * English ('en') is intentionally NOT recognized as a prefix: /en/... is
 * canonicalized down to /... by the server redirect layer.
 */
export function parseLocaleFromPath(pathname: string): ParsedPath {
  const m = pathname.match(/^\/([a-z]{2,3})(?=\/|$)(.*)$/)
  if (!m) return { locale: null, restPath: pathname }
  const candidate = m[1]
  if (candidate === 'en') return { locale: null, restPath: m[2] || '/' }
  if (!hasLocale(candidate)) return { locale: null, restPath: pathname }
  return { locale: candidate, restPath: m[2] || '/' }
}

/**
 * Add a locale prefix to a bare path. No-op for English (bare), and
 * idempotent if the path already starts with the same locale.
 *
 * Always pass a bare path (call stripLocalePrefix first if unsure).
 */
export function withLocalePrefix(path: string, locale: string | null): string {
  if (!locale || locale === 'en') return path
  if (!path.startsWith('/')) path = '/' + path
  return `/${locale}${path}`
}

/**
 * Strip any leading locale prefix from a path. Bare paths pass through
 * unchanged.
 */
export function stripLocalePrefix(path: string): string {
  return parseLocaleFromPath(path).restPath
}
