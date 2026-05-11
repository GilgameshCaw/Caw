#!/usr/bin/env node
/**
 * Measure real destination-side gas costs for each LayerZero handler, then
 * print recommended `gasLimitFor` coefficients (base + per_entry * n) for each.
 *
 * USAGE:
 *   npx hardhat run scripts/measure-gas.js
 *
 * HOW IT WORKS:
 *   1. Deploys CawProfile, CawProfileL2, their mock LZ endpoints, and dependencies on
 *      a fresh Hardhat node.
 *   2. Wires L1 <-> L2 peers.
 *   3. For each handler selector, impersonates the mock endpoint address and
 *      directly calls lzReceive(...) on the target contract with crafted payloads
 *      at varying batch sizes (n).
 *   4. Strips intrinsic (21000) + calldata gas from each receipt to get pure
 *      execution gas — which is exactly what LayerZero's executor charges the
 *      sender for.
 *   5. Fits a linear model (base + per_entry * n) and prints the result.
 *
 * WHY THIS IS CORRECT:
 *   The gasLimitFor budget represents the gas forwarded to the destination
 *   chain's `lzReceive` call. Measuring via `impersonateAccount(endpoint)` and
 *   then calling `lzReceive` directly reproduces exactly that path — the
 *   `onlyEndpoint` and `onlyPeer` checks both pass, the `fromLZ` flag gets
 *   set and cleared normally, and the delegatecall dispatch runs end-to-end.
 */

const hre = require('hardhat')
const { ethers } = require('ethers')

// ---------- helpers ----------
async function deploy(artifactName, args = []) {
  const artifact = await hre.artifacts.readArtifact(artifactName)
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, await getSigner())
  const c = await factory.deploy(...args)
  await c.waitForDeployment()
  return c
}

let _signer, _provider
async function getProvider() {
  if (_provider) return _provider
  _provider = new ethers.BrowserProvider(hre.network.provider, 'any')
  // ethers v6 BrowserProvider.getSigner() calls eth_requestAccounts, which
  // Hardhat's in-process RPC doesn't implement. Patch it to fall through to
  // eth_accounts.
  const origSend = _provider.send.bind(_provider)
  _provider.send = async (method, params) => {
    if (method === 'eth_requestAccounts') return await origSend('eth_accounts', [])
    return await origSend(method, params)
  }
  return _provider
}
async function getSigner() {
  if (_signer) return _signer
  const HH_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  const provider = await getProvider()
  _signer = await provider.getSigner(HH_0)
  return _signer
}

function calldataGas(data) {
  // EIP-2028 post-Istanbul: 4 per zero byte, 16 per nonzero byte
  const hex = data.startsWith('0x') ? data.slice(2) : data
  let zero = 0, nonzero = 0
  for (let i = 0; i < hex.length; i += 2) {
    if (hex.substring(i, i + 2) === '00') zero++
    else nonzero++
  }
  return zero * 4 + nonzero * 16
}

async function impersonate(addr) {
  await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [addr] })
  await hre.network.provider.request({ method: 'hardhat_setBalance', params: [addr, '0x56BC75E2D63100000'] /* 100 ETH */ })
}

async function stopImpersonate(addr) {
  await hre.network.provider.request({ method: 'hardhat_stopImpersonatingAccount', params: [addr] })
}

/** Send a raw tx from an impersonated account via eth_sendTransaction, bypassing ethers entirely. */
async function sendAs(from, to, data, gasHex = '0x1c9c380' /* 30M */) {
  const txHash = await hre.network.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, gas: gasHex }],
  })
  const receipt = await hre.network.provider.request({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  })
  return receipt
}

/** Build an Origin tuple struct for lzReceive. */
function originTuple(srcEid, senderAddr, nonce = 1) {
  const senderBytes32 = '0x' + senderAddr.replace(/^0x/, '').padStart(64, '0')
  return [srcEid, senderBytes32, nonce]
}

// Shared interface for encoding lzReceive calls
const LZ_RECEIVE_IFACE = new ethers.Interface([
  'function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) _origin, bytes32 _guid, bytes _message, address _executor, bytes _extraData) payable',
])

/**
 * Call target.lzReceive as the endpoint via raw eth_sendTransaction, return execution-only gasUsed.
 */
