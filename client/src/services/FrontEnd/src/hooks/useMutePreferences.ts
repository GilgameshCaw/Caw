// Hook to manage mute preferences from localStorage
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'

export interface MutePreferences {
  mutedThreads: string[]       // Post IDs
  mutedWords: string[]         // Words/hashtags
  hiddenPosts: string[]        // Post IDs
  mutedAccounts: number[]      // User tokenIds
  blockedAccounts: number[]    // User tokenIds
}

const STORAGE_KEYS = {
  mutedThreads: 'mutedThreads',
  mutedWords: 'mutedWords',
  hiddenPosts: 'hiddenPosts',
  mutedAccounts: 'mutedAccounts',
  blockedAccounts: 'blockedAccounts',
} as const

// Common words to exclude from mute word selection
export const COMMON_WORDS = new Set([
  // Articles
  'a', 'an', 'the',
  // Pronouns
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  'this', 'that', 'these', 'those', 'who', 'whom', 'whose', 'which', 'what',
  // Prepositions
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'up', 'down',
  'into', 'through', 'during', 'before', 'after', 'above', 'below', 'between',
  'under', 'over', 'out', 'off', 'about', 'around', 'against',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet', 'if', 'then', 'because', 'although',
  'while', 'whereas', 'unless', 'until', 'when', 'where', 'whether',
  // Common verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'might', 'must', 'can', 'may',
  'get', 'got', 'getting', 'go', 'goes', 'went', 'going', 'gone',
  'come', 'came', 'coming', 'take', 'took', 'taking', 'taken',
  'make', 'made', 'making', 'know', 'knew', 'knowing', 'known',
  'think', 'thought', 'thinking', 'see', 'saw', 'seeing', 'seen',
  'want', 'wanted', 'wanting', 'say', 'said', 'saying',
  'use', 'used', 'using', 'find', 'found', 'finding',
  'give', 'gave', 'giving', 'given', 'tell', 'told', 'telling',
  'try', 'tried', 'trying', 'call', 'called', 'calling',
  'need', 'needed', 'needing', 'feel', 'felt', 'feeling',
  'become', 'became', 'becoming', 'leave', 'left', 'leaving',
  'put', 'putting', 'keep', 'kept', 'keeping',
  'let', 'letting', 'begin', 'began', 'beginning', 'begun',
  'seem', 'seemed', 'seeming', 'help', 'helped', 'helping',
  'show', 'showed', 'showing', 'shown', 'hear', 'heard', 'hearing',
  'play', 'played', 'playing', 'run', 'ran', 'running',
  'move', 'moved', 'moving', 'live', 'lived', 'living',
  'believe', 'believed', 'believing', 'hold', 'held', 'holding',
  'bring', 'brought', 'bringing', 'happen', 'happened', 'happening',
  'write', 'wrote', 'writing', 'written', 'sit', 'sat', 'sitting',
  'stand', 'stood', 'standing', 'lose', 'lost', 'losing',
  'pay', 'paid', 'paying', 'meet', 'met', 'meeting',
  'include', 'included', 'including', 'continue', 'continued', 'continuing',
  'set', 'setting', 'learn', 'learned', 'learning',
  'change', 'changed', 'changing', 'lead', 'led', 'leading',
  'understand', 'understood', 'understanding', 'watch', 'watched', 'watching',
  'follow', 'followed', 'following', 'stop', 'stopped', 'stopping',
  'create', 'created', 'creating', 'speak', 'spoke', 'speaking', 'spoken',
  'read', 'reading', 'allow', 'allowed', 'allowing',
  'add', 'added', 'adding', 'spend', 'spent', 'spending',
  'grow', 'grew', 'growing', 'grown', 'open', 'opened', 'opening',
  'walk', 'walked', 'walking', 'win', 'won', 'winning',
  'offer', 'offered', 'offering', 'remember', 'remembered', 'remembering',
  'love', 'loved', 'loving', 'consider', 'considered', 'considering',
  'appear', 'appeared', 'appearing', 'buy', 'bought', 'buying',
  'wait', 'waited', 'waiting', 'serve', 'served', 'serving',
  'die', 'died', 'dying', 'send', 'sent', 'sending',
  'expect', 'expected', 'expecting', 'build', 'built', 'building',
  'stay', 'stayed', 'staying', 'fall', 'fell', 'falling', 'fallen',
  'cut', 'cutting', 'reach', 'reached', 'reaching',
  'kill', 'killed', 'killing', 'remain', 'remained', 'remaining',
  // Adverbs
  'not', 'just', 'only', 'also', 'very', 'even', 'still', 'already',
  'always', 'never', 'often', 'sometimes', 'usually', 'really', 'actually',
  'probably', 'maybe', 'perhaps', 'certainly', 'definitely', 'however',
  'therefore', 'thus', 'hence', 'quite', 'rather', 'too', 'enough',
  'again', 'ever', 'here', 'there', 'now', 'then', 'today', 'yesterday',
  'tomorrow', 'soon', 'later', 'early', 'late', 'well', 'back', 'away',
  // Adjectives
  'good', 'new', 'first', 'last', 'long', 'great', 'little', 'own',
  'other', 'old', 'right', 'big', 'high', 'different', 'small', 'large',
  'next', 'same', 'able', 'possible', 'important', 'sure', 'true', 'real',
  'bad', 'best', 'better', 'worse', 'worst', 'much', 'more', 'most', 'many',
  'some', 'any', 'no', 'all', 'both', 'each', 'every', 'few', 'several',
  // Numbers
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  // Common nouns (very generic)
  'thing', 'things', 'time', 'times', 'way', 'ways', 'day', 'days', 'year', 'years',
  'people', 'person', 'man', 'men', 'woman', 'women', 'child', 'children',
  'world', 'life', 'hand', 'part', 'place', 'case', 'week', 'company',
  'system', 'program', 'question', 'work', 'government', 'number', 'night',
  'point', 'home', 'water', 'room', 'mother', 'area', 'money', 'story',
  'fact', 'month', 'lot', 'right', 'study', 'book', 'eye', 'job', 'word',
  'business', 'issue', 'side', 'kind', 'head', 'house', 'service', 'friend',
  'father', 'power', 'hour', 'game', 'line', 'end', 'member', 'law', 'car',
  'city', 'community', 'name', 'president', 'team', 'minute', 'idea',
  'kid', 'body', 'information', 'nothing', 'ago', 'right', 'lead', 'social',
  'something', 'anything', 'everything', 'someone', 'anyone', 'everyone',
  // Internet/social media common terms
  'lol', 'lmao', 'omg', 'wtf', 'btw', 'imo', 'imho', 'tbh', 'tho', 'though',
  'like', 'yeah', 'yes', 'no', 'ok', 'okay', 'please', 'thanks', 'thank',
  'hey', 'hi', 'hello', 'bye', 'sorry', 'wow',
])

