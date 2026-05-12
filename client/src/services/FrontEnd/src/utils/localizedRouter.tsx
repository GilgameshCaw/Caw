// Drop-in wrappers around react-router-dom's <Link> and useNavigate()
// that prepend the current URL locale prefix to absolute paths.
//
// Why this shape: with 50+ routes and hundreds of navigation callsites,
// editing every URL builder to thread a locale prop is enormous churn
// and easy to half-do. Wrapping at the router boundary means every
// navigation in the app picks up locale-awareness with one import
// swap per file. The same patterns react-router users know
// (Link to="/foo", navigate('/foo'), navigate(-1)) keep working.
//
// Migration:
//   import { Link, useNavigate } from 'react-router-dom'
//     ↓
//   import { Link, useNavigate } from '~/utils/localizedRouter'
//
// Already-prefixed paths (e.g. '/es/users/x' built by user-facing
// language switcher code) are passed through unchanged. Anchors,
// search-only, and hash-only nav targets pass through too.

import React, { useCallback } from 'react'
import {
  Link as RouterLink,
  type LinkProps,
  NavLink as RouterNavLink,
  type NavLinkProps,
  useLocation,
  useNavigate as useRouterNavigate,
  type NavigateOptions,
  type To,
} from 'react-router-dom'
import { parseLocaleFromPath, withLocalePrefix } from './localePrefix'

/**
 * Read the locale from the current URL. Returns null when English /
 * unprefixed. The locale state lives in the URL, not in any provider,
 * so this hook is just a thin wrapper over useLocation().
 */
export function useUrlLocale(): string | null {
  const location = useLocation()
  return parseLocaleFromPath(location.pathname).locale
}

/**
 * Rewrite a navigation target to include the current URL locale prefix.
 * Pass-through for:
 *   - Non-string targets (a `To` partial — react-router-dom shape)
 *   - Paths that don't start with '/' (relative / hash / search-only)
 *   - Paths that ALREADY start with /<supported-locale>/ — assumes the
 *     caller built that intentionally (e.g. the language switcher)
 *
 * Numeric delta navigation (navigate(-1)) bypasses this entirely; the
 * useLocalizedNavigate() wrapper short-circuits on number args.
 */
function localizeTarget(to: To, locale: string | null): To {
  if (locale == null) return to
  if (typeof to !== 'string') {
    // To partial — { pathname, search, hash }. Only rewrite pathname.
    if (!to.pathname || !to.pathname.startsWith('/')) return to
    if (parseLocaleFromPath(to.pathname).locale != null) return to
    return { ...to, pathname: withLocalePrefix(to.pathname, locale) }
  }
  if (!to.startsWith('/')) return to
  // Already has a locale prefix? Leave it alone.
  if (parseLocaleFromPath(to).locale != null) return to
  return withLocalePrefix(to, locale)
}

/**
 * Drop-in replacement for react-router-dom's <Link>. Prepends the
 * current URL locale to `to` when present.
 */
export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  function LocalizedLink({ to, ...rest }, ref) {
    const locale = useUrlLocale()
    return <RouterLink ref={ref} to={localizeTarget(to, locale)} {...rest} />
  },
)

/**
 * Drop-in replacement for react-router-dom's <NavLink>. Same locale
 * rewrite as <Link>; the active-state matching that NavLink does
 * internally still works because it compares the resolved (prefixed)
 * `to` against the current pathname (also prefixed).
 */
export const NavLink = React.forwardRef<HTMLAnchorElement, NavLinkProps>(
  function LocalizedNavLink({ to, ...rest }, ref) {
    const locale = useUrlLocale()
    return <RouterNavLink ref={ref} to={localizeTarget(to, locale)} {...rest} />
  },
)

/**
 * Drop-in replacement for react-router-dom's useNavigate(). The
 * returned navigate function rewrites string and `To` targets to
 * include the current URL locale; numeric deltas (-1, 1) pass through
 * untouched.
 */
export function useNavigate(): ReturnType<typeof useRouterNavigate> {
  const routerNavigate = useRouterNavigate()
  const locale = useUrlLocale()
  return useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') {
        return routerNavigate(to)
      }
      return routerNavigate(localizeTarget(to, locale), options)
    }) as ReturnType<typeof useRouterNavigate>,
    [routerNavigate, locale],
  )
}

/**
 * Build a locale-aware href without rendering. Useful for callers that
 * need a path string (`window.location.href = ...`, share buttons,
 * Sentry breadcrumbs). Pass a bare path; gets the current locale
 * prefix when one is active.
 */
export function useLocalizedHref(): (path: string) => string {
  const locale = useUrlLocale()
  return useCallback(
    (path: string) => {
      if (!path.startsWith('/')) return path
      if (parseLocaleFromPath(path).locale != null) return path
      return withLocalePrefix(path, locale)
    },
    [locale],
  )
}
