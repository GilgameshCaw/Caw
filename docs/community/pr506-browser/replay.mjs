import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import solc from 'solc'
import { createPublicClient, createWalletClient, http } from 'viem'
import { sepolia } from 'viem/chains'

const rpc = 'http://127.0.0.1:' + Number(process.argv[2])
const chain = createPublicClient({ chain: sepolia, transport: http(rpc) })
const wallet = createWalletClient({ chain: sepolia, transport: http(rpc) })
const [owner, validator] = await wallet.getAddresses()
const source = readFileSync('../../../solidity/contracts/CawNetworkManager.sol', 'utf8')
const compiled = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity',
  sources: { 'manager.sol': { content: source } }, settings: { viaIR: true,
    optimizer: { enabled: true, runs: 1 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })))
const artifact = compiled.contracts?.['manager.sol']?.CawNetworkManager
assert.ok(artifact, JSON.stringify(compiled.errors))
async function mine(hash) {
  const receipt = await chain.waitForTransactionReceipt({ hash: await hash })
  assert.equal(receipt.status, 'success')
  return receipt
}
const { abi } = artifact
const { contractAddress: address } = await mine(wallet.deployContract({ abi, account: owner,
  bytecode: '0x' + artifact.evm.bytecode.object, args: [validator] }))
const send = (functionName, args) => mine(wallet.writeContract({ address, abi, account: owner, functionName, args }))
await send('createNetwork', ['browser', owner, 1, 0, 0, 0, 0, 0])
await send('registerInstance', [1, 'https://old.invalid', owner])
await send('updateInstance', [1, 'https://updated.invalid', validator])
await send('deactivateInstance', [1])
await send('registerInstance', [1, 'https://live.invalid', owner])

await send('createNetwork', ['second', owner, 1, 0, 0, 0, 0, 0])
await send('registerInstance', [2, 'https://second.invalid', owner])

