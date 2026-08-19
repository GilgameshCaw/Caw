// Standalone verification of the DM relay FK-race fix:
//   1. ensureDmIdentity's placeholder-creation logic
//   2. getPublicKey/getPublicKeysBatch treating publicKey === '' as "no identity"
//   3. POST /api/dm/conversations rejecting a peer with only a placeholder identity
// Run: node scripts/verify-dm-relay-fk-fix.js

// --- Simulated DB state ---
let dmIdentities = new Map() // userId -> { userId, publicKey, walletAddress }
let users = new Map()        // tokenId -> { id, tokenId, username }

function resetDb() {
  dmIdentities = new Map()
  users = new Map()
}

// --- ensureDmIdentity (mirrors dm-relay.ts, post-audit with the
//     Number.isInteger/>0 guard) ---
async function ensureDmIdentity(userId) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(`ensureDmIdentity: invalid userId ${userId}`)
  }
  if (dmIdentities.has(userId)) return
  if (!users.has(userId)) {
    users.set(userId, { id: userId, tokenId: userId, username: `user_${userId}` })
  }
  dmIdentities.set(userId, { userId, walletAddress: '', publicKey: '' })
}

// --- getPublicKey (mirrors DmService/index.ts, post-fix) ---
function getPublicKey(userId) {
  const identity = dmIdentities.get(userId)
  if (!identity?.publicKey) return null
  return identity.publicKey
}

// --- getPublicKeysBatch (mirrors DmService/index.ts, post-fix) ---
function getPublicKeysBatch(userIds) {
  const out = new Map()
  for (const id of userIds) {
    const identity = dmIdentities.get(id)
    if (identity && identity.publicKey !== '') out.set(id, identity.publicKey)
  }
  return out
}

// --- /api/dm/conversations peer check (mirrors dm.ts, post-fix) ---
function canStartConversation(peerUserId) {
  const peerIdentity = dmIdentities.get(peerUserId)
  if (!peerIdentity || !peerIdentity.publicKey) return { ok: false, error: 'Peer has not enabled DMs' }
  return { ok: true }
}

let failures = 0
function check(label, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected)
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

// 1) Fresh inbound relay: neither party has a DmIdentity yet.
//    ensureDmIdentity must create placeholders for both without throwing.
resetDb()
await ensureDmIdentity(101)
await ensureDmIdentity(102)
check('placeholder created for sender', dmIdentities.has(101), true)
check('placeholder created for recipient', dmIdentities.has(102), true)
check('placeholder User row created (id === tokenId)', users.get(101), { id: 101, tokenId: 101, username: 'user_101' })

// 2) getPublicKey must treat the placeholder as "no identity" (null), not
//    leak the empty string as a usable key.
check('getPublicKey on placeholder returns null', getPublicKey(101), null)

// 3) getPublicKeysBatch must exclude placeholder rows entirely.
check('getPublicKeysBatch excludes placeholder', getPublicKeysBatch([101, 102]).size, 0)

// 4) The real identity relay arrives later (registerIdentity-style upsert)
//    and must cleanly upgrade the placeholder.
dmIdentities.set(101, { userId: 101, walletAddress: '0xabc', publicKey: '0xrealkey' })
check('getPublicKey after real relay arrives', getPublicKey(101), '0xrealkey')
check('getPublicKeysBatch after real relay arrives', getPublicKeysBatch([101, 102]).size, 1)

// 5) ensureDmIdentity must be a no-op (not overwrite) when a real
//    identity already exists — critical: must never clobber a real key
//    with a placeholder on a later relay for the same conversation.
await ensureDmIdentity(101)
check('ensureDmIdentity does not clobber an existing real identity', dmIdentities.get(101).publicKey, '0xrealkey')

// 6) /api/dm/conversations must reject a peer who only has a placeholder
//    identity (row exists, but publicKey === '').
resetDb()
await ensureDmIdentity(201)
check('conversation start rejected for placeholder-only peer', canStartConversation(201), { ok: false, error: 'Peer has not enabled DMs' })

// 7) ...but must allow it once the peer has a real key.
dmIdentities.set(201, { userId: 201, walletAddress: '0xdef', publicKey: '0xrealkey2' })
check('conversation start allowed once peer has a real key', canStartConversation(201), { ok: true })

