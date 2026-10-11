export function assertStakeLedgerRepairAuthority(
  apply: boolean,
  quiesced = process.env.CAW_STAKE_LEDGER_REPAIR_QUIESCED,
): void {
  if (apply && quiesced !== '1') {
    throw new Error(
      'refusing --apply without quiesced repair authority; use `caw repair-stake-ledger`',
    )
  }
}
