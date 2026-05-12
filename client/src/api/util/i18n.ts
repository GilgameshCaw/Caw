// Server-side i18n: loads the same catalogs the FE uses (single source
// of truth) and renders strings for OG-card chrome, /sitemap.xml labels,
// and any other locale-aware server-rendered surface.
//
// Catalogs live in the FE source tree at
// services/FrontEnd/src/i18n/locales/<code>.json. Each catalog is read
// once on first request and memoized in-process. English is always
// loaded as the fallback for missing keys.

import fs from 'fs'
import path from 'path'

const LOCALES_DIR = path.join(
  process.cwd(),
  'src',
  'services',
  'FrontEnd',
  'src',
  'i18n',
  'locales',
)

type Catalog = Record<string, string>
const catalogCache = new Map<string, Catalog>()
let enCatalog: Catalog | null = null

function loadFile(code: string): Catalog {
  try {
    const file = path.join(LOCALES_DIR, `${code}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out: Catalog = {}
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && !k.startsWith('_')) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function getEn(): Catalog {
  if (!enCatalog) enCatalog = loadFile('en')
  return enCatalog
}

function getCatalog(code: string): Catalog {
  if (code === 'en') return getEn()
  const cached = catalogCache.get(code)
  if (cached) return cached
  const fresh = loadFile(code)
  catalogCache.set(code, fresh)
  return fresh
}

export interface TVars {
  count?: number
  [key: string]: string | number | undefined
}

/**
 * Server-side translation. Mirrors the FE `translate()` semantics:
 * pluralize via _one/_other suffix when vars.count is set, substitute
 * {{var}} placeholders, fall back to English when the locale catalog
 * misses the key, fall back to the key itself when even English misses.
 *
 * `locale` may be null (treat as English).
 */
export function t(locale: string | null, key: string, vars?: TVars): string {
  const en = getEn()
  const catalog = locale && locale !== 'en' ? getCatalog(locale) : en

  let lookupKey = key
  if (vars && typeof vars.count === 'number') {
    const suffix = vars.count === 1 ? '_one' : '_other'
    if ((key + suffix) in catalog || (key + suffix) in en) {
      lookupKey = key + suffix
    }
  }

  const raw = catalog[lookupKey] ?? en[lookupKey] ?? catalog[key] ?? en[key] ?? key

  if (!vars) return raw
  return raw.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    const v = vars[name]
    return v === undefined ? `{{${name}}}` : String(v)
  })
}
