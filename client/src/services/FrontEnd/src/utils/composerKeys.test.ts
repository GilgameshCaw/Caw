import { describe, expect, it } from 'vitest'
import { isSendShortcut } from './composerKeys'

const key = (over: Partial<Parameters<typeof isSendShortcut>[0]> = {}) => ({
  key: 'Enter', metaKey: false, ctrlKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, ...over,
})

describe('isSendShortcut', () => {
  it('plain Enter does not send (it inserts a newline)', () => {
    expect(isSendShortcut(key())).toBe(false)
  })
  it('Shift+Enter does not send', () => {
    expect(isSendShortcut({ ...key(), shiftKey: true } as any)).toBe(false)
  })
  it('Ctrl+Enter sends', () => {
    expect(isSendShortcut(key({ ctrlKey: true }))).toBe(true)
  })
  it('Cmd+Enter sends', () => {
    expect(isSendShortcut(key({ metaKey: true }))).toBe(true)
  })
  it('Ctrl+Enter during an IME composition does not send', () => {
    expect(isSendShortcut(key({ ctrlKey: true, nativeEvent: { isComposing: true, keyCode: 13 } }))).toBe(false)
    expect(isSendShortcut(key({ ctrlKey: true, nativeEvent: { isComposing: false, keyCode: 229 } }))).toBe(false)
  })
  it('other keys with Ctrl do not send', () => {
    expect(isSendShortcut(key({ key: 'a', ctrlKey: true }))).toBe(false)
  })
})
