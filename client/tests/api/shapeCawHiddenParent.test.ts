/**
 * A HIDDEN caw answers 410 on GET /api/caws/:id, without its body. The same
 * row embedded as another caw's parent (reply, quote, plain recaw) went out
 * through shapeCaw with content, imageData and poll intact, on every route
 * that uses getCawIncludeConfig (feeds, /by-ids, the post page and its
 * comments, bookmarks, hashtags).
 *
 * shapeCaw is pure, so this runs without a database.
 */

import { describe, it } from 'mocha'
import { expect } from 'chai'
import { shapeCaw, withoutHiddenBody } from '../../src/api/shared/cawUtils'

const author = { id: 1, tokenId: 1, username: 'alice' }
const replier = { id: 2, tokenId: 2, username: 'bob' }

function parentRow(status: 'SUCCESS' | 'HIDDEN') {
  return {
    id: 100,
    content: 'the parent body https://example.test/uploads/images/a1b2c3d4.webp #tag',
    action: 'CAW',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    user: author,
    userId: 1,
    status,
    cawonce: 5,
    likeCount: 3,
    recawCount: 1,
    commentCount: 2,
    imageData: 'https://example.test/uploads/images/a1b2c3d4.webp',
    hasImage: true,
    videoData: 'https://example.test/uploads/videos/v1.mp4',
    hasVideo: true,
    sourceLanguage: 'en',
    hashtags: [{ hashtag: { name: 'tag' } }],
    poll: { id: 9, options: ['yes', 'no'], optionImages: [], totalVotes: 4, endsAt: null, multiSelect: false },
  }
}

function childRow(action: 'CAW' | 'RECAW', content: string, status: 'SUCCESS' | 'HIDDEN') {
  return {
    id: 200,
    content,
    action,
    createdAt: new Date('2026-10-02T00:00:00Z'),
    user: replier,
    userId: 2,
    status: 'SUCCESS',
    cawonce: 9,
    likeCount: 0,
    recawCount: 0,
    commentCount: 0,
    parent: parentRow(status),
  }
}

const CASES = [
  { name: 'reply', action: 'CAW' as const, content: 'my reply' },
  { name: 'quote', action: 'RECAW' as const, content: 'my take' },
  { name: 'plain recaw', action: 'RECAW' as const, content: '' },
]

describe('shapeCaw with a HIDDEN parent', () => {
  for (const c of CASES) {
    it(`${c.name}: keeps id, author and status, drops the body`, () => {
      const shaped = shapeCaw(childRow(c.action, c.content, 'HIDDEN'))
      for (const p of [shaped.parent!, shaped.originalCaw!]) {
        expect(p.id).to.equal('100')
        expect(p.user.username).to.equal('alice')
        expect(p.status).to.equal('HIDDEN')
        expect(p.content).to.equal('')
        expect(p.imageData).to.equal(null)
        expect(p.hasImage).to.equal(false)
        expect(p.poll).to.equal(undefined)
        expect(p.hashtags).to.deep.equal([])
        expect(p.sourceLanguage).to.equal(null)
        // shapeCaw doesn't pass videoData through today (#152 would); either way none may leave.
        expect((p as any).videoData ?? null).to.equal(null)
      }
      expect(shaped.content).to.equal(c.content)
    })
  }

  it('control: a SUCCESS parent is embedded whole', () => {
    const shaped = shapeCaw(childRow('CAW', 'my reply', 'SUCCESS'))
    expect(shaped.parent!.content).to.equal(parentRow('SUCCESS').content)
    expect(shaped.parent!.imageData).to.equal(parentRow('SUCCESS').imageData)
    expect(shaped.parent!.poll?.options).to.deep.equal(['yes', 'no'])
    expect(shaped.parent!.hashtags).to.deep.equal(['tag'])
  })

  it('withoutHiddenBody leaves its input untouched', () => {
    const row = parentRow('HIDDEN')
    const before = JSON.stringify(row)
    withoutHiddenBody(row)
    expect(JSON.stringify(row)).to.equal(before)
  })
})
