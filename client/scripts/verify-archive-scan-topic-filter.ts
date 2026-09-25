// Verify scanArchiveEvents' topic filtering against the live Arbitrum Sepolia
// archive. Reproduces the OLD logic (target.topics ?? []) and the NEW logic
// (getTopicFilter() + event-name check) side by side. Read-only.
// Usage: npx tsx scripts/verify-archive-scan-topic-filter.ts <submitterAddress> <submissionId>
import { JsonRpcProvider, Contract } from 'ethers'
import { scanLogsForward } from '../src/utils/chunkedLogs'

const RPC = process.env.REPLICATION_RPC || 'https://arbitrum-sepolia-rpc.publicnode.com'
const ARCHIVE = '0x3B526a24a740F8FD5Ed9688E109414Ec10786B8D'
const [ME, SUB_ID_ARG] = process.argv.slice(2)
if (!ME || !/^0x[0-9a-fA-F]{40}$/.test(ME) || !SUB_ID_ARG) {
  console.error('usage: npx tsx scripts/verify-archive-scan-topic-filter.ts <submitterAddress> <submissionId>')
  process.exit(1)
}
const SUB_ID = Number(SUB_ID_ARG)
const abi = [
  'event SubmissionCreated(uint256 indexed submissionId, address indexed submitter, uint32 indexed networkId, uint256 startCheckpointId, uint256 endCheckpointId, bytes32 merkleRoot)',
  'event ActionsArchived(uint256 indexed submissionId, uint32 indexed networkId, uint16 actionCount, bytes32 packedHash, bytes32 rHash, bytes32 entryHash)',
]

async function scan(archive: Contract, provider: any, filter: any, from: number, to: number, fixed: boolean) {
  const target: any = await filter
  const topics = fixed
    ? (typeof target?.getTopicFilter === 'function' ? await target.getTopicFilter() : (target?.topics ?? []))
    : (target.topics ?? [])
  const wanted: string | undefined = fixed ? target?.fragment?.name : undefined
  const raw = await scanLogsForward(provider, target.address ?? (archive.target as string), topics, from, to)
  return raw.map(log => {
    const parsed = archive.interface.parseLog({ topics: log.topics as string[], data: log.data })
    if (!parsed) return null
    if (wanted && parsed.name !== wanted) return null
    return { name: parsed.name, args: parsed.args, block: log.blockNumber }
  }).filter((e): e is NonNullable<typeof e> => e !== null)
}

function summarize(label: string, evs: any[]) {
  const counts: Record<string, number> = {}
  for (const e of evs) counts[e.name] = (counts[e.name] || 0) + 1
  const badSubmitter = evs.filter(e => typeof (e.args[1] || e.args.submitter) !== 'string').length
  console.log(`  ${label}: total=${evs.length} ${JSON.stringify(counts)} / args[1] not a string (monitor would crash): ${badSubmitter}`)
  if (evs[0]) console.log(`    [0] = ${evs[0].name}(id=${evs[0].args[0]}) @ block ${evs[0].block}`)
}

async function main() {
  const provider = new JsonRpcProvider(RPC)
  const archive = new Contract(ARCHIVE, abi, provider)
  const latest = await provider.getBlockNumber()
  const from = Math.max(0, latest - 28800 * 3) // same lookback as monitorOptimisticSubmissions
  console.log(`archive ${ARCHIVE}, blocks ${from}..${latest}, me=${ME}, submissionId=${SUB_ID}`)
  const cases: [string, any][] = [
    ['SubmissionCreated()            [monitor]', archive.filters.SubmissionCreated()],
    ['SubmissionCreated(null, me)    [auto-finalize]', archive.filters.SubmissionCreated(null, ME)],
    [`ActionsArchived(${SUB_ID})             [challenge/slash]`, archive.filters.ActionsArchived(SUB_ID)],
  ]
  for (const [label, filter] of cases) {
    console.log(`== ${label}`)
    summarize('OLD', await scan(archive, provider, filter, from, latest, false))
    summarize('NEW', await scan(archive, provider, filter, from, latest, true))
  }
}
main().catch(e => { console.error(e); process.exit(1) })
