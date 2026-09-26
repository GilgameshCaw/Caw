// Checks the RevokeSession EIP-712 signature the frontend produces against a
// deployed CawProfileLedger. Read-only (eth_getCode + one eth_call):
//  1. which RevokeSession typehash the deployed runtime bytecode embeds
//     (REVOKE_SESSION_TYPEHASH is a private constant, so it is inlined),
//  2. whether the frontend's SESSION_DOMAIN hashes to the deployed
//     eip712DomainHash,
//  3. whether a signature over the frontend's typed data recovers to the
//     session key under the digest that revokeSessionBySig computes, for the
//     current typed data (no expiry) and with expiry added.
// EIP-712 signing is library-independent; ethers is used here because it is
// already a backend dependency. Uses throwaway keys generated at run time.
//
// Run (from client/): npx tsx scripts/verify-revoke-session-sig.ts <l2RpcUrl> <cawProfileLedgerAddress>

import { ethers } from 'ethers'

const [rpcUrl, ledgerArg] = process.argv.slice(2)
if (!rpcUrl || !ledgerArg) {
  console.error('usage: npx tsx scripts/verify-revoke-session-sig.ts <l2RpcUrl> <cawProfileLedgerAddress>')
  process.exit(2)
}

async function main() {
  const ledger = ethers.getAddress(ledgerArg)
  const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true })

  const thWith = ethers.id('RevokeSession(address owner,address sessionKey,uint64 expiry)')
  const thWithout = ethers.id('RevokeSession(address owner,address sessionKey)')

  const code = (await provider.getCode(ledger)).toLowerCase()
  const has = (h: string) => code.includes(h.slice(2).toLowerCase())
  console.log(`ledger ${ledger}, runtime bytecode ${(code.length - 2) / 2} bytes`)
  console.log(`[1] typehash with expiry    ${thWith}: ${has(thWith) ? 'PRESENT' : 'absent'}`)
  console.log(`[1] typehash without expiry ${thWithout}: ${has(thWithout) ? 'PRESENT' : 'absent'}`)

  const c = new ethers.Contract(ledger, ['function eip712DomainHash() view returns (bytes32)'], provider)
  const onchainDomain: string = await c.eip712DomainHash()
  // Same fields as SESSION_DOMAIN in FrontEnd/src/hooks/useSessionKey.ts
  const domain = { name: 'CawProfileLedger', version: '1', chainId: 84532, verifyingContract: ledger }
  const feDomain = ethers.TypedDataEncoder.hashDomain(domain)
  console.log(`[2] eip712DomainHash on-chain ${onchainDomain}`)
  console.log(`[2] SESSION_DOMAIN hashes to  ${feDomain}: ${onchainDomain.toLowerCase() === feDomain.toLowerCase() ? 'MATCH' : 'MISMATCH'}`)

  // Digest as revokeSessionBySig builds it, with the on-chain domain hash.
  const session = ethers.Wallet.createRandom()
  const owner = ethers.Wallet.createRandom().address
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400)
  const structHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'address', 'uint64'],
    [thWith, owner, session.address, expiry],
  ))
  const digest = ethers.keccak256(ethers.concat(['0x1901', onchainDomain, structHash]))

  const sigCurrent = await session.signTypedData(
    domain,
    { RevokeSession: [{ name: 'owner', type: 'address' }, { name: 'sessionKey', type: 'address' }] },
    { owner, sessionKey: session.address },
  )
  const sigFixed = await session.signTypedData(
    domain,
    { RevokeSession: [{ name: 'owner', type: 'address' }, { name: 'sessionKey', type: 'address' }, { name: 'expiry', type: 'uint64' }] },
    { owner, sessionKey: session.address, expiry },
  )
  const recCurrent = ethers.recoverAddress(digest, sigCurrent)
  const recFixed = ethers.recoverAddress(digest, sigFixed)
  const same = (a: string) => a.toLowerCase() === session.address.toLowerCase()
  console.log(`[3] session key                       ${session.address}`)
  console.log(`[3] current typed data recovers to    ${recCurrent}: ${same(recCurrent) ? 'OK' : 'BadSig'}`)
  console.log(`[3] with expiry added, recovers to    ${recFixed}: ${same(recFixed) ? 'OK' : 'BadSig'}`)
}

main().catch((e) => { console.error(e); process.exit(2) })
