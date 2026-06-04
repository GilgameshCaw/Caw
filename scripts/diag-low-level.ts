/* eslint-disable */
// Diagnostic: replay TxQueue rows 1..3 as 1-action safeProcessActions eth_calls
// against the live L2 contract. Prints the raw revert bytes / decoded selector
// so we can pinpoint the custom error firing.
//
// Usage:
//   psql -At -F'|' -c "select id, payload::text, \"signedTx\" from \"TxQueue\" where id in (1,2,3)" > /tmp/diag-rows.txt
//   source solidity/.env
//   npx ts-node --transpile-only --compiler-options '{"module":"CommonJS","moduleResolution":"Node"}' scripts/diag-low-level.ts
import 'dotenv/config'
import { readFileSync } from 'fs'
import { Interface, JsonRpcProvider } from 'ethers'
import { packActions, packGroupedSignatures, bytesToHex } from '../client/src/utils/packActions'

const CAW_ACTIONS = '0x7787102b45eA7ace5090Ed006cE1d9E73843a4CF'
const L2_RPC = process.env.L2_RPC_URL || ''

// Deployed contract still returns string[]. New source returns bytes[]. Use
// string[] here so the decode works against the live deployment.
const IFACE = new Interface([
  'function safeProcessActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable returns (uint256 successCount, string[] rejections)',
])

const CAW_ACTIONS_ERRORS: Record<string, string> = {
  '0x57781b8d': 'NotSibling',
  '0x14d4a4e8': 'OnlySelf',
  '0x07c78c5c': 'NotCapOracle',
  '0x6ed22483': 'NoActions',
  '0x11c763d6': 'TooManyActions',
  '0x3500a0ed': 'BadSigGroupCount',
  '0x51bab0cd': 'SigsIncomplete',
  '0x1054cca6': 'TrailingBytes',
  '0xc4871362': 'EmptyGroup',
  '0x409c80b1': 'GroupOverflows',
  '0xbca9544d': 'MixedNetworks',
  '0xa61eea9e': 'ZkNotConfigured',
  '0x28d5f1f4': 'ZkSignersMismatch',
  '0x77703d13': 'CawonceUsed',
  '0x3e330792': 'UserNotAuth',
  '0xd88051b5': 'TextTooLong',
  '0x734a00c1': 'NoWithdrawFee',
  '0x10c74b03': 'SignerMismatch',
  '0x1fd05a4a': 'SessionInvalid',
  '0x79258622': 'MixedSenders',
  '0x5c43e582': 'NonContiguousCawonces',
  '0x5fe11762': 'OutOfScope',
  '0x773685ef': 'SelfFollow',
  '0xa47c7960': 'SessionLimitExceeded',
  '0x8fb02170': 'UnknownOwner',
  '0x88dd20d4': 'InvalidActionType',
  '0x640b8ab0': 'BatchSigInvalid',
  '0xc90c66b5': 'InvalidSig',
  '0x5531b495': 'TooManyRecipients',
  '0xa58d8412': 'WithdrawZeroAmount',
  '0x682a6e7c': 'InvalidValidator',
  '0x4d94cda0': 'WrongProfileForSession',
  // Profile / Ledger / Minter errors that can bubble via xchain reverts:
  '0xf4d678b8': 'InsufficientBalance',
  '0x82b42900': 'OwnableUnauthorizedAccount',
  '0x08c379a0': 'Error(string)',
}

function name(sel: string): string {
  return CAW_ACTIONS_ERRORS[sel.toLowerCase()] || `Unknown(${sel})`
}

