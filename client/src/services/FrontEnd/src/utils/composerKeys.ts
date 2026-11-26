// Keyboard shortcut shared by the message composers.
//
// Enter inserts a newline (the textarea's own behaviour), the same as the post
// composer. Cmd+Enter (Mac) or Ctrl+Enter sends. A key press that is still part
// of an IME composition (e.g. confirming a Japanese conversion) never sends.

interface SendKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

export function isSendShortcut(e: SendKeyEvent): boolean {
  if (e.key !== 'Enter') return false
  // keyCode 229 is what some browsers report for a key handled by the IME.
  if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return false
  return e.metaKey || e.ctrlKey
}
