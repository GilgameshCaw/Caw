/**
 * extractMentions must recognise the same mention sigils the feed renders
 * as links (tools/hashtagRegex MENTION_SIGIL_CLASS: ASCII @ and fullwidth ＠),
 * while keeping the ASCII handle body so a trailing honorific or other
 * non-ASCII text after the handle doesn't swallow it.
 */

import { expect } from 'chai'
import { NotificationService } from '../../../src/services/NotificationService'

describe('NotificationService.extractMentions', () => {
  it('picks up an ASCII @ mention', () => {
    expect(NotificationService.extractMentions('hi @alice')).to.deep.equal(['alice'])
  })

  it('picks up a fullwidth ＠ mention (CJK keyboards)', () => {
    expect(NotificationService.extractMentions('hi ＠alice')).to.deep.equal(['alice'])
  })

  it('stops the handle at non-ASCII text after it', () => {
    expect(NotificationService.extractMentions('@aliceさん ＠bobさん')).to.deep.equal(['alice', 'bob'])
  })

  it('dedupes the same handle written with either sigil', () => {
    expect(NotificationService.extractMentions('@alice ＠alice')).to.deep.equal(['alice'])
  })

  it('still caps at MAX_MENTIONS_PER_CAW across both sigils', () => {
    const text = Array.from({ length: 12 }, (_, i) => `${i % 2 ? '＠' : '@'}u${i}`).join(' ')
    expect(NotificationService.extractMentions(text)).to.have.length(NotificationService.MAX_MENTIONS_PER_CAW)
  })
})
