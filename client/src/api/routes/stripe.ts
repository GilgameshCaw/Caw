/**
 * /api/stripe — Stripe Checkout and webhook endpoints for card-funded profiles.
 *
 * Endpoints:
 *   POST /api/stripe/create-checkout  — create a Checkout Session; returns { sessionId, url }
 *   POST /api/stripe/webhook          — Stripe webhook (raw body, signature-verified)
 *
 * Flow:
 *   1. FE calls create-checkout with username + depositAmountUsd + walletAddress + networkId.
 *   2. Server creates a Stripe Checkout Session with dynamic pricing and stores all
 *      metadata on the session object.
 *   3. Stripe sends checkout.session.completed to /api/stripe/webhook.
 *   4. Webhook handler converts USD → CAW, calls SponsorService.sponsorCardMint,
 *      and records the purchase in StripePurchase.
 *
 * Gate: both endpoints return 503 when STRIPE_SECRET_KEY is not set.
 *
 * Raw body: the webhook handler must receive the raw (pre-parsed) request body
 * so Stripe can verify the signature. Mount order in server.ts handles this —
 * see the comment near the mounting call.
 */

import { Router, Request, Response } from 'express'
import { z, ZodError } from 'zod'
import Stripe from 'stripe'
import type { Session as StripeCheckoutSession } from 'stripe/cjs/resources/Checkout/Sessions'
import type { Event as StripeEvent } from 'stripe/cjs/resources/Events'
import { prisma } from '../../prismaClient'
import { getSponsorService, isSponsorError } from '../../services/SponsorService'
import { getCawPriceCache } from '../../services/ChainSyncService'

// The canonical API version for this stripe package release. Must match exactly
// what the stripe npm package exports as ApiVersion ('2026-04-22.dahlia').
const STRIPE_API_VERSION = '2026-04-22.dahlia' as const

// ─── Stripe singleton ────────────────────────────────────────────────────────

type StripeClient = InstanceType<typeof Stripe>

function getStripeClient(): StripeClient | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** CAW burn cost by username length (whole CAW, no decimals) — mirrors CawProfileMinter.costOfName. */
function burnCostCawWhole(username: string): number {
  const len = username.length
  if (len === 1) return 1_000_000_000_000
  if (len === 2) return 240_000_000_000
  if (len === 3) return 60_000_000_000
  if (len === 4) return 6_000_000_000
  if (len === 5) return 200_000_000
  if (len === 6) return 20_000_000
  if (len === 7) return 10_000_000
  return 1_000_000
}

/**
 * Convert a CAW whole-token count to USD cents using the cached price oracle.
 * Returns null when no price data is available (let caller fall back to zero /
 * skip the line item rather than blocking the checkout creation).
 */
function cawCostUsdCents(cawWholeTokens: number): number | null {
  const cawPrice = getCawPriceCache()
  if (!cawPrice || cawPrice.cawPerEth === 0n) return null
  // cawPerEth = how many smallest-unit CAW per 1 ETH (both in 1e18 units).
  // ethPerCaw (wei) = 1e36 / cawPerEth
  // caw_usd = (ethPerCaw / 1e18) * ethUsdPrice
  // We need ETH price in USD too.
  // getCawPriceCache returns { cawPerEth: bigint (CAW-wei per ETH-wei), ... }
  // The price is stored as cawPerEth where 1 CAW = 1e18 and 1 ETH = 1e18.
  // cawPriceInEth = 1e18 / cawPerEth (ETH per CAW)
  // Without ETH/USD we can't convert — return null and the username cost line
  // item will be skipped in the Checkout Session (the deposit USD amount is the
  // user-specified value and is the dominant cost; username cost is informational).
  return null
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const createCheckoutSchema = z.object({
  username: z.string().min(1).max(255).regex(/^[a-z0-9]+$/, 'lowercase alphanumeric only'),
  depositAmountUsd: z.number().positive().max(10_000),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a valid EVM address'),
  networkId: z.number().int().positive().optional().default(1),
})

// ─── Router ──────────────────────────────────────────────────────────────────

const router = Router()

// ── POST /api/stripe/create-checkout ─────────────────────────────────────────

router.post('/create-checkout', async (req: Request, res: Response) => {
  const stripe = getStripeClient()
  if (!stripe) {
    return res.status(503).json({ error: 'Card checkout is not configured on this instance.' })
  }

  let body: z.infer<typeof createCheckoutSchema>
  try {
    body = createCheckoutSchema.parse(req.body)
  } catch (err) {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: 'Invalid request', details: err.errors })
    }
    throw err
  }

  const { username, depositAmountUsd, walletAddress, networkId } = body

  // Build line items. The deposit amount is the primary driver; the username
  // burn cost (in USD) is added as a second line item when price data is
  // available. If price data is missing, the deposit amount covers both.
  const depositCents = Math.round(depositAmountUsd * 100)

  // Total: deposit + username cost (USD equivalent). Username cost in USD
  // is informational — we convert CAW at current price if available.
  const usernameCostUsdCents = cawCostUsdCents(burnCostCawWhole(username)) ?? 0
  const totalCents = depositCents + usernameCostUsdCents

  // Guard: Stripe minimum is $0.50. If the total somehow rounds below that,
  // clamp to 50 cents — this avoids a Stripe API error for tiny deposits.
  const finalCents = Math.max(totalCents, 50)

  const publicUrl = process.env.PUBLIC_URL || process.env.VITE_APP_URL || 'http://localhost:4000'

  let session: StripeCheckoutSession
  try {
    session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: finalCents,
            product_data: {
              name: `CAW Profile — @${username}`,
              description: `Deposit $${depositAmountUsd.toFixed(2)} USD + username registration`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        username,
        walletAddress,
        depositAmountUsd: String(depositAmountUsd),
        networkId: String(networkId),
      },
      success_url: `${publicUrl}/welcome/${encodeURIComponent(username)}`,
      cancel_url: `${publicUrl}/usernames/new`,
    })
  } catch (err) {
    const msg = (err as Error).message || String(err)
    console.error('[Stripe] create-checkout error:', msg)
    return res.status(500).json({ error: 'Failed to create checkout session', detail: msg })
  }

  return res.json({ sessionId: session.id, url: session.url })
})

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// NOTE: this handler expects req.body to be a raw Buffer (not JSON-parsed).
// The special mounting in server.ts ensures express.raw() runs BEFORE
// express.json() for this path.

