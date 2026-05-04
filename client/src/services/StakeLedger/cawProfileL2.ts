import { JsonRpcProvider, WebSocketProvider, Contract } from 'ethers'
import { makeJsonRpcProvider, makeWebSocketProvider, getL2HttpRpcUrl } from '../../utils/rpcProvider'
import { cawProfileL2Abi } from '../../abi/generated'
import { CAW_NAMES_L2_ADDRESS } from '../../abi/addresses'

// Lazy-initialised singleton, mirroring DataCleaner's getCawProfileL2().
// Two read-only providers in the same process is fine — no shared state.
// Kept separate from DataCleaner so a refactor over there can't yank the
// snapshotter's underfoot.
let _provider: JsonRpcProvider | WebSocketProvider | null = null
let _contract: Contract | null = null

export function getCawProfileL2(): Contract {
  if (_contract) return _contract
  const rpcUrl = getL2HttpRpcUrl()
  if (!rpcUrl) throw new Error('[StakeLedger] L2 RPC not configured')
  _provider = rpcUrl.startsWith('wss://') || rpcUrl.startsWith('ws://')
    ? makeWebSocketProvider(rpcUrl, 84532)
    : makeJsonRpcProvider(rpcUrl, 84532)
  _contract = new Contract(CAW_NAMES_L2_ADDRESS, cawProfileL2Abi as any, _provider)
  return _contract
}
