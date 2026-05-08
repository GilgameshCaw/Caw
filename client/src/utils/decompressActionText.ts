import SmlTxt from 'smltxt'

// Shared smltxt decompressor for the signed-action `data.text` field.
//
// On-chain `text` is `bytes` (smltxt-compressed). We keep the compressed
// hex on the signed payload (the signature was over those exact bytes)
// and derive plaintext separately for storage / URL extraction / tip
// parsing / failure-cleanup prefix matching.
//
// Originally lived inline in api/routes/actions.ts; lifted here so
// cleanupOptimisticRows (which has to test plaintext prefixes against
// the original signed bytes) can share the same singleton.
let _smlTxt: SmlTxt | undefined
function smlTxt(): SmlTxt {
  if (!_smlTxt) _smlTxt = SmlTxt.fromPkg()
  return _smlTxt
}

export function decompressActionText(textField: unknown): string {
  if (typeof textField !== 'string' || !textField || textField === '0x') return ''
  const hex = textField.startsWith('0x') ? textField.slice(2) : textField
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return ''
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try { return smlTxt().decompress(bytes) } catch { return '' }
}
