import { describe, it, expect, vi } from 'vitest'

// translate.ts imports the API client, which pulls in the wallet setup. The
// guess does not call it.
vi.mock('~/api/client', () => ({ apiFetch: async () => { throw new Error('not used') } }))

import { guessPostLanguage } from './postLanguageGuess'

const ENGLISH = 'Gilgamesh leaves his homeland (Uruk) at one point during the story. Reason for leaving: struck by the fear that he too will die one day after witnessing the death of his close friend Enkidu, he sets out on a journey to seek the secret of immortality.'

describe('guessPostLanguage', () => {
  it('an English paragraph that starts with three katakana is not Japanese', () => {
    expect(guessPostLanguage('(1/3) テスト\n\n' + ENGLISH)).toBeNull()
  })

  it('an English post with a few Chinese characters is not Chinese', () => {
    expect(guessPostLanguage('Good morning everyone 早安啊')).toBeNull()
  })

  it('an English post with a Russian word or two is not Russian', () => {
    expect(guessPostLanguage('Good morning everyone, have a nice day. Привет')).toBeNull()
  })

  it('a post in Japanese stays Japanese', () => {
    expect(guessPostLanguage('今日はいい天気ですね')).toBe('ja')
  })

  it('a post in Chinese stays Chinese', () => {
    expect(guessPostLanguage('今天行情不错，大家早安')).toBe('zh')
  })

  it('Korean, Russian, Hebrew, Arabic, Hindi and Thai posts keep their guess', () => {
    expect(guessPostLanguage('오늘 날씨가 좋네요')).toBe('ko')
    expect(guessPostLanguage('Сегодня хорошая погода')).toBe('ru')
    expect(guessPostLanguage('היום מזג האוויר יפה')).toBe('he')
    expect(guessPostLanguage('الطقس جميل اليوم')).toBe('ar')
    expect(guessPostLanguage('आज मौसम अच्छा है')).toBe('hi')
    expect(guessPostLanguage('วันนี้อากาศดี')).toBe('th')
  })

  it('Latin-script tokens in a post that is mostly in another script do not change the guess', () => {
    expect(guessPostLanguage('gm gm 币圈早安，今天行情不错')).toBe('zh')
    expect(guessPostLanguage('ビットコインが上昇しました。BTC は強い')).toBe('ja')
  })

  it('links, @mentions, #hashtags and $cashtags are not counted', () => {
    expect(guessPostLanguage('おはよう #gm #crypto')).toBe('ja')
    expect(guessPostLanguage('おはよう @someone_long_username $CAW https://example.com/a/very/long/path')).toBe('ja')
    // the same words are counted when they are part of the text
    expect(guessPostLanguage('おはよう someone long username')).toBeNull()
  })

  it('text that follows a link with no space is part of the post', () => {
    expect(guessPostLanguage('Bitcoin https://example.com/abcを見てください')).toBe('ja')
    expect(guessPostLanguage('Bitcoin www.example.com/abcを見てください')).toBe('ja')
    expect(guessPostLanguage('Bitcoin ETF 今日の記事 https://example.com/abc。続きはこちら')).toBe('ja')
  })

  it('a hashtag written in the post\'s own script is counted with it', () => {
    expect(guessPostLanguage('おはよう #日本語')).toBe('ja')
  })

  it('accented Latin letters count as Latin', () => {
    expect(guessPostLanguage('Bonjour à tous, très belle journée 早安啊')).toBeNull()
  })

  it('an even split keeps the guess', () => {
    expect(guessPostLanguage('早安啊 abc')).toBe('zh')
  })

  it('nothing to guess from gives null', () => {
    expect(guessPostLanguage('')).toBeNull()
    expect(guessPostLanguage('gm everyone')).toBeNull()
    expect(guessPostLanguage('1234 !!! 🙂')).toBeNull()
  })
})
