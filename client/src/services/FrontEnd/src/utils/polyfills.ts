/**
 * Browser polyfills
 */

// Buffer polyfill
import { Buffer } from 'buffer'

// Make Buffer available globally
if (typeof window !== 'undefined' && typeof window.Buffer === 'undefined') {
  window.Buffer = Buffer
  ;(window as any).global = window
}

export {}
