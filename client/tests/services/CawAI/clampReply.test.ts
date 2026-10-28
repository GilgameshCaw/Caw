/**
 * CawActions rejects `text` over 420 bytes, counted after smltxt
 * compression. clampReply's character cap (420) let Japanese replies of
 * 200+ characters through; with textLimit.fitsOnChain they must fit the
 * byte limit, and postReply must refuse anything that doesn't.
 */
import { describe, it, afterEach } from 'mocha'
import { expect } from 'chai'
import SmlTxt from 'smltxt'
import { clampReply } from '../../../src/services/CawAI/claude'
import { fitsOnChain, MAX_TEXT_BYTES } from '../../../src/services/CawAI/textLimit'
import { postReply } from '../../../src/services/CawAI/reply'
import type { CawAIConfig } from '../../../src/services/CawAI/config'

const sml = SmlTxt.fromPkg()
const bytes = (s: string) => sml.compress(s).length

// No sentence or clause breaks: the hard-slice branch. 60 characters.
const JA_UNIT = 'オプティミスティックアーカイブはバリデータが提出したチェックポイントを二日間の異議申し立て期間の後に確定させる仕組みです'
const JA_PLAIN = JA_UNIT.repeat(6) // 360 characters: under the character cap
const JA_LONG = JA_UNIT.repeat(8) // 480 characters: over it
// With 。 so the sentence-boundary branch can be taken.
const JA_SENTENCES = 'アーカイブはチェックポイントを確定させます。異議があれば誰でもチャレンジできます。'.repeat(12)

describe('CawAI clampReply: on-chain byte limit', () => {
  it('the character clamp alone leaves Japanese over the limit (the case being fixed)', () => {
    // Under 420 characters, so not cut at all.
    expect(clampReply(JA_PLAIN, 420, '')).to.equal(JA_PLAIN)
    expect(bytes(JA_PLAIN)).to.be.greaterThan(MAX_TEXT_BYTES)
    // Cut to 420 characters, still far over 420 bytes.
    const cut = clampReply(JA_LONG, 420, '')
    expect(cut.length).to.be.at.most(420)
    expect(bytes(cut)).to.be.greaterThan(MAX_TEXT_BYTES)
  })

  for (const [name, text] of [
    ['360 chars, no punctuation', JA_PLAIN],
    ['480 chars, no punctuation', JA_LONG],
    ['with 。', JA_SENTENCES],
  ] as const) {
    it(`Japanese (${name}) is clamped to fit ${MAX_TEXT_BYTES} compressed bytes`, () => {
      const out = clampReply(text, 420, '', fitsOnChain)
      expect(bytes(out)).to.be.at.most(MAX_TEXT_BYTES)
      expect(out.endsWith('…')).to.equal(true)
      // Not cut far shorter than needed: ~199 characters fit (measured).
      expect(out.length).to.be.greaterThan(150)
    })
  }

  it('keeps the marker and still fits', () => {
    const out = clampReply(JA_LONG, 420, ' 🌙', fitsOnChain)
    expect(out.endsWith('… 🌙')).to.equal(true)
    expect(bytes(out)).to.be.at.most(MAX_TEXT_BYTES)
  })

  it('English that already fits is unchanged', () => {
    const en = 'The archive finalizes a submission after the two-day challenge window. '.repeat(8)
    expect(clampReply(en, 420, '', fitsOnChain)).to.equal(clampReply(en, 420, ''))
    expect(bytes(clampReply(en, 420, ''))).to.be.at.most(MAX_TEXT_BYTES)
  })

  it('a short Japanese reply is not cut', () => {
    const short = 'アーカイブは二日後に確定します。'
    expect(clampReply(short, 420, '', fitsOnChain)).to.equal(short)
  })
})

describe('CawAI postReply: refuses text over the byte limit', () => {
  const realFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = realFetch })

  it('throws before any request when the compressed text is over 420 bytes', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error('no network in tests') }) as typeof fetch
    const cfg = {
      maxReplyChars: 420,
      deployerPrivateKey: '0x' + '11'.repeat(32),
      apiUrl: 'http://127.0.0.1:1',
      chainId: 84532,
      cawActionsAddress: '0x' + '00'.repeat(20),
      profileTokenId: 1,
    } as CawAIConfig
    const text = JA_PLAIN.slice(0, 300) // 300 chars: under the char cap, over the byte cap
    expect(text.length).to.be.at.most(cfg.maxReplyChars)
    let err: Error | undefined
    try { await postReply(cfg, { parentCawId: 1, text }) } catch (e) { err = e as Error }
    expect(err?.message).to.match(/bytes compressed/)
    expect(calls).to.equal(0)
  })
})
