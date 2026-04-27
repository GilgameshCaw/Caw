// Print every replication submission a given validator/replicator has made,
// with status, finalize-eligibility, and current stake.
//
// Usage:
//   cd client
//   npx tsx scripts/inspect-submissions.ts                 # default: REPLICATOR
//   npx tsx scripts/inspect-submissions.ts VALIDATOR       # main validator key
//   npx tsx scripts/inspect-submissions.ts 0xDeadBeef...   # arbitrary address
//
// Reads REPLICATION_CHAIN to pick the right archive (same logic as the
// validator + the deposit/slash scripts).
import 'dotenv/config'
import { ethers } from 'ethers'
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

function resolveAddress(arg?: string): string {
  if (!arg || arg.toUpperCase() === 'REPLICATOR') {
    const pk = process.env.REPLICATOR_PRIVATE_KEY
    if (!pk) throw new Error('REPLICATOR_PRIVATE_KEY not set')
    return new ethers.Wallet(pk).address
  }
  if (arg.toUpperCase() === 'VALIDATOR') {
    const pk = process.env.VALIDATOR_PRIVATE_KEY
    if (!pk) throw new Error('VALIDATOR_PRIVATE_KEY not set')
    return new ethers.Wallet(pk).address
  }
  if (!ethers.isAddress(arg)) throw new Error(`Not an address or known label: ${arg}`)
  return ethers.getAddress(arg)
}

const STATUS = ['PENDING', 'FINALIZED', 'SLASHED'] as const

function fmtRel(seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs < 60) return `${seconds}s`
  if (abs < 3600) return `${(seconds / 60).toFixed(1)}m`
  if (abs < 86400) return `${(seconds / 3600).toFixed(1)}h`
  return `${(seconds / 86400).toFixed(1)}d`
}

async function main() {
  const target = resolveAddress(process.argv[2])
  const archiveAddress = resolveReplicationArchive()
  const rpc = process.env.REPLICATION_RPC || process.env.L2B_RPC_URL
  if (!rpc) throw new Error('REPLICATION_RPC (or L2B_RPC_URL) not set')

  const provider = new ethers.JsonRpcProvider(rpc)

  const archive = new ethers.Contract(archiveAddress, [
    'function nextSubmissionId() view returns (uint256)',
    'function stakes(address) view returns (uint256)',
    'function pendingCount(address) view returns (uint256)',
    'function getValidatorSubmissionCount(address) view returns (uint256)',
    'function validatorSubmissions(address, uint256) view returns (uint256)',
    // 7-tuple: submitter, merkleRoot, clientId, startCp, endCp, finalizedAt, status
    'function getSubmission(uint256) view returns (address,bytes32,uint32,uint256,uint256,uint256,uint8)',
    'function CHALLENGE_PERIOD() view returns (uint256)',
    'function MIN_STAKE() view returns (uint256)',
  ], provider)

  console.log(`replication chain: ${process.env.REPLICATION_CHAIN || 'arbitrum-sepolia'}`)
  console.log(`archive:           ${archiveAddress}`)
  console.log(`target:            ${target}`)

  const [stake, pending, subCount, minStake, challengePeriod, latestBlock] = await Promise.all([
    archive.stakes(target),
    archive.pendingCount(target),
    archive.getValidatorSubmissionCount(target),
    archive.MIN_STAKE(),
    archive.CHALLENGE_PERIOD(),
    provider.getBlockNumber(),
  ])
  const block = await provider.getBlock(latestBlock)
  const now = Number(block!.timestamp)

  console.log()
  console.log(`stake:             ${ethers.formatEther(stake)} ETH ` +
              `(MIN_STAKE=${ethers.formatEther(minStake)})`)
  console.log(`pendingCount:      ${pending}`)
  console.log(`total submissions: ${subCount}`)
  console.log(`CHALLENGE_PERIOD:  ${fmtRel(Number(challengePeriod))}`)
  console.log(`chain time:        ${new Date(now * 1000).toISOString()}`)

  const total = Number(subCount)
  if (total === 0) {
    console.log('\n  (no submissions found for this address)')
    return
  }

  const ids: number[] = []
  for (let i = 0; i < total; i++) {
    ids.push(Number(await archive.validatorSubmissions(target, i)))
  }

  console.log()
  console.log(`╭─ submissions ─────────────────────────────────────────────╮`)
  for (const id of ids) {
    const s = await archive.getSubmission(id)
    const submitter = s[0] as string
    const merkleRoot = s[1] as string
    const clientId = Number(s[2])
    const startCp = Number(s[3])
    const endCp = Number(s[4])
    const finalizedAt = Number(s[5])
    const status = STATUS[Number(s[6])] || `?(${s[6]})`

    const remaining = finalizedAt - now
    const eligible = remaining <= 0
    const eligibleStr = status !== 'PENDING'
      ? '—'
      : eligible
        ? `eligible to finalize NOW (overdue ${fmtRel(-remaining)})`
        : `${fmtRel(remaining)} until finalize-eligible`

    console.log(`│`)
    console.log(`│  #${id}  status=${status}  client=${clientId}  cp=${startCp}..${endCp}`)
    console.log(`│        submitter:     ${submitter}`)
    console.log(`│        merkleRoot:    ${merkleRoot}`)
    console.log(`│        finalizedAt:   ${new Date(finalizedAt * 1000).toISOString()}`)
    console.log(`│        ${eligibleStr}`)
  }
  console.log(`╰───────────────────────────────────────────────────────────╯`)
}

main().catch(e => { console.error(e?.shortMessage || e?.message || e); process.exit(1) })
