// Tests for indexCawById: the post-commit step that puts a Caw row written
// by the indexer into the search index (I32: new posts never reached ES
// until the next restart's syncAllData).

import { expect } from 'chai'
import { indexCawById, type IndexCawDeps } from '../../src/utils/indexCawById'

function makeDeps(opts: { available?: boolean; row?: any; findThrows?: boolean; indexThrows?: boolean } = {}) {
  const found: number[] = []
  const indexed: any[] = []
  const deps: IndexCawDeps = {
    isAvailable: () => opts.available ?? true,
    findCaw: async (id) => {
      found.push(id)
      if (opts.findThrows) throw new Error('db down')
      return opts.row === undefined ? { id, content: 'hello', user: { username: 'a' } } : opts.row
    },
    indexCaw: async (caw) => {
      if (opts.indexThrows) throw new Error('es down')
      indexed.push(caw)
    },
  }
  return { deps, found, indexed }
}

describe('indexCawById', () => {
  it('re-reads the row and indexes it', async () => {
    const { deps, found, indexed } = makeDeps()
    await indexCawById(7, deps)
    expect(found).to.deep.equal([7])
    expect(indexed).to.have.length(1)
    expect(indexed[0].id).to.equal(7)
  })

  it('does nothing when the row is not visible', async () => {
    const { deps, indexed } = makeDeps({ row: null })
    await indexCawById(7, deps)
    expect(indexed).to.have.length(0)
  })

  it('does not read the row when ES is unavailable', async () => {
    const { deps, found, indexed } = makeDeps({ available: false })
    await indexCawById(7, deps)
    expect(found).to.have.length(0)
    expect(indexed).to.have.length(0)
  })

  it('never throws on a read or index failure', async () => {
    const quiet = console.error
    console.error = () => {}
    try {
      await indexCawById(7, makeDeps({ findThrows: true }).deps)
      await indexCawById(7, makeDeps({ indexThrows: true }).deps)
    } finally {
      console.error = quiet
    }
  })
})
