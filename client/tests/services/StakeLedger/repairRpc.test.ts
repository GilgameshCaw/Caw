import { expect } from 'chai'
import http from 'node:http'
import { assertStrictRpcChains } from '../../../scripts/stake-ledger-repair-rpc'

async function withRpc(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test RPC has no TCP address')
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve())
    })
  }
}

function rpcReply(chainId: string) {
  return (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: chainId,
    }))
  }
}

describe('StakeLedger repair strict RPC verification', () => {
  it('accepts a configured RPC on the expected chain', async () => {
    await withRpc(rpcReply('0x14a34'), async url => {
      await assertStrictRpcChains([url], 84532, 'L2')
    })
  })

  it('rejects a configured RPC on the wrong chain', async () => {
    await withRpc(rpcReply('0xaa36a7'), async url => {
      try {
        await assertStrictRpcChains([url], 84532, 'L2')
        expect.fail('expected chain-ID mismatch')
      } catch (e: any) {
        expect(e.message).to.include('chain-ID mismatch')
      }
    })
  })

  it('rejects an unreachable configured RPC', async () => {
    try {
      await assertStrictRpcChains(['http://127.0.0.1:1'], 84532, 'L2')
      expect.fail('expected chain-ID verification failure')
    } catch (e: any) {
      expect(e.message).to.include('chain-ID verification failed')
    }
  })
})