async function measureLzReceive(target, endpointAddr, origin, payload) {
  await impersonate(endpointAddr)
  const guid = ethers.hexlify(ethers.randomBytes(32))
  const data = LZ_RECEIVE_IFACE.encodeFunctionData('lzReceive', [origin, guid, payload, ethers.ZeroAddress, '0x'])
  const targetAddr = await target.getAddress()
  const receipt = await sendAs(endpointAddr, targetAddr, data)
  await stopImpersonate(endpointAddr)

  if (!receipt || parseInt(receipt.status, 16) !== 1) {
    throw new Error('lzReceive reverted or missing receipt')
  }

  const gasUsed = parseInt(receipt.gasUsed, 16)
  const execGas = gasUsed - 21000 - calldataGas(data)
  return execGas
}

/** Simple linear regression: y = base + slope * n */
function linearFit(points) {
  const N = points.length
  const sumX = points.reduce((a, [x]) => a + x, 0)
  const sumY = points.reduce((a, [, y]) => a + y, 0)
  const sumXY = points.reduce((a, [x, y]) => a + x * y, 0)
  const sumXX = points.reduce((a, [x]) => a + x * x, 0)
  const slope = (N * sumXY - sumX * sumY) / (N * sumXX - sumX * sumX)
  const base = (sumY - slope * sumX) / N
  return { base, slope }
}

function fmtInt(n) { return Math.round(n).toLocaleString() }