// Supply only deployment configuration and redirect package imports to the locked toolchain.
const overrides = new Map([
  ['~/config/Web3Provider', "import { createConfig, http } from '@wagmi/core'; import { sepolia } from 'viem/chains'; export const wagmiConfig=createConfig({chains:[sepolia],transports:{[sepolia.id]:http(location.origin+'/rpc')}})"],
  ['~/../../../abi/addresses', 'export const NETWORK_MANAGER_ADDRESS=' + JSON.stringify(address)],
  ['~/api/client', "export const API_HOST=''"],
])
const { outputFiles } = await build({ entryPoints: ['entry.js'], bundle: true, write: false,
  define: { 'process.env.NODE_ENV': '"production"' }, alias: { 'wagmi/chains': 'viem/chains',
    ...Object.fromEntries(['zustand','@wagmi/core','viem','react'].map(p => [p, resolve('node_modules',p)])) },
  plugins: [{ name: 'disposable-deployment', setup(b) {
    b.onResolve({ filter: /^~\// }, ({path}) => overrides.has(path) ? { path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({path}) => ({contents: overrides.get(path), resolveDir: process.cwd()}))
  }}] })
const calls = [], offline = [], unexpected = []
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') return res.end('<!doctype html><title>Discovery replay</title><script>window.initialKeys=Object.keys(localStorage)</script><script src="/app.js"></script>')
    if (req.url === '/app.js') { res.setHeader('Content-Type','text/javascript'); return res.end(outputFiles[0].contents) }
    if (req.url === '/api/instances?networkId=1') { offline.push(req.url); return req.socket.destroy() }
    if (req.url === '/rpc' && req.method === 'POST') {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks)
      for (const q of [JSON.parse(body)].flat()) calls.push(q.method)
      const reply = await fetch(rpc, { method:'POST', headers:{'Content-Type':'application/json'}, body })
      res.writeHead(reply.status, {'Content-Type':'application/json'}); return res.end(await reply.text())
    }
    res.writeHead(404); res.end()
  } catch (err) { res.writeHead(502); res.end(String(err)) }
})
server.listen(0,'127.0.0.1'); await once(server,'listening')
let browser
try {
  const origin = 'http://127.0.0.1:' + server.address().port
  browser = await chromium.launch()
  const context = await browser.newContext({ serviceWorkers:'block' })
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    unexpected.push(route.request().url()); return route.abort()
  })
  const page = await context.newPage()
  await page.goto(origin)
  const result = await page.evaluate(() => window.discover())
  assert.deepEqual(await page.evaluate(() => window.initialKeys), []); assert.equal(result.before.peers, 0); assert.ok(result.before.keys.every(k => k === 'wagmi.store'))
  assert.ok(offline.length > 0)
  assert.deepEqual(unexpected, [])
  for (const m of ['eth_getBlockByNumber','eth_getLogs','eth_call']) assert.ok(calls.includes(m),m)
  assert.equal(result.error,null); assert.equal(result.source,'chain')
  const expected = [
    {instanceId:2,networkId:1,owner,apiUrl:'https://live.invalid',validatorAddress:owner,active:true},
    {instanceId:1,networkId:1,owner,apiUrl:'https://updated.invalid',validatorAddress:validator,active:false},
  ]
  assert.deepEqual(result.peers, expected)
  assert.deepEqual(result.cached.instances, expected)
  assert.deepEqual(result.hosts,['https://live.invalid'])
  // A separate fresh context starts with both discovery transports unavailable.
  const cold = await browser.newContext({ serviceWorkers:'block' })
  const tab = await cold.newPage()
  let rpcOut = true
  let releaseOld
  let signalOldRequest
  const oldRequestStarted = new Promise(resolve => { signalOldRequest = resolve })
  await tab.route('**/api/instances?networkId=3', async route => {
      const released = new Promise(resolve => { releaseOld = resolve })
      signalOldRequest()
      await released
      await route.fulfill({ json: {networkId:3, instances:[{...expected[0],networkId:3}]} })
    })
  await tab.route('**/rpc', route => rpcOut ? route.fulfill({status:400, body:'offline'}) : route.continue())
  await tab.route('**/api/instances?networkId=2', route =>
    route.fulfill({json:{networkId:1,instances:expected}}))
  const leakedRequests = []
  await cold.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue()
    leakedRequests.push(route.request().url())
    return route.abort()
  })
  await tab.goto(origin)
  assert.deepEqual(await tab.evaluate(() => window.initialKeys), [])
  const failed = await tab.evaluate(() => window.discover())
  assert.ok(failed.error)
  assert.equal(failed.cached,null)
  rpcOut = false
  // No second discover call, reload, or clock advancement.
  await tab.waitForFunction(() => window.peerSnapshot().source === 'chain', null, {timeout:20000})
  assert.deepEqual((await tab.evaluate(() => window.peerSnapshot())).peers, expected)
  await tab.evaluate(() => window.pinPeer('https://live.invalid'))
  assert.equal((await tab.evaluate(() => window.peerSnapshot())).pinned,'https://live.invalid')
  const switching = await tab.evaluate(() => {
    window.oldRefresh = window.discover(3)
    return window.peerSnapshot()
  })
  assert.deepEqual(switching.peers,[])
  assert.deepEqual(switching.hosts,[])
  assert.equal(switching.pinned,null)
  await oldRequestStarted
  const second = await tab.evaluate(() => window.discover(2))
  assert.equal(second.source,'chain')
  assert.deepEqual(second.hosts,['https://second.invalid'])
  assert.deepEqual(second.peers.map(p => p.networkId),[2])
  releaseOld()
  await tab.evaluate(async () => {
    await window.oldRefresh
    window.pinPeer('https://live.invalid')
  })
  const settled = await tab.evaluate(() => window.peerSnapshot())
  assert.deepEqual(settled.peers,second.peers)
  assert.deepEqual(settled.hosts,second.hosts)
  assert.equal(settled.pinned,null)
  assert.equal(await tab.evaluate(() => localStorage.getItem('caw:instances:3')),null)
  assert.deepEqual(leakedRequests,[])
  // Hold a registry read while the user leaves network 4. Its late result must
  // not replace network 2 or write a cache entry after the switch.
  let releaseRpc, signalRpc
  const rpcStarted = new Promise(resolve => { signalRpc = resolve })
  const rpcReleased = new Promise(resolve => { releaseRpc = resolve })
  await tab.route('**/rpc', async route => {
    if ([route.request().postDataJSON()].flat().some(q => q.method === 'eth_getLogs')) {
      signalRpc()
      await rpcReleased
    }
    await route.continue()
  })
  await tab.evaluate(() => { window.heldChain = window.discover(4) })
  await Promise.race([rpcStarted, tab.waitForTimeout(8000).then(() => { throw Error('Network 4 chain read did not start') })])
  // Provide a valid same-network API response on the return visit.
  await tab.route('**/api/instances?networkId=2', route => route.fulfill({json:{networkId:2,instances:second.peers}}))
  const returned = await tab.evaluate(() => window.discover(2))
  assert.equal(returned.source,'api')
  releaseRpc()
  await tab.evaluate(() => window.heldChain)
  assert.deepEqual((await tab.evaluate(() => window.peerSnapshot())).peers,second.peers)
  assert.equal(await tab.evaluate(() => localStorage.getItem('caw:instances:4')),null)
  await cold.close()
  console.log(JSON.stringify({verdict:'PASS', chromium:browser.version(), initialKeys:[], before:result.before,
    offlineEndpoint:offline[0], rpcMethods:[...new Set(calls)], source:result.source, peers:result.peers,
    activeHosts:result.hosts, cacheMatched:true, automaticRecovery:true, switchClearedPeers:true, lateResponseIgnored:true, lateChainReadIgnored:true,
    secondNetworkHosts:second.hosts, externalRequests:unexpected},null,2))
} finally { try { await browser?.close() } finally { server.closeAllConnections(); server.close() } }
