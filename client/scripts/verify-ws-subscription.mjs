// Closer to real usage: RawEventsGatherer/ValidatorService keep a
// WebSocketProvider open and subscribe to new blocks/events continuously,
// rather than making one request and disconnecting. This checks that the
// new ws still holds a subscription open and delivers events over time.
import { WebSocketProvider } from 'ethers'

const url = process.argv[2] || 'wss://base-sepolia-rpc.publicnode.com'
const provider = new WebSocketProvider(url, 84532)

let count = 0
const seen = []
provider.on('block', (blockNumber) => {
  count++
  seen.push(blockNumber)
  console.log(`[block event ${count}] ${blockNumber}`)
})

console.log(`Subscribed to 'block' on ${url}. Watching for 25s...`)
await new Promise((resolve) => setTimeout(resolve, 25000))

provider.removeAllListeners('block')
await provider.destroy()

if (count === 0) {
  console.error('FAIL: no block events received in 25s (subscription may be broken)')
  process.exit(1)
}
console.log(`ALL CHECKS PASSED: received ${count} block event(s): ${seen.join(', ')}`)
