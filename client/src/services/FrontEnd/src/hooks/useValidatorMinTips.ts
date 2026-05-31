import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useInstanceStore } from '~/store/instanceStore'

interface TipConfigResponse {
  minTipPerActionWei: string
}

const STALE_TIME_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Fans out to each active discovered instance's /api/validator-analytics/tip-config
 * and returns a Map<apiUrl, minTipPerActionWei_as_bigint>.
 *
 * Instances that fail or time-out are treated as having no floor (0n) so
 * they don't inflate "validators who reject this tip" counts incorrectly.
 * The caller should interpret a missing/failed entry as "unknown, assume OK".
 *
 * Returns:
 *   - minTipsMap: Map<apiUrl, bigint>  — only settled successful entries
 *   - total: number                    — total active instances queried
 *   - isLoading: boolean               — true while any request is in-flight
 */
export function useValidatorMinTips(): {
  minTipsMap: Map<string, bigint>
  total: number
  isLoading: boolean
} {
  const getActiveInstances = useInstanceStore(s => s.getActiveInstances)
  const instances = useMemo(() => getActiveInstances(), [getActiveInstances])

  const results = useQueries({
    queries: instances.map(inst => ({
      queryKey: ['validatorTipConfig', inst.apiUrl],
      queryFn: async (): Promise<{ apiUrl: string; minWei: bigint }> => {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 5000)
        try {
          const res = await fetch(
            `${inst.apiUrl}/api/validator-analytics/tip-config`,
            { signal: ctrl.signal },
          )
          clearTimeout(t)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = (await res.json()) as TipConfigResponse
          const minWei = BigInt(data.minTipPerActionWei ?? '0')
          return { apiUrl: inst.apiUrl, minWei }
        } catch {
          clearTimeout(t)
          // Treat unreachable / malformed as 0 (no floor imposed)
          return { apiUrl: inst.apiUrl, minWei: 0n }
        }
      },
      staleTime: STALE_TIME_MS,
      // Never throw — queryFn already swallows errors and returns 0n
      retry: false,
    })),
  })

  const minTipsMap = useMemo(() => {
    const map = new Map<string, bigint>()
    for (const result of results) {
      if (result.data) {
        map.set(result.data.apiUrl, result.data.minWei)
      }
    }
    return map
  }, [results.map(r => r.data?.apiUrl + ':' + r.data?.minWei?.toString()).join(',')])

  const isLoading = results.some(r => r.isLoading)

  return { minTipsMap, total: instances.length, isLoading }
}

/**
 * Given a user's tipCeiling (in whole CAW tokens) and the current ETH/CAW
 * price, computes how many of the discovered validators will accept it.
 *
 * Each validator publishes `minTipPerActionWei` (ETH wei). We convert the
 * user's ceiling from CAW tokens to wei for comparison:
 *
 *   ceilingWei = tipCeilingCaw * (1 CAW in ETH) * 1e18
 *              = tipCeilingCaw * cawPriceInEth * 1e18
 *
 * where cawPriceInEth = cawPriceUsd / ethPriceUsd.
 *
 * Instances that didn't respond (not in minTipsMap) are assumed to accept
 * (their floor is treated as 0). This is conservative toward the user —
 * we only warn when we have positive evidence that a validator rejects.
 */
export function countAcceptingValidators(
  minTipsMap: Map<string, bigint>,
  total: number,
  tipCeilingCaw: bigint,
  cawPriceUsd: number,
  ethPriceUsd: number,
): { accepting: number; total: number; minFloorWei: bigint } {
  if (total === 0) return { accepting: 0, total: 0, minFloorWei: 0n }

  // Convert ceiling to wei
  let ceilingWei = 0n
  if (tipCeilingCaw > 0n && cawPriceUsd > 0 && ethPriceUsd > 0) {
    const cawInEth = cawPriceUsd / ethPriceUsd
    // Multiply by 1e18 (wei per ETH), keep precision via integer math
    // Number(tipCeilingCaw) is safe for typical CAW amounts (<2^53)
    const weiF = Number(tipCeilingCaw) * cawInEth * 1e18
    ceilingWei = BigInt(Math.floor(weiF))
  }

  let minFloorWei = 0n

  // For instances we HAVE data for, check acceptance.
  // Instances not in the map get floor 0 (assumed accepting).
  let rejecting = 0
  for (const [, floor] of minTipsMap) {
    if (floor > minFloorWei) minFloorWei = floor
    if (ceilingWei < floor) rejecting++
  }

  const accepting = total - rejecting

  return { accepting, total, minFloorWei }
}
