import { expect } from 'chai'
import { CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS } from '../../src/abi/addresses'
import { backlogContractAddresses, backlogWhere, setContractAddresses } from '../../src/services/ActionProcessor/backlogQuery'

type Row = { id: number; contractAddress: string }

// Applies the part of Prisma's where clause that backlogWhere produces.
function select(rows: Row[], where: { id: { gt: number }; contractAddress: { in: string[] } }): Row[] {
  return rows
    .filter(r => r.id > where.id.gt && where.contractAddress.in.includes(r.contractAddress))
    .sort((a, b) => a.id - b.id)
}

const ROWS: Row[] = [
  { id: 1, contractAddress: CAW_ACTIONS_ADDRESS },
  { id: 2, contractAddress: CAW_ACTIONS_ERC1271_ADDRESS },
  { id: 3, contractAddress: CAW_ACTIONS_ADDRESS },
]

describe('ActionProcessor backlog query', () => {
  it('covers CawActions and its ERC-1271 sibling', () => {
    expect(backlogContractAddresses()).to.have.members([CAW_ACTIONS_ADDRESS, CAW_ACTIONS_ERC1271_ADDRESS])
  })

  it('replays ERC-1271 rows in id order together with CawActions rows', () => {
    expect(select(ROWS, backlogWhere(0)).map(r => r.id)).to.deep.equal([1, 2, 3])
  })

  it('returns only rows after the cursor', () => {
    expect(select(ROWS, backlogWhere(2)).map(r => r.id)).to.deep.equal([3])
  })

  it('reads only CawActions when the ERC-1271 address is not set', () => {
    const addresses = setContractAddresses([CAW_ACTIONS_ADDRESS, undefined])
    expect(addresses).to.deep.equal([CAW_ACTIONS_ADDRESS])
    expect(select(ROWS, { id: { gt: 0 }, contractAddress: { in: addresses } }).map(r => r.id)).to.deep.equal([1, 3])
  })
})
