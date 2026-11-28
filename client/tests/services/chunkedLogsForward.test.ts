import assert from 'node:assert/strict'
import { scanLogsForward } from '../../src/utils/chunkedLogs'

describe('scanLogsForward cancellation', () => {
  it('stops after an in-flight window returns without reporting progress or fetching another window', async () => {
    const controller = new AbortController()
    const stop = new Error('service stopped')
    const requests: Array<[number, number]> = []
    const progress: number[] = []
    let finishWindow!: () => void
    const firstWindow = new Promise<[]>((resolve) => {
      finishWindow = () => resolve([])
    })
    const provider = {
      async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
        requests.push([fromBlock, toBlock])
        return requests.length === 1 ? firstWindow : []
      },
    } as unknown as Parameters<typeof scanLogsForward>[0]
    const options = {
      chunkBlocks: 4,
      signal: controller.signal,
      onProgress: (from: number) => { progress.push(from) },
    }

    const scan = scanLogsForward(provider, '0xContract', [], 1, 8, options)
    assert.deepEqual(requests, [[1, 4]])
    controller.abort(stop)
    finishWindow()

    const result = await scan.then(() => undefined, (error: unknown) => error)
    assert.deepEqual({ reason: result, requests, progress }, {
      reason: stop,
      requests: [[1, 4]],
      progress: [],
    })
  })
})
