// CawAI/textLimit.ts
//
// The on-chain length limit for a reply. CawActions reverts with
// TextTooLong when `action.text.length > 420`, and `text` is the
// smltxt-compressed bytes, not the characters. Japanese text compresses
// to roughly 2 bytes per character, so a 420-character cap lets a
// 200-character Japanese reply through and the validator's tx reverts.
//
// Kept apart from reply.ts so clampReply's callers (including the
// offline test-reply.ts) can measure a reply without importing the
// signing module.

import SmlTxt from 'smltxt'

export const MAX_TEXT_BYTES = 420

// Lazy smltxt singleton — table is ~380 KB; parse once.
let _sml: SmlTxt | undefined
function getSml(): SmlTxt {
  if (!_sml) _sml = SmlTxt.fromPkg()
  return _sml
}

export function compressText(text: string): Uint8Array {
  if (!text) return new Uint8Array(0)
  return getSml().compress(text)
}

export function fitsOnChain(text: string): boolean {
  return compressText(text).length <= MAX_TEXT_BYTES
}
