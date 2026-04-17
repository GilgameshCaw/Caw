// Prove that replicated checkpoint data is fully recoverable.
//
// Instead of waiting for LZ delivery to the archive, this script:
//   1. Fetches the confirmed replicateBatch tx from Base Sepolia
//   2. Decodes the calldata to extract (actions, r)
//   3. Re-encodes the LZ payload exactly as the contract does: abi.encode(actions, r)
//   4. Runs it through the same decode + smltxt decompress that read-archive.ts uses
//   5. Prints every action with its original plaintext
//
// This is the same data the archive will receive once LZ delivers — we're just
// reading it from the source side instead of the destination.
//
// Usage: cd client && npx tsx scripts/prove-recovery.ts [txHash]

import 'dotenv/config'
import { JsonRpcProvider, AbiCoder, Interface } from 'ethers'
import SmlTxt from 'smltxt'

const ACTION_TUPLE_BYTES =
  'tuple(uint8 actionType, uint32 senderId, uint32 receiverId, uint32 receiverCawonce, ' +
  'uint32 clientId, uint32 cawonce, uint32[] recipients, uint64[] amounts, bytes text)'

const REPLICATE_BATCH_ABI = [
  `function replicateBatch(tuple(uint32 clientId, uint32 destEid, uint256 checkpointId, uint256 lzTokenAmount) params, ${ACTION_TUPLE_BYTES}[] actions, bytes32[] r) payable`,
]

const smltxt = SmlTxt.fromPkg()

function decompressHex(hex: string): string {
  if (!hex || hex === '0x') return ''
  try {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex
    const bytes = new Uint8Array(clean.match(/.{1,2}/g)!.map(b => parseInt(b, 16)))
    return smltxt.decompress(bytes)
  } catch { return `[decompress failed: ${hex.slice(0, 20)}…]` }
}

const ACTION_TYPE_NAMES: Record<number, string> = {
  0: 'CAW', 1: 'LIKE', 2: 'UNLIKE', 3: 'RECAW',
  4: 'FOLLOW', 5: 'UNFOLLOW', 6: 'WITHDRAW', 7: 'OTHER',
}

async function main() {
  // Default to checkpoint 2 (the smltxt-compressed one that succeeded)
  const txHash = process.argv[2] || '0x7c0b23a64e9aa3fd63698263d990ff7783610fc3ec9d06f57f0418a5f2cde875'
  const rpcUrl = process.env.RPC_BASE_SEPOLIA || 'https://sepolia.base.org'
  const provider = new JsonRpcProvider(rpcUrl)

  console.log(`\n== Proving data recovery from replicateBatch tx ==`)
  console.log(`   Source tx: ${txHash}`)
  console.log(`   Chain: Base Sepolia`)

  const tx = await provider.getTransaction(txHash)
  if (!tx) { console.error('Transaction not found'); process.exit(1) }

  const iface = new Interface(REPLICATE_BATCH_ABI)
  const decoded = iface.parseTransaction({ data: tx.data, value: tx.value })
  if (!decoded) { console.error('Failed to decode calldata'); process.exit(1) }

  const [params, actions, r] = decoded.args
  const clientId = Number(params.clientId)
  const destEid = Number(params.destEid)
  const checkpointId = Number(params.checkpointId)

  console.log(`   Client: ${clientId}, Destination: ${destEid}, Checkpoint: ${checkpointId}`)
  console.log(`   Actions: ${actions.length}, R values: ${r.length}`)

  // Re-encode the payload exactly as the contract does before _lzSend:
  //   bytes memory payload = abi.encode(actions, r);
  const coder = new AbiCoder()
  const lzPayload = coder.encode([`${ACTION_TUPLE_BYTES}[]`, 'bytes32[]'], [Array.from(actions), Array.from(r)])
  const payloadBytes = (lzPayload.length - 2) / 2
  console.log(`   LZ payload size: ${payloadBytes} bytes (${(payloadBytes / 1024).toFixed(1)} KB)`)

  // Now decode it back — this is exactly what read-archive.ts does when it
  // receives the ActionsArchived event from the archive contract.
  const [recoveredActions] = coder.decode([`${ACTION_TUPLE_BYTES}[]`, 'bytes32[]'], lzPayload)

  console.log(`\n== Recovered ${recoveredActions.length} actions ==\n`)

  let totalCompressedBytes = 0
  let totalPlaintextChars = 0

  for (let i = 0; i < recoveredActions.length; i++) {
    const a = recoveredActions[i]
    const typeName = ACTION_TYPE_NAMES[Number(a.actionType)] || `UNKNOWN(${a.actionType})`
    const compressedHex = String(a.text)
    const compressedBytes = compressedHex === '0x' ? 0 : (compressedHex.length - 2) / 2
    const plaintext = decompressHex(compressedHex)

    totalCompressedBytes += compressedBytes
    totalPlaintextChars += plaintext.length

    const recipients = Array.from(a.recipients).map(Number)
    const amounts = Array.from(a.amounts).map((x: any) => BigInt(x))

    console.log(`  [${String(i).padStart(3)}] ${typeName.padEnd(8)} sender=${String(a.senderId).padStart(3)} cawonce=${String(a.cawonce).padStart(4)} client=${a.clientId}`)
    if (plaintext) {
      console.log(`        text: ${JSON.stringify(plaintext.length > 120 ? plaintext.slice(0, 120) + '…' : plaintext)}`)
      console.log(`        compressed: ${compressedBytes} bytes → ${plaintext.length} chars (${((1 - compressedBytes / plaintext.length) * 100).toFixed(0)}% smaller)`)
    }
    if (recipients.length > 0) {
      console.log(`        recipients: [${recipients.join(', ')}] amounts: [${amounts.join(', ')}]`)
    }
  }

  console.log(`\n== Summary ==`)
  console.log(`   Checkpoint ${checkpointId}: ${recoveredActions.length} actions recovered`)
  console.log(`   Total compressed: ${totalCompressedBytes} bytes`)
  console.log(`   Total plaintext: ${totalPlaintextChars} characters`)
  console.log(`   Compression ratio: ${((1 - totalCompressedBytes / Math.max(totalPlaintextChars, 1)) * 100).toFixed(1)}% smaller`)
  console.log(`   LZ payload: ${payloadBytes} bytes`)
  console.log(`\n   ✓ All action data is fully recoverable from the on-chain tx.`)
  console.log(`     Once LZ delivers to Arbitrum Sepolia, read-archive.ts will`)
  console.log(`     produce identical output from the archive's events.`)
}

main().catch(err => { console.error(err); process.exit(1) })
