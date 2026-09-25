// Verifies that scanLogsBackward reports the lower half it forfeits after a
// failed window through onError, so callers that read onError as "the scan
// is incomplete" (InstanceRegistryService's cold scan) don't take a partial
// result as complete.
//
// A fake provider rejects any getLogs range wider than MAX_SPAN blocks and
// records every range it answers. With chunkBlocks = 1000 and MAX_SPAN = 600,
// every full window fails, the upper half (<= 501 blocks) is retried and
// succeeds, and the lower half of each window is never read (by design).
//
// Run (from client/): npx tsx scripts/verify-scan-logs-backward-forfeit.ts [path-to-chunkedLogs.ts]
// The optional path runs the same checks against another copy of
// chunkedLogs.ts (e.g. the pre-fix version) to confirm they fail there.

import path from 'path'
import { pathToFileURL } from 'url'

const MAX_SPAN = 600
const CHUNK = 1000
const FLOOR = 0
const HEAD = 2999
// One event in the lower half of the newest window: it sits in a forfeited
// range, so the scan can't return it with or without the fix.
const EVENT_BLOCK = 2200

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

async function main() {
  const target = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../src/utils/chunkedLogs.ts')
  console.log(`chunkedLogs: ${target}`)
  const { scanLogsBackward } = await import(pathToFileURL(target).href)

  const answered: [number, number][] = []
  const provider: any = {
    async getBlockNumber() { return HEAD },
    async getLogs({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) {
      if (toBlock - fromBlock + 1 > MAX_SPAN) throw new Error(`range ${fromBlock}..${toBlock} too wide`)
      answered.push([fromBlock, toBlock])
      return EVENT_BLOCK >= fromBlock && EVENT_BLOCK <= toBlock ? [{ blockNumber: EVENT_BLOCK }] : []
    },
  }

  const reported: [number, number][] = []
  const logs = await scanLogsBackward(provider, '0x0000000000000000000000000000000000000001', [null], {
    toBlock: HEAD,
    fromBlock: FLOOR,
    chunkBlocks: CHUNK,
    stopOnEmptyWindow: false,
    onError: (from: number, to: number) => { reported.push([from, to]) },
  })

  // Ranges that were never answered by the provider, i.e. not scanned.
  const unread: [number, number][] = []
  let cursor = HEAD
  for (const [from, to] of [...answered].sort((a, b) => b[1] - a[1])) {
    if (to < cursor) unread.push([to + 1, cursor])
    cursor = from - 1
  }
  if (cursor >= FLOOR) unread.push([FLOOR, cursor])
  unread.sort((a, b) => b[0] - a[0])

  console.log(`answered: ${JSON.stringify(answered)}`)
  console.log(`unread:   ${JSON.stringify(unread)}`)
  console.log(`onError:  ${JSON.stringify(reported)}`)

  // The lower halves stay unread either way: forfeiting them is the design.
  check('lower halves are forfeited (unchanged behaviour)', unread, [[2000, 2498], [1000, 1498], [0, 498]])
  check('the event in a forfeited range is not returned', logs.length, 0)
  // What the fix adds: every unread range is reported through onError.
  check('every forfeited range is reported through onError', reported, unread)

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
