// Standalone verification of the OfferAccepted seller/buyer notification
// logic added to MarketplaceIndexerService (SALE_SOLD / SALE_BOUGHT).
// Simulates the idempotency guard and payload construction without a DB.
// Run: node scripts/verify-offer-accepted-notifications.js

function buildNotificationPlan(event, existingNotifications) {
  // existingNotifications: array of { type, userId, groupKey } already "in the DB"
  const onChainOfferId = event.offerId
  const sellerUser = event.sellerUser
  const buyerUser = event.buyerUser

  const payload = {
    offerId: onChainOfferId,
    username: event.username,
    tokenId: event.tokenId,
    price: event.price,
    paymentToken: event.paymentTokenLabel,
  }

  const sellerGroupKey = `offer_accepted_sold_${onChainOfferId}`
  const buyerGroupKey = `offer_accepted_bought_${onChainOfferId}`

  const toCreate = []

  const exists = (type, userId, groupKey) =>
    existingNotifications.some(n => n.type === type && n.userId === userId && n.groupKey === groupKey)

  if (sellerUser && !exists('SALE_SOLD', sellerUser.tokenId, sellerGroupKey)) {
    toCreate.push({ userId: sellerUser.tokenId, actorId: buyerUser?.tokenId ?? sellerUser.tokenId, type: 'SALE_SOLD', groupKey: sellerGroupKey, actionPayload: payload })
  }
  if (buyerUser && !exists('SALE_BOUGHT', buyerUser.tokenId, buyerGroupKey)) {
    toCreate.push({ userId: buyerUser.tokenId, actorId: sellerUser?.tokenId ?? buyerUser.tokenId, type: 'SALE_BOUGHT', groupKey: buyerGroupKey, actionPayload: payload })
  }
  return toCreate
}

let failures = 0
function check(label, actualLen, expectedLen) {
  const pass = actualLen === expectedLen
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label} -> created ${actualLen}, expected ${expectedLen}`)
}

const baseEvent = {
  offerId: 42,
  tokenId: 7,
  username: 'alice',
  price: '1000000',
  paymentTokenLabel: 'USDC',
  sellerUser: { tokenId: 7 },
  buyerUser: { tokenId: 9 },
}

// 1) Fresh event, no prior notifications — must create exactly 2 (seller + buyer)
check('fresh OfferAccepted event -> 2 notifications', buildNotificationPlan(baseEvent, []).length, 2)

// 2) Re-processed event (e.g. DB rebuild rescans same block) — must create 0 (idempotent)
const already = [
  { type: 'SALE_SOLD', userId: 7, groupKey: 'offer_accepted_sold_42' },
  { type: 'SALE_BOUGHT', userId: 9, groupKey: 'offer_accepted_bought_42' },
]
check('re-processed event -> 0 notifications (idempotent)', buildNotificationPlan(baseEvent, already).length, 0)

// 3) Only seller has a User row (buyer unregistered on this mirror) — must create 1
const sellerOnly = { ...baseEvent, buyerUser: null }
check('buyer has no User row -> 1 notification (seller only)', buildNotificationPlan(sellerOnly, []).length, 1)

// 4) Wash sale: seller === buyer (same tokenId) — must still create both rows (distinct groupKeys)
const washSale = { ...baseEvent, buyerUser: { tokenId: 7 } }
check('wash sale (seller===buyer) -> 2 notifications (distinct groupKeys)', buildNotificationPlan(washSale, []).length, 2)

// 5) Different offerId -> distinct groupKey, must NOT be deduped by offer 42's history
const otherOffer = { ...baseEvent, offerId: 99 }
check('different offerId -> 2 notifications (not deduped against offer 42)', buildNotificationPlan(otherOffer, already).length, 2)

console.log(`\n${5 - failures}/5 passed`)
process.exit(failures > 0 ? 1 : 0)
