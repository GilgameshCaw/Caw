// Standalone verification of the tokenId>0 gating logic added to
// POST /api/actions (client/src/api/routes/actions.ts).
// This mirrors the exact logic inline (not imported) since the real
// function lives inside an Express route handler. Run: node scripts/verify-token-zero-validation.js

function validate(data) {
  const senderTokenId = Number(data.senderId)
  if (!Number.isInteger(senderTokenId) || senderTokenId <= 0) {
    return { status: 400, error: 'Invalid senderId: tokenId must be a positive integer (> 0)' }
  }

  if (data.receiverId !== undefined && data.receiverId !== null) {
    const receiverTokenId = Number(data.receiverId)
    const targetRequiresReceiver = [1, 2, 3, 4, 5, 'like', 'unlike', 'recaw', 'follow', 'unfollow'].includes(data.actionType)
    if (targetRequiresReceiver && (!Number.isInteger(receiverTokenId) || receiverTokenId <= 0)) {
      return { status: 400, error: 'Invalid receiverId: target tokenId must be a positive integer (> 0)' }
    }
  }

  if (Array.isArray(data.recipients) && data.recipients.length > 0) {
    for (let i = 0; i < data.recipients.length; i++) {
      const recId = Number(data.recipients[i])
      if (!Number.isInteger(recId) || recId <= 0) {
        return { status: 400, error: `Invalid recipient tokenId at index ${i}: must be a positive integer (> 0)` }
      }
    }
  }

  return { status: 'OK' }
}

const cases = [
  // [label, payload, expectedStatus]
  ['senderId = 0', { senderId: 0, actionType: 'like', receiverId: 5 }, 400],
  ['LIKE with receiverId = 0 (string actionType)', { senderId: 3, actionType: 'like', receiverId: 0 }, 400],
  ['LIKE with receiverId = 0 (numeric actionType 1)', { senderId: 3, actionType: 1, receiverId: 0 }, 400],
  ['FOLLOW with receiverId = 0', { senderId: 3, actionType: 'follow', receiverId: 0 }, 400],
  ['recipients contains 0', { senderId: 3, actionType: 'other', receiverId: 0, recipients: [5, 0] }, 400],
  ['recipients contains negative', { senderId: 3, actionType: 'other', receiverId: 0, recipients: [-1] }, 400],
  ['OTHER (pin) with receiverId = 0 — must PASS', { senderId: 3, actionType: 'other', receiverId: 0 }, 'OK'],
  ['RECAW with valid receiverId — must PASS', { senderId: 3, actionType: 'recaw', receiverId: 7 }, 'OK'],
  ['valid LIKE — must PASS', { senderId: 3, actionType: 'like', receiverId: 7 }, 'OK'],
]

let failures = 0
for (const [label, payload, expected] of cases) {
  const result = validate(payload)
  const pass = result.status === expected
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> status=${result.status}${result.error ? ' ('+result.error+')' : ''}`)
}

console.log(`\n${cases.length - failures}/${cases.length} passed`)
process.exit(failures > 0 ? 1 : 0)
