// api/util/erc1271.ts
//
// Asking a contract's ERC-1271 isValidSignature, and telling "the contract said
// no" from "the question could not be asked". No module-level state, so any
// route can import it.

import type { Contract } from 'ethers'

const ERC1271_MAGIC = '0x1626ba7e'

/**
 * Ask `contract.isValidSignature(hash, sig)` and return true iff it gives the
 * ERC-1271 magic value. A revert or return data that is not a bytes4 is the
 * contract's own answer, "not valid", and gives false. Anything else means the
 * question was not answered (RPC unreachable, HTTP error, a node-side error),
 * and the error is thrown so that the caller can tell it from an invalid
 * signature.
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

/**
 * A copy of the failure that is safe to log. ethers puts the request URL into
 * the message of HTTP and network errors, and an RPC URL can carry an API key
 * in its path; the callers log the error they catch. Only the short message
 * and the code are kept, and the original error is not attached.
 */
function infrastructureError(e: any): Error {
  const err: any = new Error('L1 RPC call failed: ' + String(e?.shortMessage || e?.code || 'unknown error'))
  err.code = e?.code
  return err
}

/**
 * Whether an ethers error from the isValidSignature call is the contract's own
 * answer (a revert, or return data that is not a bytes4) rather than a failure
 * to reach it.
 *
 * ethers reports every JSON-RPC error response as CALL_EXCEPTION, including
 * node-side errors such as "header not found" or a rate limit, so the code
 * alone does not tell a revert from an RPC problem. A revert carries revert
 * data, or RPC error code 3, or says "execution reverted" (some clients use
 * -32000 for it). Network errors, HTTP errors and a body that is not JSON have
 * other codes and are never a rejection.
 */
function isContractRejection(e: any): boolean {
  if (e?.code === 'BAD_DATA') return true            // empty or malformed return data
  if (e?.code !== 'CALL_EXCEPTION') return false
  if (e.revert || (typeof e.data === 'string' && e.data !== '0x')) return true
  const rpc = e.info?.error
  if (rpc?.code === 3) return true
  return /execution reverted/i.test(String(rpc?.message ?? ''))
}
