import { makeJsonRpcProvider } from '../src/utils/rpcProvider'

export async function assertStrictRpcChains(
  urls: string[],
  expectedChainId: number,
  label: string,
): Promise<void> {
  for (const url of urls) {
    const provider = makeJsonRpcProvider(url)
    let raw: string
    try {
      raw = await provider.send('eth_chainId', [])
    } catch (e: any) {
      throw new Error(
        `${label} RPC chain-ID verification failed: ${e?.message || e}`,
      )
    } finally {
      try { provider.destroy() } catch { /* best effort */ }
    }

    const actual = Number(BigInt(raw))
    if (actual !== expectedChainId) {
      throw new Error(
        `${label} RPC chain-ID mismatch: expected ${expectedChainId}, got ${actual}`,
      )
    }
  }
}
