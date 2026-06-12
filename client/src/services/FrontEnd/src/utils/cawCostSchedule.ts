/**
 * cawCostSchedule.ts — the canonical username-burn cost table.
 *
 * Length → cost in WHOLE CAW. Shorter names cost exponentially more. The burn
 * is paid in CAW at mint time and locked forever. This is the single source of
 * truth; previously duplicated in Profile/New.tsx, onboarding/UsernameStep.tsx,
 * Onboarding.tsx, and CardCheckout.tsx (kept in sync by hand). Import from here.
 *
 * Two shapes because callers differ:
 *   - number version (COST_SCHEDULE / cawCostForLength) for display + USD math.
 *   - bigint version (COST_SCHEDULE_BIGINT / DEFAULT_COST_BIGINT) for on-chain
 *     wei math (multiply by 10n**18n).
 */

export const COST_SCHEDULE: Record<number, number> = {
  1: 1_000_000_000_000,
  2:   240_000_000_000,
  3:    60_000_000_000,
  4:     6_000_000_000,
  5:       200_000_000,
  6:        20_000_000,
  7:        10_000_000,
}

/** Cost for 8+ character names. */
export const DEFAULT_COST = 1_000_000

/** Whole-CAW burn cost for a username of the given length. 0 length → 0. */
export function cawCostForLength(len: number): number {
  if (len === 0) return 0
  return COST_SCHEDULE[len] ?? DEFAULT_COST
}

/** bigint mirror of COST_SCHEDULE — for on-chain (wei) math. */
export const COST_SCHEDULE_BIGINT: Record<number, bigint> = Object.fromEntries(
  Object.entries(COST_SCHEDULE).map(([k, v]) => [Number(k), BigInt(v)]),
) as Record<number, bigint>

export const DEFAULT_COST_BIGINT = BigInt(DEFAULT_COST)
