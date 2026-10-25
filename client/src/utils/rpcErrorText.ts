// A short text for an RPC / ethers error, to build a rejection string from.
//
// ethers errors read "<shortMessage> (key=value, ...)", and for a failed
// eth_call the key=value part has the whole transaction: from, to and the
// calldata. The validator's temporary-error check looks for '429' anywhere
// in the rejection, so the digits 429 somewhere in the calldata or the
// validator's address made the rejection look like a rate limit. And
// ethers turns every JSON-RPC error on eth_call into "missing revert data",
// keeping the node's own text ("rate limit exceeded", ...) only in
// info.error.message, so a real rate limit didn't look like one.
//
// So take ethers' shortMessage (or the whole message for other errors) and
// add the node's message when there is one.

export function rpcErrorText(err: any): string {
  const text = typeof err?.shortMessage === 'string' ? err.shortMessage : String(err?.message ?? '')
  const nodeMessage = err?.info?.error?.message
  return typeof nodeMessage === 'string' && nodeMessage && !text.includes(nodeMessage)
    ? `${text} (${nodeMessage})`
    : text
}

// The reason of a reverted eth_call: `decoded` (the caller's name for the
// error) when there is one, else a require/revert string, else the short
// text. ethers' short text for a custom error ("execution reverted (unknown
// custom error)") leaves out the revert data, so add its 4-byte selector.
// Only the selector: the arguments can hold any digits, 429 among them.
export function revertReasonText(err: any, decoded: string | null): string {
  if (decoded) return decoded
  const text = rpcErrorText(err)
  const reason = text.match(/execution reverted: (.+)/)?.[1]
  if (reason) return reason
  const data = err?.data || err?.error?.data || err?.info?.error?.data
  return typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)
    ? `${text} (${data.slice(0, 10)})`
    : text
}