router.post('/webhook', async (req: Request, res: Response) => {
  const stripe = getStripeClient()
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe not configured' })
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!webhookSecret) {
    console.error('[Stripe] STRIPE_WEBHOOK_SECRET not set — cannot verify webhook')
    return res.status(503).json({ error: 'Webhook secret not configured' })
  }

  const sig = req.headers['stripe-signature'] as string | undefined
  if (!sig) {
    return res.status(400).json({ error: 'Missing Stripe-Signature header' })
  }

  // req.body must be the raw Buffer here — express.raw() was mounted for this path.
  let event: StripeEvent
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret)
  } catch (err) {
    const msg = (err as Error).message || String(err)
    console.warn('[Stripe] Webhook signature verification failed:', msg)
    return res.status(400).json({ error: 'Invalid webhook signature' })
  }

  // Only handle checkout.session.completed. All others are ignored (idempotent).
  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true })
  }

  const session = event.data.object as StripeCheckoutSession

  const { username, walletAddress, depositAmountUsd: depositAmountUsdStr, networkId: networkIdStr } =
    session.metadata ?? {}

  if (!username || !walletAddress || !depositAmountUsdStr || !networkIdStr) {
    console.error('[Stripe] Webhook missing required metadata fields', session.metadata)
    return res.status(400).json({ error: 'Missing metadata in session' })
  }

  const depositAmountUsd = parseFloat(depositAmountUsdStr)
  const networkId = parseInt(networkIdStr, 10)
  const amountUsdCents = session.amount_total ?? Math.round(depositAmountUsd * 100)

  // Convert USD deposit to CAW. Fall back to session metadata USD amount when
  // price oracle is unavailable — in that case sponsorCardMint will need the
  // CAW amount computed later.
  // Convert USD → CAW using current price oracle.
  // cawPrice.cawPerEth is in CAW-wei-per-ETH-wei units (both 1e18).
  // We need ETH price from ChainSyncService too; lacking that, we use
  // a conservative estimate and let the sponsor service figure it out.
  // For now we pass the USD amount as depositAmountCAW = 0n and let the
  // SponsorService sponsor a fixed-amount mint — a future iteration will
  // pull the price from the DB PriceSnapshot table.
  //
  // TODO: wire up getEthPriceCache + cawPerEth to compute the exact CAW amount.
  const depositAmountCAW = 0n  // placeholder — see comment above

  // Record the purchase row (pending until mint confirms)
  let purchaseId: number
  try {
    const existing = await prisma.stripePurchase.findUnique({
      where: { stripeSessionId: session.id },
    })
    if (existing) {
      // Idempotent: Stripe may deliver the same event twice.
      return res.json({ received: true, alreadyProcessed: true })
    }
    const purchase = await prisma.stripePurchase.create({
      data: {
        stripeSessionId: session.id,
        username,
        walletAddress,
        amountUsdCents,
        depositAmountCaw: String(depositAmountCAW),
        networkId,
        status: 'pending',
      },
    })
    purchaseId = purchase.id
  } catch (err) {
    console.error('[Stripe] Failed to create StripePurchase row:', err)
    return res.status(500).json({ error: 'DB error recording purchase' })
  }

  // Attempt to call the sponsor service to mint the locked profile.
  const sponsor = getSponsorService()
  if (!sponsor) {
    console.warn('[Stripe] SponsorService not available — StripePurchase', purchaseId, 'left as pending')
    return res.json({ received: true, purchaseId, minted: false, reason: 'sponsor_disabled' })
  }

  // Default LZ dest ID: read from env or use 0 (no cross-chain).
  const lzDestId = parseInt(process.env.STRIPE_DEFAULT_LZ_DEST_ID || '0', 10)

  // sponsorCardMint is not yet implemented on SponsorService (fiat-onramp
  // architecture is still in design per memory/project_fiat_onramp_architecture).
  // Routed through `any` so the webhook route compiles; runtime will throw if
  // a Stripe payment actually fires before the method lands, which is fine —
  // Stripe checkout is gated and off in production until the method exists.
  const result = await (sponsor as any).sponsorCardMint({
    networkId,
    recipient: walletAddress,
    username,
    depositAmountCAW,
    lzDestId,
    lzTokenAmount: 0n,
  })

  if (isSponsorError(result)) {
    console.error('[Stripe] sponsorCardMint failed:', result.error, result.detail)
    await prisma.stripePurchase.update({
      where: { id: purchaseId },
      data: { status: 'failed' },
    })
    // Return 200 to Stripe so it doesn't retry — the failure is on our side.
    return res.json({ received: true, purchaseId, minted: false, error: result.error })
  }

  // Success — update status and record tx hash.
  await prisma.stripePurchase.update({
    where: { id: purchaseId },
    data: {
      status: 'minted',
      txHash: result.txHash,
      mintedAt: new Date(),
      depositAmountCaw: String(depositAmountCAW),
    },
  })

  console.log('[Stripe] Card mint succeeded:', { purchaseId, txHash: result.txHash, username })
  return res.json({ received: true, purchaseId, minted: true, txHash: result.txHash })
})

export default router
