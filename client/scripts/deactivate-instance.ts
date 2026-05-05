// Deactivate an on-chain InstanceRegistry entry. Useful for cleaning up
// stale localhost / dev-port URLs that someone registered during a dev
// install — once registered, an instance stays in the registry forever
// unless the owner explicitly deactivates it.
//
// Usage:
//   cd client
//   npx tsx scripts/deactivate-instance.ts <instanceId> [<instanceId> ...]
//
// Reads RPC + owner key from .env (VALIDATOR_PRIVATE_KEY, L1_RPC_URL_HTTP
// or L1_RPC_URL — CawClientManager lives on L1). Owner check is enforced
// on chain; the script will fail loudly if the validator key isn't the
// instance owner.
//
// After running, the FE picks up the change on its next /api/instances
// fetch — InstanceRegistryService rebuilds its cache from the chain.
import 'dotenv/config'
import { ethers } from 'ethers'
import { CLIENT_MANAGER_ADDRESS } from '../src/abi/addresses'
import { cawClientManagerAbi } from '../src/abi/generated'
import { makeJsonRpcProvider, getL1HttpRpcUrl } from '../src/utils/rpcProvider'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    throw new Error('usage: deactivate-instance.ts <instanceId> [<instanceId> ...]')
  }
  const ids = args.map(s => {
    const n = Number(s)
    if (!Number.isInteger(n) || n < 0) throw new Error(`invalid instanceId: ${s}`)
    return n
  })

  // Use the project's auth-aware RPC helpers — Infura requires the
  // L1_RPC_SECRET as a basic-auth header (not embedded in the URL),
  // so a plain `new JsonRpcProvider(url)` returns 403 Forbidden on
  // every project that has secrets enabled.
  const rpc = getL1HttpRpcUrl()
  const pk = process.env.VALIDATOR_PRIVATE_KEY
  if (!rpc) throw new Error('L1_RPC_URL_HTTP / L1_RPC_URL not set')
  if (!pk) throw new Error('VALIDATOR_PRIVATE_KEY not set')

  const provider = makeJsonRpcProvider(rpc)
  const wallet = new ethers.Wallet(pk, provider)
  const ccm = new ethers.Contract(CLIENT_MANAGER_ADDRESS, cawClientManagerAbi as any, wallet)

  console.log(`CawClientManager: ${CLIENT_MANAGER_ADDRESS}`)
  console.log(`Caller:           ${wallet.address}`)
  console.log()

  for (const id of ids) {
    try {
      const owner: string = await ccm.instanceOwner(id)
      if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.error(`✗ instance ${id}: owner is ${owner}, not the caller — skipping`)
        continue
      }
      const isActive: boolean = await ccm.instanceActive(id)
      if (!isActive) {
        console.log(`• instance ${id} already inactive — skipping`)
        continue
      }
      console.log(`→ deactivating instance ${id}...`)
      const tx = await ccm.deactivateInstance(id)
      console.log(`  tx: ${tx.hash}`)
      const receipt = await tx.wait()
      console.log(`  ✓ confirmed in block ${receipt?.blockNumber}`)
    } catch (e: any) {
      console.error(`✗ instance ${id} failed: ${e?.shortMessage || e?.message || e}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
