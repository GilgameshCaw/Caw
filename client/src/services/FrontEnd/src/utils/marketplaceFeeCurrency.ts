/**
 * Which currency repays the relayer in a passkey (Pop-B) marketplace batch.
 *
 * The batch pays for the purchase / bid / offer and the relayer fee out of the
 * same wallet. When the listing is priced in CAW, the price and a CAW fee come
 * out of the SAME CAW balance, so checking each against the balance on its own
 * passes while their sum does not fit. The relay then refuses the batch when it
 * simulates it, after the user has already signed.
 *
 * CAW is preferred, as before; it is chosen only if the fee still fits after
 * what the batch spends in CAW on the purchase itself.
 */
export interface FeeBudget {
  /** CAW the wallet holds. */
  cawBalance: bigint
  /** CAW the batch spends on the purchase itself (the price when the listing is paid in CAW, else 0). */
  cawReserved: bigint
  /** Relayer fee in CAW, or null when there is no CAW price to quote it with. */
  cawFee: bigint | null
  /** ETH the wallet holds. */
  ethBalance: bigint
  /** ETH the batch spends besides the fee (an ETH price, a sync fee). */
  ethReserved: bigint
  /** Relayer fee in ETH. */
  ethFee: bigint
}

export function pickFeeCurrency(b: FeeBudget): 'CAW' | 'ETH' | null {
  if (b.cawFee !== null && b.cawBalance - b.cawReserved >= b.cawFee) return 'CAW'
  if (b.ethBalance - b.ethReserved >= b.ethFee) return 'ETH'
  return null
}