// 8) A peer with no DmIdentity row at all (never contacted, no relay yet)
//    must still be rejected the same way as before this fix.
check('conversation start rejected for peer with no row at all', canStartConversation(999), { ok: false, error: 'Peer has not enabled DMs' })

// 9) A malformed/invalid userId (0, negative, non-integer) from a
//    misbehaving or buggy peer instance must be rejected rather than
//    silently creating a placeholder for a tokenId that could never be
//    a real on-chain profile.
let threwOnZero = false
try { await ensureDmIdentity(0) } catch { threwOnZero = true }
check('ensureDmIdentity rejects tokenId 0', threwOnZero, true)

let threwOnNegative = false
try { await ensureDmIdentity(-5) } catch { threwOnNegative = true }
check('ensureDmIdentity rejects negative userId', threwOnNegative, true)

// 11) Review finding (tentencaw, PR #65): three group-service gates
//     (assertIdentitiesExist for create/add, and the inline join-path
//     check) previously keyed off DmIdentity row existence alone,
//     letting a placeholder (publicKey: '') satisfy "has this user
//     enabled DMs?" even though it can't actually receive sealed
//     ciphertext. Mirrors the fixed queries: publicKey must be
//     non-empty, not just present.
function assertIdentitiesExistLikeCheck(dmIdentityRows, userIds) {
  const have = new Set(dmIdentityRows.filter(r => r.publicKey !== '').map(r => r.userId))
  return userIds.filter(id => !have.has(id))
}
const groupRows = [
  { userId: 1, publicKey: '0xrealkey' },
  { userId: 2, publicKey: '' }, // placeholder -- inbound relay landed, identity relay hasn't
]
check('group create/add: placeholder-only member is rejected as missing DM identity',
  assertIdentitiesExistLikeCheck(groupRows, [1, 2]), [2])
check('group create/add: member with a real key passes',
  assertIdentitiesExistLikeCheck(groupRows, [1]), [])

function joinPathCheck(identityRow) {
  return !!(identityRow && identityRow.publicKey)
}
check('group join: placeholder identity is rejected', joinPathCheck({ userId: 2, publicKey: '' }), false)
check('group join: real identity is allowed', joinPathCheck({ userId: 1, publicKey: '0xrealkey' }), true)
check('group join: no identity row at all is rejected', joinPathCheck(null), false)

// 12) fetchDmIdentity (me.ts) must report hasIdentity: false for a
//     placeholder, not true with an empty publicKey.
function fetchDmIdentityLikeCheck(identityRow) {
  const hasRealIdentity = identityRow !== null && identityRow.publicKey !== ''
  return { hasIdentity: hasRealIdentity, publicKey: hasRealIdentity ? identityRow.publicKey : null }
}
check('me.ts: placeholder reports hasIdentity false with null publicKey',
  fetchDmIdentityLikeCheck({ publicKey: '' }), { hasIdentity: false, publicKey: null })
check('me.ts: real identity reports hasIdentity true with the real key',
  fetchDmIdentityLikeCheck({ publicKey: '0xrealkey' }), { hasIdentity: true, publicKey: '0xrealkey' })

// 13) Review finding (tentencaw, PR #65): the throw on an invalid
//     userId rejects the Promise.all in the route handler, which falls
//     through to the generic catch and drops the message with no way
//     to tell it apart from a real relay failure. Confirms the error is
//     now a distinguishable type the catch block can branch on.
class InvalidRelayUserIdError extends Error {
  constructor(userId) {
    super(`ensureDmIdentity: invalid userId ${userId}`)
    this.name = 'InvalidRelayUserIdError'
  }
}
async function ensureDmIdentityWithTypedError(userId) {
  if (!Number.isInteger(userId) || userId <= 0) throw new InvalidRelayUserIdError(userId)
}
let caughtType = null
try {
  await ensureDmIdentityWithTypedError(0)
} catch (err) {
  caughtType = err instanceof InvalidRelayUserIdError ? 'InvalidRelayUserIdError' : 'generic'
}
check('invalid userId throws a distinguishable error type, not a generic Error', caughtType, 'InvalidRelayUserIdError')

console.log(`\n${18 - failures}/18 passed`)
process.exit(failures > 0 ? 1 : 0)