// Extract meaningful words from post content
export function extractMuteableWords(content: string): string[] {
  // Extract hashtags/cashtags
  const hashtagRegex = /[#$][a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+/g
  const hashtags = (content.match(hashtagRegex) || []).map(tag => tag.toLowerCase())

  // Extract regular words (3+ chars, not URLs)
  const words = content
    .replace(/https?:\/\/[^\s]+/g, '') // Remove URLs
    .replace(/[#$@][a-zA-Z0-9_]+/g, '') // Remove hashtags/mentions
    .toLowerCase()
    .split(/\s+/)
    .map(word => word.replace(/[^a-zA-Z0-9]/g, '')) // Remove punctuation
    .filter(word =>
      word.length >= 3 &&
      !COMMON_WORDS.has(word) &&
      !/^\d+$/.test(word) // Not just numbers
    )

  // Combine and deduplicate
  const allWords = [...new Set([...hashtags, ...words])]

  // Sort: hashtags first, then by length (longer words first)
  return allWords.sort((a, b) => {
    const aIsTag = a.startsWith('#') || a.startsWith('$')
    const bIsTag = b.startsWith('#') || b.startsWith('$')
    if (aIsTag && !bIsTag) return -1
    if (!aIsTag && bIsTag) return 1
    return b.length - a.length
  })
}

function loadFromStorage<T>(key: string, defaultValue: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? JSON.parse(stored) : defaultValue
  } catch {
    return defaultValue
  }
}

function saveToStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (e) {
    console.error('Failed to save to localStorage:', e)
  }
}

export function useMutePreferences() {
  // Blocked accounts come from the Zustand store (shared with Profile block button)
  const blockedUsers = useBlockedUsersStore(s => s.blockedUsers)
  const blockUser = useBlockedUsersStore(s => s.blockUser)
  const unblockUser = useBlockedUsersStore(s => s.unblockUser)
  const blockedUserIds = useMemo(() => blockedUsers.map(u => u.tokenId), [blockedUsers])

  const [preferences, setPreferences] = useState<MutePreferences>(() => ({
    mutedThreads: loadFromStorage(STORAGE_KEYS.mutedThreads, []),
    mutedWords: loadFromStorage(STORAGE_KEYS.mutedWords, []),
    hiddenPosts: loadFromStorage(STORAGE_KEYS.hiddenPosts, []),
    mutedAccounts: loadFromStorage(STORAGE_KEYS.mutedAccounts, []),
    blockedAccounts: blockedUserIds,
  }))

  // Sync blockedAccounts from Zustand store
  useEffect(() => {
    setPreferences(prev => ({ ...prev, blockedAccounts: blockedUserIds }))
  }, [blockedUserIds])

  // Listen for storage events (from other tabs) and custom events (from same tab)
  useEffect(() => {
    const reloadPreferences = () => {
      setPreferences(prev => ({
        mutedThreads: loadFromStorage(STORAGE_KEYS.mutedThreads, []),
        mutedWords: loadFromStorage(STORAGE_KEYS.mutedWords, []),
        hiddenPosts: loadFromStorage(STORAGE_KEYS.hiddenPosts, []),
        mutedAccounts: loadFromStorage(STORAGE_KEYS.mutedAccounts, []),
        blockedAccounts: prev.blockedAccounts, // Keep from Zustand store
      }))
    }

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key && Object.values(STORAGE_KEYS).includes(e.key as any)) {
        reloadPreferences()
      }
    }

    // Listen for custom event from same tab (localStorage changes don't fire storage event in same tab)
    const handleMutePreferencesChanged = () => {
      reloadPreferences()
    }

    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('mutePreferencesChanged', handleMutePreferencesChanged)

    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('mutePreferencesChanged', handleMutePreferencesChanged)
    }
  }, [])

  const refresh = useCallback(() => {
    setPreferences(prev => ({
      mutedThreads: loadFromStorage(STORAGE_KEYS.mutedThreads, []),
      mutedWords: loadFromStorage(STORAGE_KEYS.mutedWords, []),
      hiddenPosts: loadFromStorage(STORAGE_KEYS.hiddenPosts, []),
      mutedAccounts: loadFromStorage(STORAGE_KEYS.mutedAccounts, []),
      blockedAccounts: prev.blockedAccounts, // Keep from Zustand store
    }))
  }, [])

  const addMutedWord = useCallback((word: string) => {
    const normalized = word.toLowerCase().trim()
    if (!normalized) return

    setPreferences(prev => {
      const updated = [...new Set([...prev.mutedWords, normalized])]
      saveToStorage(STORAGE_KEYS.mutedWords, updated)
      return { ...prev, mutedWords: updated }
    })
  }, [])

  const removeMutedWord = useCallback((word: string) => {
    setPreferences(prev => {
      const updated = prev.mutedWords.filter(w => w !== word)
      saveToStorage(STORAGE_KEYS.mutedWords, updated)
      return { ...prev, mutedWords: updated }
    })
  }, [])

  const addMutedThread = useCallback((threadId: string) => {
    setPreferences(prev => {
      const updated = [...new Set([...prev.mutedThreads, threadId])]
      saveToStorage(STORAGE_KEYS.mutedThreads, updated)
      return { ...prev, mutedThreads: updated }
    })
  }, [])

  const removeMutedThread = useCallback((threadId: string) => {
    setPreferences(prev => {
      const updated = prev.mutedThreads.filter(id => id !== threadId)
      saveToStorage(STORAGE_KEYS.mutedThreads, updated)
      return { ...prev, mutedThreads: updated }
    })
  }, [])

  const addHiddenPost = useCallback((postId: string) => {
    setPreferences(prev => {
      const updated = [...new Set([...prev.hiddenPosts, postId])]
      saveToStorage(STORAGE_KEYS.hiddenPosts, updated)
      return { ...prev, hiddenPosts: updated }
    })
  }, [])

  const removeHiddenPost = useCallback((postId: string) => {
    setPreferences(prev => {
      const updated = prev.hiddenPosts.filter(id => id !== postId)
      saveToStorage(STORAGE_KEYS.hiddenPosts, updated)
      return { ...prev, hiddenPosts: updated }
    })
  }, [])

  const addMutedAccount = useCallback((mutedTokenId: number, _currentUserTokenId?: number) => {
    setPreferences(prev => {
      const updated = [...new Set([...prev.mutedAccounts, mutedTokenId])]
      saveToStorage(STORAGE_KEYS.mutedAccounts, updated)
      return { ...prev, mutedAccounts: updated }
    })
  }, [])

  const removeMutedAccount = useCallback((mutedTokenId: number, _currentUserTokenId?: number) => {
    setPreferences(prev => {
      const updated = prev.mutedAccounts.filter(id => id !== mutedTokenId)
      saveToStorage(STORAGE_KEYS.mutedAccounts, updated)
      return { ...prev, mutedAccounts: updated }
    })
  }, [])

  // Blocking uses the shared Zustand store (server-backed)
  const addBlockedAccount = useCallback((blockedTokenId: number, currentUserTokenId?: number) => {
    if (!currentUserTokenId) return
    blockUser(currentUserTokenId, blockedTokenId, `user_${blockedTokenId}`)
  }, [blockUser])

  const removeBlockedAccount = useCallback((blockedTokenId: number, currentUserTokenId?: number) => {
    if (!currentUserTokenId) return
    unblockUser(currentUserTokenId, blockedTokenId)
  }, [unblockUser])

  const clearAllMutes = useCallback(() => {
    // Clear localStorage-based preferences (not blockedAccounts — that's in Zustand)
    localStorage.removeItem(STORAGE_KEYS.mutedThreads)
    localStorage.removeItem(STORAGE_KEYS.mutedWords)
    localStorage.removeItem(STORAGE_KEYS.hiddenPosts)
    localStorage.removeItem(STORAGE_KEYS.mutedAccounts)
    setPreferences(prev => ({
      mutedThreads: [],
      mutedWords: [],
      hiddenPosts: [],
      mutedAccounts: [],
      blockedAccounts: prev.blockedAccounts,
    }))
  }, [])

  return {
    preferences,
    refresh,
    addMutedWord,
    removeMutedWord,
    addMutedThread,
    removeMutedThread,
    addHiddenPost,
    removeHiddenPost,
    addMutedAccount,
    removeMutedAccount,
    addBlockedAccount,
    removeBlockedAccount,
    clearAllMutes,
  }
}

