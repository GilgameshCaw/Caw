import React, { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { HiOutlineTranslate } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { formatLargeNumber } from '~/utils/numberFormat'
import { useViewerLanguage } from '~/hooks/useViewerLanguage'
import { translateTextDetailed } from '~/utils/translate'
import { useT } from '~/i18n/I18nProvider'

interface TrendingHashtag {
  name: string
  usageCount: number
}

// Sentinel used to glue hashtag names into a single gtx request and split
// them back out. Picked because gtx leaves it untouched across every
// language we support, unlike comma/pipe/newline which sometimes get
// rewritten or absorbed into adjacent words.
const JOIN_SEP = ' /// '

// Split a hashtag like "freedomOfSpeech" / "free_speech" / "free-speech"
// into space-separated words so gtx can recognize them. Returns the
// space-joined form plus a "style" descriptor we use to glue the
// translated result back into a single token in the same shape.
//   freedomOfSpeech → { words: "freedom of speech", style: 'camel' }
//   free_speech     → { words: "free speech",       style: 'snake' }
//   free-speech     → { words: "free speech",       style: 'kebab' }
//   speech          → { words: "speech",            style: 'plain' }
type HashtagStyle = 'camel' | 'snake' | 'kebab' | 'plain'

function splitHashtag(name: string): { words: string; style: HashtagStyle } {
  if (name.includes('_')) {
    return { words: name.replace(/_+/g, ' ').trim(), style: 'snake' }
  }
  if (name.includes('-')) {
    return { words: name.replace(/-+/g, ' ').trim(), style: 'kebab' }
  }
  // camelCase / PascalCase: split before each uppercase that follows a
  // lowercase or digit. Lowercases the first word of camelCase to match
  // what humans read aloud ("freedom of speech", not "Freedom Of Speech")
  // — the style descriptor remembers original capitalization for re-glue.
  if (/[a-z0-9][A-Z]/.test(name)) {
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    return { words, style: 'camel' }
  }
  return { words: name, style: 'plain' }
}

// Re-assemble translated word(s) into a single hashtag-shaped token in
// the same style as the original. For non-Latin scripts (zh/ja/ar/etc),
// styles other than 'plain' stop being meaningful — gtx returns one
// glyph block, and joiners would just look weird — so we fall back to
// the bare translated string in those cases.
function joinHashtag(translated: string, style: HashtagStyle): string {
  const trimmed = translated.trim()
  if (!trimmed) return trimmed
  // Non-Latin: keep gtx's output unchanged, no styling.
  if (!/[A-Za-z]/.test(trimmed)) return trimmed
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length <= 1) return trimmed
  switch (style) {
    case 'snake': return parts.join('_').toLowerCase()
    case 'kebab': return parts.join('-').toLowerCase()
    case 'camel': {
      const [first, ...rest] = parts
      return first.toLowerCase() + rest.map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('')
    }
    case 'plain':
    default:
      return parts.join(' ')
  }
}

interface TrendingHashtagsProps {
  /** Title for the header row. When provided, the component renders its
   * own h2 with the Translate affordance on the same line. When omitted,
   * the parent owns the title and the Translate button floats above the
   * list (legacy behavior — fine for narrow chrome but visually awkward
   * because the button ends up below the title). */
  title?: React.ReactNode
}

