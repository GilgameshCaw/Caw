import { JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import { cawProfileLedgerAbi } from '../../abi/generated'

// Lazy-initialised singleton, mirroring DataCleaner's getCawProfileLedger().
// Two read-only providers in the same process is fine — no shared state.
// Kept separate from DataCleaner so a refactor over there can't yank the
// snapshotter's underfoot.
//
// Note: addresses is imported lazily (inside the function) so that test
// environments without a local addresses.ts can still import this module
// when the real singleton is never constructed (i.e. when
// _setContractForTests() is used).
let _provider: JsonRpcProvider | WebSocketProvider | null = null
let _contract: Contract | null = null

export function getCawProfileLedger(): Contract {
  if (_contract) return _contract
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CAW_NAMES_L2_ADDRESS } = require('../../abi/addresses') as { CAW_NAMES_L2_ADDRESS: string }
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('[StakeLedger] L2 RPC not configured')
  _provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _contract = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileLedgerAbi as any, _provider)
  return _contract
}