/**
 * Simple stemmer that reduces words to their base form
 * Handles common English suffixes
 */
function getStem(word: string): string {
  const w = word.toLowerCase()

  // Handle some irregular forms
  const irregulars: Record<string, string> = {
    'testing': 'test',
    'tested': 'test',
    'tests': 'test',
    'tester': 'test',
    'testers': 'test',
  }
  if (irregulars[w]) return irregulars[w]

  // Remove common suffixes (order matters - check longer suffixes first)
  const suffixes = [
    { suffix: 'ingly', minLen: 5 },
    { suffix: 'ingly', minLen: 5 },
    { suffix: 'ation', minLen: 5 },
    { suffix: 'ement', minLen: 5 },
    { suffix: 'ness', minLen: 4 },
    { suffix: 'ment', minLen: 4 },
    { suffix: 'able', minLen: 4 },
    { suffix: 'ible', minLen: 4 },
    { suffix: 'ful', minLen: 4 },
    { suffix: 'less', minLen: 4 },
    { suffix: 'ing', minLen: 4 },
    { suffix: 'ied', minLen: 3 },  // carried -> carr (then restore to carry)
    { suffix: 'ies', minLen: 3 },  // carries -> carr (then restore to carry)
    { suffix: 'ed', minLen: 3 },
    { suffix: 'er', minLen: 3 },
    { suffix: 'es', minLen: 3 },
    { suffix: 'ly', minLen: 4 },
    { suffix: 's', minLen: 3 },
  ]

  for (const { suffix, minLen } of suffixes) {
    if (w.endsWith(suffix) && w.length >= minLen + suffix.length) {
      let stem = w.slice(0, -suffix.length)

      // Handle doubled consonants (e.g., "running" -> "run", "stopped" -> "stop")
      if (stem.length >= 2 && /[^aeiou]$/.test(stem)) {
        const lastTwo = stem.slice(-2)
        if (lastTwo[0] === lastTwo[1] && /[bcdfgklmnprstvz]/.test(lastTwo[0])) {
          stem = stem.slice(0, -1)
        }
      }

      // Handle -ied/-ies (e.g., "carried" -> "carry")
      if ((suffix === 'ied' || suffix === 'ies') && stem.length >= 2) {
        stem = stem + 'y'
      }

      return stem
    }
  }

  return w
}