const TrendingHashtags: React.FC<TrendingHashtagsProps> = ({ title }) => {
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const t = useT()
  const viewerLang = useViewerLanguage()

  const { data: trendingHashtags = [], isLoading: loading } = useQuery<TrendingHashtag[]>({
    queryKey: ['trendingHashtags'],
    queryFn: async () => {
      const response = await fetch('/api/hashtags/trending?limit=7')
      if (!response.ok) return []
      const data = await response.json()
      return data.hashtags || []
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  const handleHashtagClick = (hashtag: string) => {
    navigate(`/hashtags/${hashtag}`)
  }

  // Map of original hashtag name -> translated label. Built by a single
  // batched gtx call so 7 hashtags = 1 network request, not 7. Click
  // navigation always uses the original name so the URL stays stable
  // regardless of viewer language.
  const [translations, setTranslations] = useState<Map<string, string>>(new Map())
  const [isTranslating, setIsTranslating] = useState(false)
  // Cache key combining viewer language + joined hashtag list. Used by
  // the reset effect below so a feed refresh that changes the trending
  // set, or a Settings change to preferredLanguage, drops the stale
  // translation map (those translations would either be wrong or point
  // at hashtags no longer on screen).
  const autoKey = useMemo(
    () => `${viewerLang.preferredLanguage}|${(trendingHashtags as TrendingHashtag[]).map(h => h.name).join(',')}`,
    [viewerLang.preferredLanguage, trendingHashtags],
  )

  const runTranslation = React.useCallback(async () => {
    const items = trendingHashtags as TrendingHashtag[]
    if (items.length === 0) return
    setIsTranslating(true)
    try {
      // Pre-split each hashtag into recognizable words. gtx can't translate
      // "freedomOfSpeech" but it can translate "freedom of speech"; we
      // re-camelCase the result before showing.
      const split = items.map(h => splitHashtag(h.name))
      const joined = split.map(s => s.words).join(JOIN_SEP)
      const result = await translateTextDetailed(joined, viewerLang.preferredLanguage)
      if (!result) return
      const parts = result.text.split(JOIN_SEP)
      // gtx occasionally drops or merges segments — only commit the map
      // if the count round-tripped. Otherwise we'd silently mislabel
      // hashtags by index. The user just sees the original list.
      if (parts.length !== items.length) return
      const next = new Map<string, string>()
      for (let i = 0; i < items.length; i++) {
        const original = items[i].name
        const restyled = joinHashtag(parts[i], split[i].style)
        if (restyled && restyled.toLowerCase() !== original.toLowerCase()) {
          next.set(original, restyled)
        }
      }
      setTranslations(next)
    } finally {
      setIsTranslating(false)
    }
  }, [trendingHashtags, viewerLang.preferredLanguage])

  // Reset the translation map when the trending list churns or the
  // viewer's language changes — stale translations would map to
  // hashtags that are no longer on screen.
  useEffect(() => {
    setTranslations(new Map())
  }, [autoKey])

  // Trending hashtags do NOT auto-translate even when the viewer has
  // autoTranslate on for posts. Hashtag translations have lower
  // information value (often proper nouns, slang, or already-roman
  // letters) and the panel sits in the right rail where unexpected
  // language churn is more disruptive than helpful. Manual click only.

  const handleTranslateClick = () => {
    if (translations.size > 0) {
      // Toggle off — second click reverts to originals.
      setTranslations(new Map())
      return
    }
    void runTranslation()
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[...Array(7)].map((_, i) => (
          <div key={i} className={`h-12 rounded-lg ${isDark ? 'bg-gray-800' : 'bg-gray-200'}`}></div>
        ))}
      </div>
    )
  }

  if (trendingHashtags.length === 0) {
    return (
      <div className={`text-center py-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        No trending hashtags yet
      </div>
    )
  }

  // Icon-only translate toggle. Three visual states:
  //   - mid-flight: spinner, no click
  //   - active   (translations.size > 0): bright yellow icon, tooltip = "Show original"
  //   - inactive (default):                muted icon,        tooltip = "Translate"
  // Default is always inactive even when the viewer has post auto-translate
  // on — trending hashtags don't auto-translate (per UX call: low signal,
  // disruptive in the right rail).
  const isActive = translations.size > 0
  const translateAffordance = (trendingHashtags as TrendingHashtag[]).length === 0 ? null : isTranslating ? (
    <span className="inline-flex items-center justify-center w-5 h-5" aria-label={t('post.translating')}>
      <div className="w-3.5 h-3.5 border-2 border-gray-400 border-t-yellow-500 rounded-full animate-spin" />
    </span>
  ) : (
    <button
      type="button"
      onClick={handleTranslateClick}
      title={isActive ? t('post.show_original') : t('post.translate')}
      aria-label={isActive ? t('post.show_original') : t('post.translate')}
      className={`inline-flex items-center justify-center w-5 h-5 transition-colors cursor-pointer ${
        isActive
          ? 'text-yellow-500 hover:text-yellow-400'
          : isDark
            ? 'text-gray-500 hover:text-gray-300'
            : 'text-gray-400 hover:text-gray-600'
      }`}
    >
      <HiOutlineTranslate className="w-4 h-4" />
    </button>
  )

  return (
    <div className="space-y-4">
      {title !== undefined ? (
        // Title-mode: parent delegates the header, we render title +
        // translate on a single flex row. mb-2 because the parent's
        // own bottom margin from h2 is gone.
        <div className="flex items-center justify-between gap-3 mb-2">
          {title}
          {translateAffordance}
        </div>
      ) : (
        translateAffordance && (
          <div className="flex justify-end px-1 -mb-2">{translateAffordance}</div>
        )
      )}
      {trendingHashtags.map((item) => {
        const translated = translations.get(item.name)
        const displayName = translated || item.name
        return (
        <button
          key={item.name}
          onClick={() => handleHashtagClick(item.name)}
          className={`w-full cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
            isDark
              ? 'hover:bg-white/10'
              : 'hover:bg-gray-200/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <span
                className={`font-medium block overflow-hidden whitespace-nowrap transition-colors duration-200 ${
                  isDark
                    ? 'text-gray-300 group-hover:text-white'
                    : 'text-gray-600 group-hover:text-black'
                }`}
                style={{ maxWidth: 132, textOverflow: 'ellipsis' }}
                title={`#${item.name}`}
              >
                #{displayName}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className={`text-xs transition-colors duration-200 ${
                isDark
                  ? 'text-yellow-500/70 group-hover:text-yellow-400'
                  : 'text-amber-800/70 group-hover:text-amber-900'
              }`}>
                {item.usageCount === 1 ? '1 caw' : `${formatLargeNumber(item.usageCount)} caws`}
              </span>
            </div>
          </div>
        </button>
        )
      })}
    </div>
  )
}

export default TrendingHashtags
