/**
 * useRescuePasskeyWallet — sweep CAW (and optionally ETH) out of a profile-LESS
 * passkey SmartEOA that this browser controls, WITHOUT needing an active profile
 * or a stored credentialId.
 *
 * This is the recovery path for a wallet whose last profile was transferred away
 * (leaving CAW/ETH stranded and the wallet invisible to the normal chooser). The
 * normal useSmartEoaExecute is gated on population==='B' + an active token, so it
 * can't act here — we build the SmartEOA.executeBatch digest for the given address
 * directly (buildExecuteDigest, reused) and sign it with:
 *   - the RECOVERY key (secp256k1) when the wallet is in recovery mode (backup
 *     file loaded), which is a cheap 65-byte ECDSA sig; else
 *   - a DISCOVERABLE passkey assertion (signWithPasskeyDiscoverable, empty
 *     allowCredentials) so the OS offers the resident passkey — no stored
 *     credentialId required.
 * Then it POSTs the batch to /api/sponsor/execute, which relays it (the server
 * does NOT gate execute on profile ownership — only the selector allow-list +
 * fee-repay invariant).
 *
 * The relayer fronts gas and is repaid IN CAW from the batch (a CAW.transfer leg),
 * so the wallet needs enough CAW to cover the ~sub-dollar relay fee. See
 * project_relay_fee_headroom + reference_passkey_relay_fee_model.
 */

import { useCallback, useState } from 'react'
import { erc20Abi, encodeFunctionData, hexToBytes as viemHexToBytes, type Address, type Hex } from 'viem'
import { usePublicClient } from 'wagmi'
import { smartEoaAbi } from '~/../../../abi/generated'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { apiFetch } from '~/api/client'
import { chains } from '~/config/chains'
import { buildExecuteDigest, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { signWithPasskeyDiscoverable } from '~/services/identity/passkey'
import { signDigestForOnChain } from '~/services/identity/secp256k1Key'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'
import { useIdentitySigning } from '~/components/identity/IdentitySigningProvider'

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  return viemHexToBytes(('0x' + clean) as Hex)
}

export interface RescueResult {
  txHash: string
  /** CAW swept to `destination` (raw wei), net of the relay fee leg. */
  cawSweptWei: bigint
}

// Headroom on the signed relay fee (must clear the relay's re-derived floor;
// gas drift + fee-leg gas). Mirrors project_relay_fee_headroom.
const withHeadroom = (v: bigint) => (v * 115n) / 100n

export function useRescuePasskeyWallet(): {
  rescueCaw: (opts: { walletAddress: Address; destination: Address }) => Promise<RescueResult>
  pending: boolean
  error: string | null
} {
  const l1Client = usePublicClient({ chainId: chains.l1.chainId })
  const recovery = useRecoveryContext()
  const { startSigning, stopSigning } = useIdentitySigning()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rescueCaw = useCallback(
    async ({ walletAddress, destination }: { walletAddress: Address; destination: Address }): Promise<RescueResult> => {
      if (!l1Client) throw new Error('No L1 client available.')
      setError(null)
      setPending(true)
      try {
        const eoa = walletAddress
        // 1) Read balance + the wallet's executeNonce.
        const [cawBal, nonce] = await Promise.all([
          l1Client.readContract({ address: CAW_ADDRESS as Address, abi: erc20Abi, functionName: 'balanceOf', args: [eoa] }) as Promise<bigint>,
          l1Client.readContract({ address: eoa, abi: smartEoaAbi, functionName: 'executeNonceOf' }) as Promise<bigint>,
        ])
        if (cawBal === 0n) throw new Error('NO_CAW')

        // 2) Price the relay fee against the ACTUAL 2-call batch (sweep + fee leg)
        //    so the signed CAW clears the relay floor (see relay_fee_headroom:
        //    quoting fewer calls under-counts the fee-leg gas → FEE_TOO_LOW).
        const placeholderFeeLeg = {
          to: CAW_ADDRESS as Address,
          value: '0',
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [eoa, 1n] }),
        }
        const sweepPlaceholder = {
          to: CAW_ADDRESS as Address,
          value: '0',
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, 1n] }),
        }
        const quote = await apiFetch<{ relayer: string; minFeeCawWei: string; priceAvailable: boolean }>(
          '/api/sponsor/execute-estimate',
          {
            method: 'POST',
            body: JSON.stringify({
              eoaAddress: eoa,
              calls: [sweepPlaceholder, placeholderFeeLeg],
              forwardedValueWei: '0',
            }),
          },
        )
        if (!quote.priceAvailable) throw new Error('PRICE_UNAVAILABLE')
        const feeCaw = withHeadroom(BigInt(quote.minFeeCawWei))
        if (cawBal <= feeCaw) throw new Error('CAW_BELOW_FEE')

        // 3) Sweep = everything MINUS the relay fee (which is repaid in-batch).
        const sweepAmount = cawBal - feeCaw
        const calls: ExecCall[] = [
          { to: CAW_ADDRESS as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [destination, sweepAmount] }) },
          { to: CAW_ADDRESS as Address, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [quote.relayer as Address, feeCaw] }) },
        ]

        // 4) Sign the executeBatch digest for THIS wallet (no active-token dep).
        const digest = buildExecuteDigest(eoa, chains.l1.chainId, calls, nonce)
        let sig: Hex
        if (recovery.isInRecoveryMode && recovery.privateKey && recovery.address?.toLowerCase() === eoa.toLowerCase()) {
          // Backup-file key controls exactly this wallet — cheap ECDSA path.
          sig = signDigestForOnChain(hexToBytes(recovery.privateKey), digest)
        } else {
          // Discoverable passkey — OS offers the resident passkey; no stored id.
          startSigning('Confirm with your passkey to rescue this wallet')
          try {
            const rpId = typeof window !== 'undefined' ? window.location.hostname : 'app.caw.social'
            const res = await signWithPasskeyDiscoverable({ digest, rpId })
            sig = res.sig
          } finally {
            stopSigning()
          }
        }

        // 5) Relay.
        const resp = await apiFetch<{ txHash: string }>('/api/sponsor/execute', {
          method: 'POST',
          body: JSON.stringify({
            smartEoaAddress: eoa,
            calls: calls.map(c => ({ to: c.to, value: c.value.toString(), data: c.data })),
            nonce: nonce.toString(),
            sig,
          }),
        })
        return { txHash: resp.txHash, cawSweptWei: sweepAmount }
      } catch (err: any) {
        const raw = (err?.message || '').replace(/^API\s+\d+:\s*/i, '')
        setError(raw || 'RESCUE_FAILED')
        throw err
      } finally {
        setPending(false)
      }
    },
    [l1Client, recovery.isInRecoveryMode, recovery.privateKey, recovery.address, startSigning, stopSigning],
  )

  return { rescueCaw, pending, error }
}