/**
 * Generate word variations including the stem and common conjugations
 */
function getWordVariations(word: string): string[] {
  const stem = getStem(word.toLowerCase())
  const variations = new Set<string>([
    word.toLowerCase(),
    stem,
    stem + 's',
    stem + 'es',
    stem + 'ed',
    stem + 'ing',
    stem + 'er',
    stem + 'ers',
    stem + 'ment',
    stem + 'ness',
  ])

  // Handle words ending in 'e' (e.g., "make" -> "making", not "makeing")
  if (stem.endsWith('e')) {
    const stemNoE = stem.slice(0, -1)
    variations.add(stemNoE + 'ing')
    variations.add(stemNoE + 'ed')
    variations.add(stemNoE + 'er')
  }

  // Handle words ending in consonant (double it for -ing/-ed)
  if (/[bcdfgklmnprstvz]$/.test(stem) && stem.length >= 2) {
    const lastChar = stem.slice(-1)
    variations.add(stem + lastChar + 'ing')
    variations.add(stem + lastChar + 'ed')
    variations.add(stem + lastChar + 'er')
  }

  // Handle words ending in 'y' (e.g., "carry" -> "carried", "carries")
  if (stem.endsWith('y') && stem.length >= 2) {
    const stemNoY = stem.slice(0, -1)
    variations.add(stemNoY + 'ied')
    variations.add(stemNoY + 'ies')
    variations.add(stemNoY + 'ying')
  }

  return Array.from(variations).filter(v => v.length >= 2)
}

