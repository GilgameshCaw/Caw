// Ad-hoc verification: ws resolves to a single patched version across the
// dependency tree, and ethers.WebSocketProvider still works end to end.
import { WebSocketProvider } from 'ethers'
import fs from 'node:fs'
import path from 'node:path'

const clientDir = process.cwd()

function wsVersion(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(clientDir, p), 'utf8')).version
  } catch {
    return null
  }
}

const topLevel = wsVersion('node_modules/ws/package.json')
const nestedInEthers = fs.existsSync(path.join(clientDir, 'node_modules/ethers/node_modules/ws'))

console.log(`Top-level ws version: ${topLevel}`)
console.log(`Nested copy under ethers present: ${nestedInEthers}`)

if (topLevel !== '8.21.3') {
  console.error('FAIL: expected ws 8.21.3')
  process.exit(1)
}
if (nestedInEthers) {
  console.error('FAIL: a separate ws copy still exists under ethers')
  process.exit(1)
}

const url = process.argv[2] || 'wss://base-sepolia-rpc.publicnode.com'
console.log(`Connecting to ${url} ...`)
const provider = new WebSocketProvider(url, 84532)
try {
  const blockNumber = await provider.getBlockNumber()
  console.log(`Received blockNumber: ${blockNumber}`)
} finally {
  await provider.destroy()
}
console.log('ALL CHECKS PASSED')
