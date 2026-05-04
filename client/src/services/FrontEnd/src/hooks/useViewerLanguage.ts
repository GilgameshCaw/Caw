import { useActiveToken } from '~/store/tokenDataStore'
import { useUserByToken } from '~/hooks/useUserData'
import { getTargetLanguage } from '~/utils/translate'

export interface ViewerLanguage {
  /** The viewer's chosen language (BCP-47 primary subtag), or the
   * browser-locale fallback when no per-user pref is set. Always a
   * non-empty string so callers can compare directly against
   * Caw.sourceLanguage. */
  preferredLanguage: string
  /** When true, FeedItem auto-runs translation on caws whose detected
   * source language differs from preferredLanguage. Default false. */
  autoTranslate: boolean
}

/**
 * Reads the active viewer's language preferences (set on the User row
 * via Settings → Language). Falls back to the browser locale + auto-off
 * for unauthenticated viewers or while userByToken is in flight.
 *
 * Single source of truth for "what language do we translate INTO" —
 * FeedItem reads this once per render so toggling the setting takes
 * effect on the next paint via React Query's cache.
 */
export function useViewerLanguage(): ViewerLanguage {
  const activeToken = useActiveToken()
  const { data: user } = useUserByToken(activeToken?.tokenId)
  return {
    preferredLanguage: (user?.preferredLanguage as string | undefined) || getTargetLanguage(),
    autoTranslate:    !!user?.autoTranslate,
  }
}