/**
 * Check if a muted word matches within content, handling:
 * - Word variations (test, testing, tested, tests, tester)
 * - Hashtags/cashtags (#test, $test, #testing)
 * - Compound hashtags (#anothertest should match "test")
 * - Word boundaries (don't match "contest" or "protest" when muting "test")
 */
function matchesMutedWord(content: string, mutedWord: string): boolean {
  const contentLower = content.toLowerCase()

  // Strip # or $ from muted word if present to get the base word
  const isTag = mutedWord.startsWith('#') || mutedWord.startsWith('$')
  const baseWord = isTag ? mutedWord.slice(1) : mutedWord
  const stem = getStem(baseWord)
  const variations = getWordVariations(baseWord)

  // Check each variation
  for (const variant of variations) {
    // 1. Check as standalone word with word boundaries
    // Use negative lookbehind/lookahead to ensure we're not inside another word
    // \b doesn't work well for all cases, so we check more carefully
    const standalonePattern = new RegExp(
      `(?<![a-zA-Z])${escapeRegex(variant)}(?![a-zA-Z])`,
      'i'
    )
    if (standalonePattern.test(contentLower)) {
      return true
    }

    // 2. Check as hashtag or cashtag
    const hashtagPattern = new RegExp(
      `[#$]${escapeRegex(variant)}(?![a-zA-Z0-9_])`,
      'i'
    )
    if (hashtagPattern.test(contentLower)) {
      return true
    }

    // 3. Check inside compound hashtags (e.g., #anothertest, #testresults)
    // We need to find the word at a "logical" boundary within the tag
    const compoundHashtagPattern = new RegExp(
      `[#$][a-zA-Z0-9_]*?(?<![a-zA-Z])${escapeRegex(variant)}(?![a-zA-Z])[a-zA-Z0-9_]*`,
      'i'
    )
    if (compoundHashtagPattern.test(contentLower)) {
      return true
    }
  }

  // 4. Check for the stem at word boundaries within compound hashtags
  // This handles cases like #mytest, #testrun where the word is at the start/end
  const hashtagMatches = contentLower.match(/[#$][a-zA-Z0-9_]+/g) || []
  for (const tag of hashtagMatches) {
    const tagContent = tag.slice(1) // Remove # or $

    // Check if any variation appears at start or end of tag content
    for (const variant of variations) {
      // At the start: #testrun, #testing
      if (tagContent.startsWith(variant) && tagContent.length > variant.length) {
        // Make sure the next char starts a new "word" (uppercase or different word)
        const nextChar = tagContent[variant.length]
        if (nextChar === nextChar.toUpperCase() || /[0-9_]/.test(nextChar)) {
          return true
        }
      }

      // At the end: #mytest, #bigtest
      if (tagContent.endsWith(variant) && tagContent.length > variant.length) {
        // Check the char before to see if it could be end of another word
        const prevCharIndex = tagContent.length - variant.length - 1
        const prevChar = tagContent[prevCharIndex]
        // If the variant starts with lowercase and prev char is lowercase, might be embedded
        // But if prev char is uppercase, number, or underscore, it's likely a boundary
        if (/[A-Z0-9_]/.test(prevChar) || variant[0] === variant[0].toUpperCase()) {
          return true
        }
        // Also match if the tag is camelCase like "myTest" -> "test"
        if (variant[0] === variant[0].toLowerCase() && tagContent !== tagContent.toLowerCase()) {
          // Check if there's a case change right before our variant
          const beforeVariant = tagContent.slice(0, tagContent.length - variant.length)
          if (beforeVariant.length > 0 && /[a-z]$/.test(beforeVariant)) {
            // The variant starts where a lowercase letter ends
            // This is okay if the variant itself starts with uppercase (camelCase)
            // or if we're at a natural break
            const variantStart = tagContent.slice(tagContent.length - variant.length)
            if (variantStart[0] === variantStart[0].toUpperCase()) {
              return true // camelCase boundary like "myTest"
            }
          }
        }
      }
    }

    // Check for camelCase boundaries within the tag
    // Split by camelCase and check each part
    const camelParts = tagContent.split(/(?=[A-Z])/).map(p => p.toLowerCase())
    for (const part of camelParts) {
      if (variations.includes(part) || getStem(part) === stem) {
        return true
      }
    }
  }

  return false
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Utility to check if a post should be filtered
// Note: Muted threads are NOT filtered here - they only affect notifications (server-side)
export function shouldFilterPost(
  post: { id: string; content: string; user: { tokenId: number }; parent?: { id: string } | null },
  preferences: MutePreferences
): boolean {
  // Check if post is hidden - convert to string for comparison since localStorage may have different types
  const postIdStr = String(post.id)
  const hiddenPostsStr = preferences.hiddenPosts.map(String)
  if (hiddenPostsStr.includes(postIdStr)) {
    return true
  }

  // Check if original post is hidden (for recaws) - if the parent/original is hidden, hide the recaw too
  if (post.parent && hiddenPostsStr.includes(String(post.parent.id))) {
    return true
  }

  // Check if author is muted or blocked - convert to numbers for comparison
  const userTokenId = Number(post.user.tokenId)
  const mutedAccountsNum = preferences.mutedAccounts.map(Number)
  const blockedAccountsNum = preferences.blockedAccounts.map(Number)
  if (mutedAccountsNum.includes(userTokenId) || blockedAccountsNum.includes(userTokenId)) {
    return true
  }

  // Check for muted words with smart matching
  if (preferences.mutedWords.length > 0) {
    for (const word of preferences.mutedWords) {
      if (matchesMutedWord(post.content, word)) {
        return true
      }
    }
  }

  return false
}
