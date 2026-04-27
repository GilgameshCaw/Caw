// Manual Mode A slash tool. Submits a slashIncoherentRoot tx for a given
// pending submission against the current archive.
//
// Useful when the monitor service is offline/blocked but you still want to
// slash a fraudulent submission, or for debugging the slash path against a
// known-bad submissionId.
//
// Usage:
//   cd client
//   npx tsx scripts/slash-incoherent.ts <submissionId>
//
// Reads RPC + key from .env (VALIDATOR_PRIVATE_KEY, REPLICATION_RPC or
// L2B_RPC_URL, L2_RPC_URL). Archive address resolves from
// REPLICATION_CHAIN via deployments.ts (NOT the per-install
// CAW_ACTIONS_ARCHIVE_ADDRESS, which is the storage chain's archive
// and would point at the wrong address when replicating across chains).
import 'dotenv/config'
import { ethers } from 'ethers'
import { CAW_ACTIONS_ADDRESS } from '../src/abi/addresses'
import { deployments, type Env, type ChainKey } from '../src/abi/deployments'

const REPLICATION_CHAIN_META: Record<string, { env: Env; chainKey: ChainKey }> = {
  'arbitrum-sepolia': { env: 'testnet', chainKey: 'L2b' },
  'arbitrum-one':     { env: 'mainnet', chainKey: 'L2b' },
  'arbitrum':         { env: 'mainnet', chainKey: 'L2b' },
  'base-sepolia':     { env: 'testnet', chainKey: 'L2'  },
  'base':             { env: 'mainnet', chainKey: 'L2'  },
}

function resolveReplicationArchive(): string {
  const replicationChain = process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'
  const meta = REPLICATION_CHAIN_META[replicationChain]
  if (!meta) {
    throw new Error(
      `REPLICATION_CHAIN="${replicationChain}" — supported keys: ${Object.keys(REPLICATION_CHAIN_META).join(', ')}`
    )
  }
  const address = deployments[meta.env]?.[meta.chainKey]?.CawActionsArchive
  if (!address) {
    throw new Error(
      `No CawActionsArchive deployment for ${meta.env}/${meta.chainKey} ` +
      `(REPLICATION_CHAIN=${replicationChain}) in client/src/abi/deployments.ts`
    )
  }
  return address
}

