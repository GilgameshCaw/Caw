import { describe, it, expect, vi } from 'vitest'

// translate.ts imports the API client, which pulls in the wallet setup. The
// guess does not call it.
vi.mock('~/api/client', () => ({ apiFetch: async () => { throw new Error('not used') } }))

import { guessPostLanguage } from './postLanguageGuess'

const ENGLISH = 'Gilgamesh leaves his homeland (Uruk) at one point during the story. Reason for leaving: struck by the fear that he too will die one day after witnessing the death of his close friend Enkidu, he sets out on a journey to seek the secret of immortality.'

const JAPANESE = '今日は朝から市場の動きを丁寧に確認して、ビットコインの値動きと取引量の変化について、落ち着いて考えながら記録を残しました。長期の視点で見れば、短い上下に一喜一憂する必要はないと思います。'
const CHINESE = '今天一早就认真看了市场的走势，对比了比特币的价格和成交量的变化，并且把想法记录了下来。从长期来看，没有必要为短期的涨跌而焦虑。'

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

  it('a post in Japanese, Chinese or Korean with many Latin words keeps its guess', () => {
    // Particles and endings are short, so the Latin words have more letters
    // even though the sentence is Japanese.
    expect(guessPostLanguage('GitHub の PR を review して merge しました。CI も green です')).toBe('ja')
    expect(guessPostLanguage('今日の BTC と ETH の price action について')).toBe('ja')
    expect(guessPostLanguage('Base Sepolia の testnet で deploy した contract を verify 中')).toBe('ja')
    expect(guessPostLanguage('今天 market 很好，我买了 some BTC')).toBe('zh')
    expect(guessPostLanguage('오늘 market 이 좋아요 BTC buy')).toBe('ko')
  })

  it('English text with a few words of another script stays unknown, whichever the script', () => {
    // ありがとう (hiragana), ラーメン (katakana), 東京大 (kanji)
    expect(guessPostLanguage(ENGLISH + ' ありがとう ' + ENGLISH)).toBeNull()
    expect(guessPostLanguage(ENGLISH + ' ラーメン ' + ENGLISH)).toBeNull()
    expect(guessPostLanguage(ENGLISH + ' 東京大 ' + ENGLISH)).toBeNull()
    expect(guessPostLanguage('Check out this テスト')).toBeNull()
    expect(guessPostLanguage('I love 寿司 so much')).toBeNull()
  })

  it('a long passage in Japanese or Chinese that ends with English sentences keeps its guess', () => {
    const tail = ' Thanks for reading, see you next week and have a great weekend everyone'
    expect(guessPostLanguage(JAPANESE + tail)).toBe('ja')
    expect(guessPostLanguage(CHINESE + tail)).toBe('zh')
  })

  it('an English post that quotes one long paragraph in Japanese stays unknown', () => {
    expect(guessPostLanguage(ENGLISH + ' ' + ENGLISH + ' ' + JAPANESE)).toBeNull()
  })

  it('a combining mark does not split a word', () => {
    // "re\u0301sume" is one Latin word with a combining accent in the middle.
    // Counted as one word, the post has 4 Latin words and 2 runs of katakana,
    // which keeps the guess; split in two it would have 5 and come out unknown.
    expect(guessPostLanguage('テスト one two three re\u0301sume テスト')).toBe('ja')
  })

  it('nothing to guess from gives null', () => {
    expect(guessPostLanguage('')).toBeNull()
    expect(guessPostLanguage('gm everyone')).toBeNull()
    expect(guessPostLanguage('1234 !!! 🙂')).toBeNull()
  })
})
