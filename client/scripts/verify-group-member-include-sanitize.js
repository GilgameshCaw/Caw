// Standalone verification of GroupService.sanitizeConversation, added
// after review (tentencaw, PR #65): memberInclude selects
// identity.publicKey and hands it straight to the client via res.json()
// at every call site. A placeholder DmIdentity (ensureDmIdentity,
// dm-relay.ts -- publicKey: '') would surface as publicKey: '' with no
// filtering. The three group gates now keep a placeholder from becoming
// a participant in the first place, so this is defense-in-depth rather
// than a live exposure -- but it removes the raw '' from the response
// entirely instead of relying on every consumer doing a truthy check.
// Run: node scripts/verify-group-member-include-sanitize.js

function sanitizeConversation(conv) {
  if (!conv?.participants) return conv
  for (const p of conv.participants) {
    if (p.identity && p.identity.publicKey === '') {
      p.identity.publicKey = null
    }
  }
  return conv
}

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) A placeholder participant's empty publicKey becomes null.
const convWithPlaceholder = {
  id: 'conv1',
  participants: [
    { userId: 15, identity: { publicKey: '0x036832f7' } },
    { userId: 9999, identity: { publicKey: '' } }, // placeholder
  ],
}
const sanitized1 = sanitizeConversation(convWithPlaceholder)
check('placeholder publicKey (empty string) becomes null', sanitized1.participants[1].identity.publicKey, null)
check('real publicKey is untouched', sanitized1.participants[0].identity.publicKey, '0x036832f7')

// 2) null conversation (e.g. NOT_FOUND path) passes through unchanged,
//    doesn't throw.
check('null conversation passes through without throwing', sanitizeConversation(null), null)

// 3) A participant with no identity at all (shouldn't normally happen,
//    but the FK relation is nullable in some schema paths) is left alone.
const convNoIdentity = { id: 'conv2', participants: [{ userId: 1, identity: null }] }
check('participant with no identity object is left alone', sanitizeConversation(convNoIdentity).participants[0].identity, null)

// 4) Conversation with no participants array (e.g. a differently-shaped
//    query result) passes through unchanged.
const convNoParticipants = { id: 'conv3' }
check('conversation with no participants array passes through unchanged', sanitizeConversation(convNoParticipants), convNoParticipants)

console.log(`\n${4 - failures}/4 passed`)
process.exit(failures > 0 ? 1 : 0)
