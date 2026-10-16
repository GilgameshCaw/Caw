import { expect } from 'chai'
import { groupERC1271Rows, estimateERC1271GroupBytes } from '../../src/utils/erc1271Groups'
import { packActions, bytesToHex } from '../../src/utils/packActions'

// CawActionsERC1271.processActionsERC1271 reads packedActions as one
// [uint16 groupSize][actions] segment per signature group. The validator
// packs one uint16 count per tx (packActions), so it submits one group per
// tx. These cover how ERC-1271 txQueue rows are split into those groups.

type Row = { id: number; senderId: number; cawonce: number; batchId: number | null; signedTx: string; payload: any }

const blob = (tag: string) => '0x' + tag.repeat(200) // stand-in for a >65-byte WebAuthn blob

function row(id: number, senderId: number, cawonce: number, batchId: number | null, signedTx: string, text = '0x'): Row {
  return {
    id, senderId, cawonce, batchId, signedTx,
    payload: {
      data: {
        actionType: 0, senderId, receiverId: 0, receiverCawonce: 0,
        networkId: 1, cawonce, recipients: [], amounts: [], text,
      },
    },
  }
}

const ids = (groups: Row[][]) => groups.map(g => g.map(r => r.id))

function pack(rows: Row[]): string {
  return bytesToHex(packActions(rows.map(r => ({
    ...r.payload.data,
    amounts: r.payload.data.amounts.map((x: any) => BigInt(x)),
  }))))
}

// The layout the contract walks: each group's own [uint16 n][actions], back to back.
const contractLayout = (groups: Row[][]) => '0x' + groups.map(g => pack(g).slice(2)).join('')

describe('groupERC1271Rows', () => {
  it('returns no groups for no rows (nothing is submitted)', () => {
    expect(groupERC1271Rows([])).to.deep.equal([])
  })

  it('puts single-signed rows of two senders in separate groups', () => {
    const rows = [row(1, 2, 0, null, blob('aa')), row(2, 3, 0, null, blob('bb'))]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1], [2]])
  })

  it('puts two single-signed rows of one sender in separate groups', () => {
    // Each row carries its own ActionData signature; a group of 2 would be
    // checked against the ActionBatch digest and revert.
    const rows = [row(1, 2, 0, null, blob('aa')), row(2, 2, 1, null, blob('ab'))]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1], [2]])
  })

  it('keeps every row of a batch in one group, in queue order', () => {
    const rows = [row(1, 2, 0, 7, blob('cc')), row(2, 2, 1, 7, blob('cc')), row(3, 2, 2, 7, blob('cc'))]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1, 2, 3]])
  })

  it('keeps a batch whole when another sender\'s row sits between its rows', () => {
    const rows = [
      row(1, 2, 0, 7, blob('cc')),
      row(2, 3, 0, null, blob('bb')),
      row(3, 2, 1, 7, blob('cc')),
      row(4, 3, 1, 9, blob('dd')),
    ]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1, 3], [2], [4]])
  })

  it('keeps two senders\' batches apart when their batchIds match', () => {
    // batchId is Date.now() & 0x7fffffff, so batches created in the same
    // millisecond share it.
    const rows = [
      row(1, 2, 0, 777, blob('cc')),
      row(2, 2, 1, 777, blob('cc')),
      row(3, 3, 0, 777, blob('dd')),
      row(4, 3, 1, 777, blob('dd')),
    ]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1, 2], [3, 4]])
  })

  it('keeps one sender\'s two batches apart when their batchIds match', () => {
    const rows = [
      row(1, 2, 0, 777, blob('cc')),
      row(2, 2, 1, 777, blob('cc')),
      row(3, 2, 2, 777, blob('ce')),
    ]
    expect(ids(groupERC1271Rows(rows))).to.deep.equal([[1, 2], [3]])
  })

  it('every group has one sender and one signature', () => {
    const rows = [
      row(1, 2, 0, null, blob('aa')),
      row(2, 3, 0, 7, blob('cc')),
      row(3, 3, 1, 7, blob('cc')),
      row(4, 2, 1, null, blob('ab')),
    ]
    for (const g of groupERC1271Rows(rows)) {
      expect(new Set(g.map(r => r.senderId)).size).to.equal(1)
      expect(new Set(g.map(r => r.signedTx)).size).to.equal(1)
    }
  })

  it('one group per tx matches the contract layout; one header over two groups does not', () => {
    const rows = [row(1, 2, 0, null, blob('aa')), row(2, 3, 0, null, blob('bb'))]
    const groups = groupERC1271Rows(rows)
    // What the validator sent before: one header (count 2) over both groups.
    expect(pack(rows)).to.not.equal(contractLayout(groups))
    // What it sends now: each tx holds one group, and its single header is that group's size.
    for (const g of groups) {
      expect(pack(g)).to.equal(contractLayout([g]))
      expect(parseInt(pack(g).slice(2, 6), 16)).to.equal(g.length)
    }
  })
})

describe('estimateERC1271GroupBytes', () => {
  it('counts the shared batch blob once', () => {
    const one = estimateERC1271GroupBytes([row(1, 2, 0, 7, blob('cc'))])
    const three = estimateERC1271GroupBytes([1, 2, 3].map(i => row(i, 2, i, 7, blob('cc'))))
    expect(one).to.equal(500 + 25 + 200)
    expect(three).to.equal(500 + 3 * 25 + 200)
  })

  it('counts text, recipients and amounts', () => {
    const r = row(1, 2, 0, null, blob('aa'), '0x' + 'ff'.repeat(10))
    r.payload.data.recipients = [5, 6]
    r.payload.data.amounts = ['1', '2', '3']
    expect(estimateERC1271GroupBytes([r])).to.equal(500 + 25 + 200 + 10 + 2 * 4 + 3 * 8)
  })
})
