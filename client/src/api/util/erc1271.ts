// api/util/erc1271.ts
//
// Asking a contract's ERC-1271 isValidSignature, and telling "the contract said
// no" from "the question could not be asked". No module-level state, so any
// route can import it.

import type { Contract } from 'ethers'

const ERC1271_MAGIC = '0x1626ba7e'

/**
 * Ask `contract.isValidSignature(hash, sig)` and return true iff it gives the
 * ERC-1271 magic value. Only evidence tied to this call makes it false (see
 * isContractRejection). Anything else, including an answer that cannot be
 * attributed to the contract, means the question was not answered (RPC
 * unreachable, HTTP error, a node-side error), and a sanitized error is thrown
 * so that the caller can tell it from an invalid signature.
 */
export async function isErc1271Valid(contract: Contract, hash: string, sig: string): Promise<boolean> {
  try {
    const magic: string = await contract.isValidSignature(hash, sig)
    return typeof magic === 'string' && magic.toLowerCase() === ERC1271_MAGIC
  } catch (e) {
    if (isContractRejection(e)) return false
    throw infrastructureError(e)
  }
}

// Error codes that may appear in a log line. Anything else is reported as UNKNOWN.
const LOGGABLE_CODES = new Set([
  'SERVER_ERROR', 'NETWORK_ERROR', 'TIMEOUT', 'UNSUPPORTED_OPERATION', 'CALL_EXCEPTION', 'BAD_DATA',
  'INVALID_ARGUMENT', 'UNKNOWN_ERROR', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
])

/**
 * A fresh error that is safe to log: a fixed message and an allow-listed code,
 * nothing taken from the upstream response. The message of an ethers error can
 * hold the request URL (an RPC URL can carry an API key in its path) and text
 * the RPC node chose to send, and the callers log the error they catch. The
 * original error is not attached.
 */
function infrastructureError(e: any): Error {
  const code = typeof e?.code === 'string' && LOGGABLE_CODES.has(e.code) ? e.code : 'UNKNOWN'
  const err: any = new Error('L1 RPC call failed (' + code + ')')
  err.code = code
  return err
}

/**
 * Whether an ethers error from the isValidSignature call is the contract's own
 * answer, judged only on evidence tied to this call:
 *
 *  - ethers decoded a revert reason from the call's return data (`revert`);
 *  - the node answered that the call reverted: RPC error code 3, or -32000, with
 *    a message that starts with "execution reverted";
 *  - the return value of this call could not be decoded as a bytes4
 *    (BAD_DATA raised while decoding isValidSignature, for example an address
 *    without code).
 *
 * ethers reports every JSON-RPC error answer as CALL_EXCEPTION, so the code alone
 * proves nothing. Text that merely contains "revert" somewhere in a message, a
 * hex `data` field on an ordinary node error, and a BAD_DATA that did not come
 * from decoding this call are all things an infrastructure response can contain;
 * they are not treated as the contract refusing the signature.
 */
function isContractRejection(e: any): boolean {
  if (e?.code === 'BAD_DATA') return e.info?.method === 'isValidSignature'
  if (e?.code !== 'CALL_EXCEPTION') return false
  if (e.revert) return true
  const rpc = e.info?.error
  return (rpc?.code === 3 || rpc?.code === -32000)
    && typeof rpc?.message === 'string'
    && /^execution reverted(?:: |$)/i.test(rpc.message.trim())
}
