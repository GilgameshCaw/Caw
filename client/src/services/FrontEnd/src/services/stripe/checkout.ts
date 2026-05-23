/**
 * Stripe Checkout client service.
 *
 * No @stripe/stripe-js SDK — we're using Stripe's hosted checkout redirect,
 * not embedded Elements. The server creates the session and returns the URL;
 * we just redirect the browser there.
 */

import { apiFetch } from '~/api/client'

export interface CreateCheckoutParams {
  username: string
  depositAmountUsd: number
  walletAddress: string
  networkId: number
}

export interface CheckoutResult {
  sessionId: string
  url: string
}

export async function createStripeCheckout(
  params: CreateCheckoutParams,
): Promise<CheckoutResult> {
  const res = await apiFetch<CheckoutResult>('/api/stripe/create-checkout', {
    method: 'POST',
    body: JSON.stringify(params),
  })
  return res
}
