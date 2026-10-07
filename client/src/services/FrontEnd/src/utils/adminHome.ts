import { parseLocaleFromPath } from '~/utils/localePrefix'

/**
 * ReportsAdmin and BugReportsAdmin are mounted twice in routes.tsx: under
 * /admin (AdminGate: ADMIN only) and under /moderation (ModeratorGate:
 * MODERATOR or ADMIN). Their header links back to the area they were opened
 * from, so a moderator is not sent to /admin, which AdminGate refuses.
 */
export function adminHomeFor(pathname: string): { to: string; label: string } {
  const { restPath } = parseLocaleFromPath(pathname)
  return restPath === '/moderation' || restPath.startsWith('/moderation/')
    ? { to: '/moderation', label: 'Moderation' }
    : { to: '/admin', label: 'Admin' }
}
