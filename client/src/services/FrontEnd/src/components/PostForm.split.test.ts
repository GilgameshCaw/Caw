import { describe, it, expect } from 'vitest'
import { findSplitPoint } from './PostForm'

const bytes = (s: string) => new TextEncoder().encode(s).length
const LIMIT = 420

describe('findSplitPoint', () => {
  it('returns the whole length when the text fits', () => {
    expect(findSplitPoint('短い投稿', LIMIT)).toBe(4)
  })

  it('English text still splits at the last space before the limit', () => {
    const text = 'word '.repeat(100)
    const at = findSplitPoint(text, LIMIT)
    expect(at).toBe(419)
    expect(text[at]).toBe(' ')
  })

  it('Japanese text with one early space splits after the last 。 or 、 instead of at that space', () => {
    const text =
      '5つのPRがlabノードに取り込まれました。\n\n' +
      '#140（upstream #375）バリデータ：RPC が 5xx や 429 を返したときに、一時的なエラーとして扱うようにした。行動が失敗扱いにならず、再試行される。\n' +
      '#141（upstream #398）最初の投稿のときのサインイン：期限切れの入金の目印（ヒント）を置き換えるようにした。これで、再試行する行動に認証の取引が付くようになる。'
    const at = findSplitPoint(text, LIMIT)
    expect(bytes(text.slice(0, at))).toBeLessThanOrEqual(LIMIT)
    expect(text.slice(0, at).endsWith('これで、')).toBe(true)
    // the space in "upstream #398" is no longer chosen
    expect(at).toBeGreaterThan(text.indexOf('upstream #398') + 'upstream'.length)
  })

  it('a newline later than the last space is used, and is left out of the chunk', () => {
    const text = 'a b\n' + 'あ'.repeat(200)
    const at = findSplitPoint(text, 12)
    expect(at).toBe(3)
    expect(text[at]).toBe('\n')
  })

  it('falls back to the byte limit when there is no space, newline or mark', () => {
    const text = 'あ'.repeat(200)
    const at = findSplitPoint(text, LIMIT)
    expect(at).toBe(140)
    expect(bytes(text.slice(0, at))).toBe(420)
  })

  it('never splits inside a surrogate pair', () => {
    const text = '😀'.repeat(200)
    const at = findSplitPoint(text, LIMIT)
    expect(at % 2).toBe(0)
    expect(bytes(text.slice(0, at))).toBe(420)
  })
})