// ---------- main ----------
async function main() {
  console.log('\n=== CAW Protocol gasLimitFor benchmark ===\n')

  const signer = await getSigner()
  const deployer = await signer.getAddress()
  console.log('Deployer:', deployer)

  // LZ endpoint IDs (arbitrary — just need to be distinct for peer registration)
  const L1_EID = 1
  const L2_EID = 2

  // ----- Deploy mock LZ endpoints -----
  const l1Endpoint = await deploy('MockLayerZeroEndpoint', [L1_EID])
  const l2Endpoint = await deploy('MockLayerZeroEndpoint', [L2_EID])
  console.log('L1 endpoint:', await l1Endpoint.getAddress())
  console.log('L2 endpoint:', await l2Endpoint.getAddress())

  // ----- Deploy L2 side -----
  const cawProfileL2 = await deploy('CawProfileL2', [L1_EID, await l2Endpoint.getAddress()])
  console.log('CawProfileL2:  ', await cawProfileL2.getAddress())

  // ----- Deploy L1 side (CawProfile needs a network manager + URI generator + CAW token) -----
  const caw = await deploy('MintableCaw')
  const uriGen = await deploy('CawProfileURI')
  const networkMgr = await deploy('CawNetworkManager', [deployer])

  const cawProfile = await deploy('CawProfile', [
    await caw.getAddress(),
    await uriGen.getAddress(),
    deployer,                    // buyAndBurn
    await networkMgr.getAddress(),
    await l1Endpoint.getAddress(),
    L1_EID,
  ])
  console.log('CawProfile:    ', await cawProfile.getAddress())

  // ----- Wire endpoint <-> endpoint so EndpointV2Mock routes know the pair -----
  await l1Endpoint.setDestLzEndpoint(await cawProfileL2.getAddress(), await l2Endpoint.getAddress())
  await l2Endpoint.setDestLzEndpoint(await cawProfile.getAddress(), await l1Endpoint.getAddress())

  // ----- Configure peers -----
  await cawProfile.setL2Peer(L2_EID, await cawProfileL2.getAddress())
  await cawProfileL2.setL1Peer(L1_EID, await cawProfile.getAddress(), false)

  // `setClientChains` on CawProfileL2 is a plain event emitter in the optimistic
  // flow — no replicator target is required. Legacy replicator setup removed.

  // ----- Grab selectors (avoids recomputing) -----
  const addToBalanceSelector = await cawProfile.addToBalanceSelector()
  const mintSelector = await cawProfile.mintSelector()
  const updateOwnersSelector = await cawProfile.updateOwnersSelector()
  const authSelector = await cawProfile.authSelector()
  const setClientChainsSelector = await cawProfile.setClientChainsSelector()
  const setWithdrawableSelector = await cawProfileL2.setWithdrawableSelector()

  // ----- Build payload factories -----
  const encoder = ethers.AbiCoder.defaultAbiCoder()

  const makeOwners = (n, startIdx = 1000) => {
    const tokenIds = Array.from({ length: n }, (_, i) => startIdx + i)
    const owners = Array.from({ length: n }, (_, i) => '0x' + (startIdx + i).toString(16).padStart(40, '0'))
    return { tokenIds, owners }
  }

  // updateOwners(uint32[], address[])
  const buildUpdateOwners = (n) => {
    const { tokenIds, owners } = makeOwners(n)
    return ethers.concat([updateOwnersSelector, encoder.encode(['uint32[]', 'address[]'], [tokenIds, owners])])
  }

  // mintAndUpdateOwners(uint32 tokenId, address owner, string username, uint32[] tokenIds, address[] owners)
  const buildMint = (n) => {
    const { tokenIds, owners } = makeOwners(n, 2000)
    return ethers.concat([
      mintSelector,
      encoder.encode(
        ['uint32', 'address', 'string', 'uint32[]', 'address[]'],
        [9999, deployer, 'testuser', tokenIds, owners]
      ),
    ])
  }

  // depositAndUpdateOwners(uint32 cawNetworkId, uint32 tokenId, uint256 amount, uint32[] tokenIds, address[] owners)
  const buildDeposit = (n) => {
    const { tokenIds, owners } = makeOwners(n, 3000)
    return ethers.concat([
      addToBalanceSelector,
      encoder.encode(
        ['uint32', 'uint32', 'uint256', 'uint32[]', 'address[]'],
        [1, 8888, ethers.parseEther('100'), tokenIds, owners]
      ),
    ])
  }

  // authenticateAndUpdateOwners(uint32 cawNetworkId, uint32 tokenId, uint32[] tokenIds, address[] owners)
  const buildAuth = (n) => {
    const { tokenIds, owners } = makeOwners(n, 4000)
    return ethers.concat([
      authSelector,
      encoder.encode(
        ['uint32', 'uint32', 'uint32[]', 'address[]'],
        [1, 7777, tokenIds, owners]
      ),
    ])
  }

  // setClientChains(uint32 networkId, uint32[] destEids)
  const buildSetClientChains = (n) => {
    const destEids = Array.from({ length: n }, (_, i) => 10 + i) // matches pre-registered chains
    return ethers.concat([
      setClientChainsSelector,
      encoder.encode(['uint32', 'uint32[]'], [1, destEids]),
    ])
  }

  // setWithdrawable(uint32[], uint256[]) — runs on L1 CawProfile
  const buildSetWithdrawable = (n) => {
    const tokenIds = Array.from({ length: n }, (_, i) => 5000 + i)
    const amounts = Array.from({ length: n }, () => ethers.parseEther('10'))
    return ethers.concat([
      setWithdrawableSelector,
      encoder.encode(['uint32[]', 'uint256[]'], [tokenIds, amounts]),
    ])
  }

  // ----- Measurement sweep -----
  const l2EndpointAddr = await l2Endpoint.getAddress()
  const l1EndpointAddr = await l1Endpoint.getAddress()
  const l1PeerOrigin = originTuple(L1_EID, await cawProfile.getAddress())
  const l2PeerOrigin = originTuple(L2_EID, await cawProfileL2.getAddress())

  const sweepsL2 = [0, 1, 3, 5, 10, 25, 50]
  const sweepsL1 = [1, 3, 5, 10, 25, 50]                // L1 setWithdrawable needs n >= 1 (no-op otherwise)
  const sweepsChains = [1, 2, 3, 5, 10]                 // setClientChains

  const results = {}

  const runSweep = async (label, builder, sweeps, target, endpoint, origin, minN = 0) => {
    const points = []
    for (const n of sweeps) {
      if (n < minN) continue
      const payload = builder(n)
      try {
        const gas = await measureLzReceive(target, endpoint, origin, payload)
        points.push([n, gas])
        console.log(`  n=${String(n).padStart(3)}  exec_gas=${fmtInt(gas).padStart(10)}`)
      } catch (e) {
        console.log(`  n=${n}  FAILED: ${e.message}`)
      }
    }
    results[label] = points
  }

  console.log('\n--- L1→L2: updateOwners ---')
  await runSweep('updateOwners', buildUpdateOwners, sweepsL2, cawProfileL2, l2EndpointAddr, l1PeerOrigin)

  console.log('\n--- L1→L2: mintAndUpdateOwners ---')
  await runSweep('mint', buildMint, sweepsL2, cawProfileL2, l2EndpointAddr, l1PeerOrigin)

  console.log('\n--- L1→L2: depositAndUpdateOwners ---')
  await runSweep('addToBalance', buildDeposit, sweepsL2, cawProfileL2, l2EndpointAddr, l1PeerOrigin)

  console.log('\n--- L1→L2: authenticateAndUpdateOwners ---')
  await runSweep('auth', buildAuth, sweepsL2, cawProfileL2, l2EndpointAddr, l1PeerOrigin)

  console.log('\n--- L1→L2: setClientChains ---')
  await runSweep('setClientChains', buildSetClientChains, sweepsChains, cawProfileL2, l2EndpointAddr, l1PeerOrigin, 1)

  console.log('\n--- L2→L1: setWithdrawable ---')
  await runSweep('setWithdrawable', buildSetWithdrawable, sweepsL1, cawProfile, l1EndpointAddr, l2PeerOrigin, 1)

  // ----- Report linear fit -----
  console.log('\n\n=== LINEAR FIT: gas ≈ base + per_entry × n ===\n')
  console.log('selector           |    base    | per_entry | r^2 approx | recommended (base + 30% + per*1.25)')
  console.log('-------------------|------------|-----------|------------|-------------------------------------')

  for (const [label, points] of Object.entries(results)) {
    if (points.length < 2) { console.log(`${label.padEnd(19)}| (insufficient data)`); continue }
    const { base, slope } = linearFit(points)
    const meanY = points.reduce((a, [, y]) => a + y, 0) / points.length
    const ssTot = points.reduce((a, [, y]) => a + (y - meanY) ** 2, 0)
    const ssRes = points.reduce((a, [x, y]) => a + (y - (base + slope * x)) ** 2, 0)
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot
    const recBase = Math.ceil(base * 1.3 / 1000) * 1000
    const recPer = Math.ceil(slope * 1.25 / 500) * 500
    console.log(
      `${label.padEnd(19)}| ${fmtInt(base).padStart(10)} | ${fmtInt(slope).padStart(9)} | ${r2.toFixed(3).padStart(10)} | ${fmtInt(recBase).padStart(7)} + ${fmtInt(recPer).padStart(6)} × n`
    )
  }

  // ----- Safety check: compare measured vs current contract formula -----
  // The source of the formula is whichever contract sends the message (CawProfile for the
  // L1→L2 selectors, CawProfileL2 for setWithdrawable). That's also the contract whose ABI
  // exposes the right gasLimitFor.
  console.log('\n\n=== SAFETY CHECK vs current contract gasLimitFor(selector, n) ===\n')
  console.log('selector          |   n  | measured  | limit     | headroom | status')
  console.log('------------------|------|-----------|-----------|----------|-------')

  const selectorFor = {
    updateOwners:    { contract: cawProfile, sel: updateOwnersSelector },
    mint:            { contract: cawProfile, sel: mintSelector },
    addToBalance:    { contract: cawProfile, sel: addToBalanceSelector },
    auth:            { contract: cawProfile, sel: authSelector },
    setClientChains: { contract: cawProfile, sel: setClientChainsSelector },
    setWithdrawable: { contract: cawProfileL2, sel: setWithdrawableSelector },
  }

  let anyOverrun = false
  for (const [label, points] of Object.entries(results)) {
    const { contract, sel } = selectorFor[label]
    for (const [n, measured] of points) {
      let limit
      try {
        limit = Number(await contract.gasLimitFor(sel, n))
      } catch (e) {
        console.log(`${label.padEnd(18)}| ${String(n).padStart(4)} | ${fmtInt(measured).padStart(9)} | ERROR     |          | ${e.message?.slice(0, 40)}`)
        continue
      }
      const headroom = (limit - measured) / measured
      const status = headroom < 0 ? 'OOG FAIL' : headroom < 0.20 ? 'tight' : 'ok'
      if (headroom < 0) anyOverrun = true
      console.log(
        `${label.padEnd(18)}| ${String(n).padStart(4)} | ${fmtInt(measured).padStart(9)} | ${fmtInt(limit).padStart(9)} | ${(headroom * 100).toFixed(0).padStart(6)}% | ${status}`
      )
    }
  }

  if (anyOverrun) {
    console.log('\n⚠  WARNING: at least one (selector, n) has a measured cost ABOVE the contract limit. These will OOG in production.\n')
    process.exitCode = 1
  } else {
    console.log('\n✓ All measured costs fit within the contract gasLimitFor formula.\n')
  }
  console.log('\nDone.\n')
}

main().catch(e => { console.error(e); process.exit(1) })