async function main() {
  const raw = readFileSync('/tmp/diag-rows.txt', 'utf8').trim()
  const rows = raw.split('\n').map(line => {
    const [id, payloadJson, signedTx] = line.split('|')
    return { id: parseInt(id), payload: JSON.parse(payloadJson), signedTx }
  })
  const provider = new JsonRpcProvider(L2_RPC)

  for (const row of rows) {
    const action = row.payload.data
    const sig = row.signedTx as string
    console.log(`\n=== TxQueue ${row.id} (actionType=${action.actionType} senderId=${action.senderId} cawonce=${action.cawonce}) ===`)
    console.log(`    signedTx=${sig.slice(0, 20)}…`)
    // Use the validator's own pack helpers so framing matches the real call.
    const packedBytes = packActions([action])
    const packedHex = bytesToHex(packedBytes)
    // Parse 65-byte sig (r,s,v) from signedTx.
    const sigBuf = Buffer.from(sig.replace(/^0x/, ''), 'hex')
    if (sigBuf.length !== 65) {
      console.log(`    BAD SIG length ${sigBuf.length}`)
      continue
    }
    const r = '0x' + sigBuf.subarray(0, 32).toString('hex')
    const s = '0x' + sigBuf.subarray(32, 64).toString('hex')
    const v = sigBuf[64]
    const sigsBytes = packGroupedSignatures([{ groupSize: 1, v, r, s }])
    const sigsHex = bytesToHex(sigsBytes)

    const calldata = IFACE.encodeFunctionData('safeProcessActions', [1, packedHex, sigsHex, 0n, 0n])
    console.log(`    SAFE_CALLDATA=${calldata}`)
    // Tenderly-friendly form: send `processActions` (not safeProcessActions)
    // so the revert lands at the top frame and Tenderly's UI surfaces the
    // selector inline. Same args, different selector.
    const PROCESS_IFACE = new Interface([
      'function processActions(uint32 validatorId, bytes packedActions, bytes sigs, uint256 withdrawFee, uint256 withdrawLzTokenAmount) payable',
    ])
    const processCalldata = PROCESS_IFACE.encodeFunctionData('processActions', [1, packedHex, sigsHex, 0n, 0n])
    console.log(`    PROCESS_CALLDATA=${processCalldata}`)
    try {
      const ret = await provider.call({ to: CAW_ACTIONS, data: calldata, from: '0x0000000000000000000000000000000000000001' })
      const [count, rejections] = IFACE.decodeFunctionResult('safeProcessActions', ret) as any
      console.log(`    successCount=${count}`)
      for (let i = 0; i < rejections.length; i++) {
        const msg = rejections[i] as string
        console.log(`    [${i}] reason: "${msg}"`)
        if (msg === 'Low-level exception') {
          // Probe inner try via debug_traceCall — find the deepest revert frame.
          try {
            const trace: any = await provider.send('debug_traceCall', [
              { to: CAW_ACTIONS, data: calldata, from: '0x0000000000000000000000000000000000000001' },
              'latest',
              { tracer: 'callTracer', tracerConfig: { withLog: false, onlyTopCall: false } },
            ])
            const found: any[] = []
            const walk = (c: any) => {
              if (!c) return
              if (c.error || c.revertReason || c.output) {
                if (c.error || c.revertReason) found.push({ to: c.to, type: c.type, err: c.error, reason: c.revertReason, out: c.output })
              }
              for (const k of (c.calls || [])) walk(k)
            }
            walk(trace)
            const deepest = found[found.length - 1]
            if (deepest) {
              const sel = deepest.out?.slice(0, 10)
              console.log(`        deepest revert: to=${deepest.to} type=${deepest.type} sel=${sel || '?'}  → ${sel ? name(sel) : ''}`)
              console.log(`        raw output=${deepest.out?.slice(0, 130) || ''}…`)
              console.log(`        error=${deepest.err || ''} reason=${deepest.reason || ''}`)
            } else {
              console.log(`        debug_traceCall returned no revert frames`)
            }
          } catch (trErr: any) {
            console.log(`        debug_traceCall unavailable: ${trErr?.shortMessage || trErr?.message?.slice(0, 100)}`)
          }
        }
      }
    } catch (err: any) {
      // Outer safeProcessActions revert (before/around the inner try/catch).
      const data: string | undefined = err?.data || err?.error?.data || err?.info?.error?.data
      if (data && typeof data === 'string' && data.startsWith('0x')) {
        const sel = data.slice(0, 10)
        console.log(`    OUTER REVERT: ${name(sel)} (selector=${sel})`)
        if (data.length > 10) console.log(`      args=0x${data.slice(10)}`)
      } else {
        console.log(`    OUTER REVERT: ${err?.shortMessage || err?.message?.slice(0, 200)}`)
      }
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
