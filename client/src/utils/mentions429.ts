// Does an error report an HTTP / JSON-RPC 429 (rate limit)?
//
// ethers errors read "<shortMessage> (key=value, ...)", and the key=value
// part can carry the request, the tx and the receipt: hashes, addresses and
// block numbers, where the digits 429 turn up by chance. A CALL_EXCEPTION
// from a reverted tx then looked like a rate limit, and the validator kept
// the reverter pending as a transient RPC error. So look only at ethers'
// shortMessage (e.g. "server response 429 Too Many Requests"), or at the
// whole message for other errors, and only at a 429 that stands alone.

export function mentions429(err: any): boolean {
  const text = typeof err?.shortMessage === 'string' ? err.shortMessage : String(err?.message ?? '')
  return /(^|[^0-9a-z])429([^0-9a-z]|$)/.test(text.toLowerCase())
}
