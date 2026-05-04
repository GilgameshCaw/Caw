// Curated list of supported UI / translation languages. Codes are
// BCP-47 primary subtags (the same shape we store on User and Caw).
// The Settings → Language picker offers these; FeedItem formats
// "Translated from <name>" using the same map.
//
// Order: roughly by global online speaker count, with English first.
// Keep this list small enough to render without a search box.
export interface Language {
  code: string
  // English-language label (used today). Once Phase 2 i18n lands we
  // can swap to a localized label per the viewer's chosen language.
  name: string
  // Native-language label, shown in parens to help non-fluent users
  // recognize their language.
  native: string
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English',    native: 'English'    },
  { code: 'es', name: 'Spanish',    native: 'Español'    },
  { code: 'zh', name: 'Chinese',    native: '中文'        },
  { code: 'hi', name: 'Hindi',      native: 'हिन्दी'      },
  { code: 'ar', name: 'Arabic',     native: 'العربية'    },
  { code: 'pt', name: 'Portuguese', native: 'Português'  },
  { code: 'ru', name: 'Russian',    native: 'Русский'    },
  { code: 'ja', name: 'Japanese',   native: '日本語'       },
  { code: 'de', name: 'German',     native: 'Deutsch'    },
  { code: 'fr', name: 'French',     native: 'Français'   },
  { code: 'ko', name: 'Korean',     native: '한국어'        },
  { code: 'it', name: 'Italian',    native: 'Italiano'   },
  { code: 'tr', name: 'Turkish',    native: 'Türkçe'     },
  { code: 'pl', name: 'Polish',     native: 'Polski'     },
  { code: 'nl', name: 'Dutch',      native: 'Nederlands' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'th', name: 'Thai',       native: 'ไทย'         },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'uk', name: 'Ukrainian',  native: 'Українська'  },
  { code: 'he', name: 'Hebrew',     native: 'עברית'       },
]

const BY_CODE = new Map(LANGUAGES.map(l => [l.code, l]))

/** English-language name for a code, falling back to the raw code if unknown. */
export function languageName(code: string | null | undefined): string {
  if (!code) return ''
  return BY_CODE.get(code)?.name ?? code.toUpperCase()
}
