// Which RawEvent rows the ActionProcessor backlog replays on start-up.
//
// RawEventsGatherer stores ActionsProcessed rows from CawActions and, where
// deployed, its ERC-1271 sibling. The backlog has to read the same set.
// Reading only CawActions skips the sibling's rows. Once a later CawActions
// row is processed, the resume cursor (the newest Action's rawEventId) moves
// past them, and they are never replayed.
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../../abi/addresses'

/** The addresses that are set. An unset (undefined or empty) address is dropped. */
export function setContractAddresses(candidates: ReadonlyArray<string | undefined>): string[] {
  return candidates.filter((a): a is string => typeof a === 'string' && a.length > 0)
}

export function backlogContractAddresses(): string[] {
  return setContractAddresses([CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS])
}

/** Where clause for one backlog page: RawEvent rows after the cursor, from any contract in the set. */
export function backlogWhere(lastId: number) {
  return {
    id: { gt: lastId },
    contractAddress: { in: backlogContractAddresses() },
  }
}
