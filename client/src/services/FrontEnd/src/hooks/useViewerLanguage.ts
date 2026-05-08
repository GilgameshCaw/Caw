import { useEffect, useState } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useUserByToken } from '~/hooks/useUserData'
import { getTargetLanguage } from '~/utils/translate'
import { getStoredViewerLanguage } from '~/components/LanguageSwitcher'

export interface ViewerLanguage {
  preferredLanguage: string
  autoTranslate: boolean
}

// Resolution order (first non-empty wins):
//   1. User.preferredLanguage   (post-mint, server-persisted)
//   2. localStorage caw:viewer-lang  (pre-mint or signed-out choice)
//   3. browser locale via getTargetLanguage()
//
// Listening to the custom event lets LanguageSwitcher push changes
// without forcing every consumer to re-mount.
export function useViewerLanguage(): ViewerLanguage {
  const activeToken = useActiveToken()
  const { data: user } = useUserByToken(activeToken?.tokenId)
  const [stored, setStored] = useState<string>(() => getStoredViewerLanguage())

  useEffect(() => {
    const onChange = () => setStored(getStoredViewerLanguage())
    window.addEventListener('caw:viewer-lang-changed', onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener('caw:viewer-lang-changed', onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])

  return {
    preferredLanguage:
      (user?.preferredLanguage as string | undefined) || stored || getTargetLanguage(),
    autoTranslate: !!user?.autoTranslate,
  }
}