async function main() {
  const subIdArg = process.argv[2]
  if (!subIdArg) throw new Error('usage: slash-incoherent.ts <submissionId>')
  const SUBID = BigInt(subIdArg)

  const arbRpc = process.env.REPLICATION_RPC || process.env.L2B_RPC_URL
  const baseRpc = process.env.L2_RPC_URL_HTTP || process.env.L2_RPC_URL || 'https://sepolia.base.org'
  const pk = process.env.VALIDATOR_PRIVATE_KEY
  if (!arbRpc) throw new Error('REPLICATION_RPC (or L2B_RPC_URL) not set')
  if (!pk) throw new Error('VALIDATOR_PRIVATE_KEY not set')

  const archiveAddress = resolveReplicationArchive()
  console.log(`Archive: ${archiveAddress} on ${process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'}`)

  const arb = new ethers.JsonRpcProvider(arbRpc)
  const base = new ethers.JsonRpcProvider(baseRpc)
  const wallet = new ethers.Wallet(pk, arb)

  const archiveAbi = [
    'function submissions(uint256) view returns (address submitter, bytes32 merkleRoot, uint32 clientId, uint64 startCheckpointId, uint64 endCheckpointId, uint64 finalizedAt, uint8 status, bytes32 dataCommitment)',
    'function stakes(address) view returns (uint256)',
    'function slashIncoherentRoot(uint256,bytes,bytes32[],bytes32)',
    'event ActionsArchived(uint256 indexed submissionId, uint32 indexed clientId, bytes packedActions, bytes32[] r)',
  ]
  const cawActionsAbi = ['function clientHashAtCheckpoint(uint32,uint256) view returns (bytes32)']

  const archive = new ethers.Contract(archiveAddress, archiveAbi, arb)
  const archiveW = new ethers.Contract(archiveAddress, archiveAbi, wallet)
  const cawActions = new ethers.Contract(CAW_ACTIONS_ADDRESS, cawActionsAbi, base)

  const sub = await archive.submissions(SUBID)
  const status = Number(sub.status)
  console.log(`Submission ${SUBID}: status=${['PENDING','FIN','SLASHED'][status]} cp=${sub.startCheckpointId}..${sub.endCheckpointId} submitter=${sub.submitter}`)
  if (status !== 0) { console.log('Not pending; skipping'); return }
  console.log('  merkleRoot:    ', sub.merkleRoot)
  console.log('  dataCommitment:', sub.dataCommitment)

  // Find the ActionsArchived event for this submission. Search a wide window
  // since older submissions might be more than 30k blocks back on Arbitrum.
  const latest = await arb.getBlockNumber()
  const events = await archive.queryFilter(
    archive.filters.ActionsArchived(SUBID),
    Math.max(0, latest - 200_000), latest,
  )
  if (events.length === 0) throw new Error('ActionsArchived event not found in the last 200k blocks')
  const args = (events[0] as any).args
  const packedHex: string = args[2]
  const rArr: string[] = (args[3] as string[]).map(x => String(x))
  console.log(`  packedActions: ${(packedHex.length - 2) / 2} bytes, r: ${rArr.length} items`)

  const startCp = Number(sub.startCheckpointId)
  const entryHash = startCp === 1
    ? '0x' + '00'.repeat(32)
    : await cawActions.clientHashAtCheckpoint(sub.clientId, BigInt(startCp) - 1n)
  console.log('  entryHash:     ', entryHash)

  // Sanity: check the dataCommitment matches what the contract stored.
  const expected = ethers.keccak256(ethers.concat([
    ethers.keccak256(packedHex),
    ethers.keccak256(ethers.solidityPacked(['bytes32[]'], [rArr])),
    entryHash as string,
  ]))
  if (expected.toLowerCase() !== sub.dataCommitment.toLowerCase()) {
    console.log('  ✗ dataCommitment mismatch — cannot slash via slashIncoherentRoot')
    console.log('    rebuilt:', expected)
    return
  }
  console.log('  ✓ dataCommitment matches')

  console.log('\nstaticCall slashIncoherentRoot...')
  try {
    await archiveW.slashIncoherentRoot.staticCall(SUBID, packedHex, rArr, entryHash)
    console.log('  ✓ static OK — committed root really is incoherent with the data')
  } catch (e: any) {
    console.log('  ✗ static error:', e.shortMessage || e.message)
    if (e.revert?.args?.[0] === 'Root matches, no fraud') {
      console.log('    The committed merkleRoot DOES match the rebuilt root — this submission is NOT slashable via Mode A.')
      console.log('    If it is fraudulent, it must be Mode B (use resolveChallenge instead).')
    }
    return
  }

  // Estimate gas. slashIncoherentRoot scales with action count: ~5M observed
  // for 128 actions. Pad 50% and floor at 6M.
  let gasLimit: bigint
  try {
    const est = await archiveW.slashIncoherentRoot.estimateGas(SUBID, packedHex, rArr, entryHash)
    gasLimit = (est * 150n) / 100n
    if (gasLimit < 6_000_000n) gasLimit = 6_000_000n
    console.log(`  gas estimate: ${est}, sending with gasLimit=${gasLimit}`)
  } catch {
    gasLimit = 10_000_000n
    console.log('  estimateGas failed, falling back to 10M gas limit')
  }

  const balBefore = await arb.getBalance(wallet.address)
  console.log('\nsending slashIncoherentRoot...')
  const tx = await archiveW.slashIncoherentRoot(SUBID, packedHex, rArr, entryHash, { gasLimit })
  console.log('  tx:', tx.hash)
  const rc = await tx.wait()
  console.log('  status:', rc?.status === 1 ? 'SUCCESS ✓' : 'FAILED ✗', 'gasUsed:', rc?.gasUsed?.toString())

  const after = await archive.submissions(SUBID)
  console.log('\npost-slash submission status:', ['PENDING','FIN','SLASHED'][Number(after.status)])
  const balAfter = await arb.getBalance(wallet.address)
  console.log('challenger net (reward - gas):', ethers.formatEther(balAfter - balBefore), 'ETH')
  console.log('submitter stake now:', ethers.formatEther(await archive.stakes(sub.submitter)), 'ETH')
}

main().catch(e => { console.error('ERR:', e?.shortMessage || e?.message || e); process.exit(1) })
