import React, { createContext, useContext, useEffect, useState, useMemo } from 'react'
import { useViewerLanguage } from '~/hooks/useViewerLanguage'
import { Catalog, EN_CATALOG, loadCatalog, translate, TVars } from './index'

interface I18nContextValue {
  /** Active locale code (e.g. "en", "es"). Reflects the viewer's
   * preferredLanguage but may briefly lag while the new catalog is
   * still loading. */
  locale: string
  /** Translation function — bind once via useT() in components. */
  t: (key: string, vars?: TVars) => string
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  // Identity fallback: if a component calls useT() outside the provider
  // (legacy renderers, tests) it just gets the EN catalog so the screen
  // never goes blank.
  t: (key, vars) => translate(EN_CATALOG, key, vars),
})

/**
 * Wraps the app and provides translation context. Watches the viewer's
 * preferredLanguage (set in Settings → Language) and lazy-loads the
 * matching catalog. Until the catalog finishes loading the EN catalog
 * is used so first paint never blocks on a network round-trip.
 */
export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { preferredLanguage } = useViewerLanguage()
  const [catalog, setCatalog] = useState<Catalog>(EN_CATALOG)
  const [loadedLocale, setLoadedLocale] = useState<string>('en')

  useEffect(() => {
    // Don't refetch the EN catalog — it's bundled.
    if (preferredLanguage === 'en') {
      setCatalog(EN_CATALOG)
      setLoadedLocale('en')
      return
    }
    let cancelled = false
    loadCatalog(preferredLanguage).then(c => {
      if (cancelled) return
      setCatalog(c)
      setLoadedLocale(preferredLanguage)
    })
    return () => { cancelled = true }
  }, [preferredLanguage])

  const value = useMemo<I18nContextValue>(() => ({
    locale: loadedLocale,
    t: (key, vars) => translate(catalog, key, vars),
  }), [catalog, loadedLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/**
 * Component-side translation hook. Returns a stable `t()` function
 * scoped to the current locale.
 */
export function useT() {
  return useContext(I18nContext).t
}

export function useLocale() {
  return useContext(I18nContext).locale
}
