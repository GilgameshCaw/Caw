/**
 * Safe localStorage helpers.
 *
 * `JSON.parse(localStorage.getItem(key))` is everywhere in the app, and a
 * malformed entry (corruption, another tab writing garbage, dev tooling)
 * crashes the parsing path. Wraps every read in try/catch with a typed
 * default. Audit fix 2026-05-13.
 */

/** Read a JSON value from localStorage, returning `defaultValue` if the
 *  entry is missing, not parseable, or browser storage is unavailable. */
export function getJSON<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return defaultValue
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

/** Write a JSON value to localStorage. Silently swallows quota / disabled-storage
 *  errors — callers that need to know about failure should write directly. */
export function setJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota exceeded or localStorage disabled — best-effort write */
  }
}
