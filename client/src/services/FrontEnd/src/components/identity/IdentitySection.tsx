/**
 * IdentitySection.tsx
 *
 * Identity management panel shown in AccountSettings for Population B
 * (EIP-7702) users only. Hidden for Population A and C.
 *
 * Reads passkey state from SmartEOA events via getLogs() because the
 * contract does not expose view functions for listing enrolled passkeys
 * or pending passkeys. Derivation:
 *   - Enrolled: addresses in PasskeyActivated events minus PasskeyRemoved
 *   - Pending:  PasskeyAdded minus (PasskeyActivated | PasskeyCancelled)
 *
 * The ecdsaFallback address is derived from the last EcdsaFallbackRotated
 * event (or taken from the EIP-7702 initialization log). Because the ABI
 * doesn't expose a view getter for the fallback address, we read it from
 * the events. This is acceptable for an identity panel that loads once on
 * mount — it's not a hot path.
 *
 * Passkey ID display: we show the first 8 chars of the pubkeyHash as the
 * short identifier. This matches the contract's keccak256(abi.encode(X, Y))
 * pubkeyHash emitted in events.
 *
 * localStorage key for stored credential ID:
 *   "caw:passkey-credential-id" — used to badge "This device" on the
 *   matching passkey row.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { encodeAbiParameters } from 'viem'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { HiKey, HiIdentification, HiPlus, HiRefresh, HiDownload, HiTrash } from 'react-icons/hi'
import { erc20Abi, encodeFunctionData } from 'viem'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useWalletPopulation } from '~/hooks/useWalletPopulation'
import { getPasskeyCredential } from '~/constants/passkeyStorage'
import { useActiveToken } from '~/store/tokenDataStore'
import { useQuickSignPromptStore } from '~/components/modals/QuickSignModal'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { apiFetch } from '~/api/client'
import { CAW_ADDRESS } from '~/../../../abi/addresses'
import { smartEoaAbi } from '~/../../../abi/generated'
import { useSmartEoaExecute, type ExecCall } from '~/hooks/useSmartEoaExecute'
import { useSmartEoaManagement } from '~/hooks/useSmartEoaManagement'
import AddPasskeyDialog, { type PendingPasskeyRow } from './AddPasskeyDialog'
import RotateEcdsaFallbackDialog from './RotateEcdsaFallbackDialog'
import ReDownloadBackupDialog from './ReDownloadBackupDialog'
import RemovePasskeyDialog from './RemovePasskeyDialog'

interface SponsorExecuteQuote {
  relayer: Address
  minFeeCawWei: string
  priceAvailable: boolean
  cawAddress: Address
}


// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrolledPasskey {
  pubkeyHash: `0x${string}`
  /** True if this hash matches the credential stored in localStorage. */
  isThisDevice: boolean
}

interface PasskeyState {
  enrolled: EnrolledPasskey[]
  pending: PendingPasskeyRow[]
  ecdsaFallbackAddress: `0x${string}` | undefined
}

// ─── Event-based passkey state reader ────────────────────────────────────────

async function readPasskeyState(
  publicClient: ReturnType<typeof usePublicClient>,
  walletAddress: `0x${string}`,
): Promise<PasskeyState> {
  if (!publicClient) {
    return { enrolled: [], pending: [], ecdsaFallbackAddress: undefined }
  }

  // Read all passkey-related events from this EOA address.
  const [activated, added, removed, cancelled, fallbackRotated] = await Promise.all([
    publicClient.getLogs({
      address: walletAddress,
      event: { type: 'event', name: 'PasskeyActivated', inputs: [{ name: 'pubkeyHash', type: 'bytes32', indexed: true }] } as const,
      fromBlock: 0n,
      toBlock: 'latest',
    }).catch(() => []),
    publicClient.getLogs({
      address: walletAddress,
      event: { type: 'event', name: 'PasskeyAdded', inputs: [{ name: 'pubkeyHash', type: 'bytes32', indexed: true }, { name: 'validFrom', type: 'uint64', indexed: false }] } as const,
      fromBlock: 0n,
      toBlock: 'latest',
    }).catch(() => []),
    publicClient.getLogs({
      address: walletAddress,
      event: { type: 'event', name: 'PasskeyRemoved', inputs: [{ name: 'pubkeyHash', type: 'bytes32', indexed: true }] } as const,
      fromBlock: 0n,
      toBlock: 'latest',
    }).catch(() => []),
    publicClient.getLogs({
      address: walletAddress,
      event: { type: 'event', name: 'PasskeyCancelled', inputs: [{ name: 'pubkeyHash', type: 'bytes32', indexed: true }] } as const,
      fromBlock: 0n,
      toBlock: 'latest',
    }).catch(() => []),
    publicClient.getLogs({
      address: walletAddress,
      event: { type: 'event', name: 'EcdsaFallbackRotated', inputs: [{ name: 'newFallback', type: 'address', indexed: true }] } as const,
      fromBlock: 0n,
      toBlock: 'latest',
    }).catch(() => []),
  ])

  // Derive sets.
  const removedHashes = new Set(removed.map(l => (l.topics[1] as `0x${string}`)))
  const cancelledHashes = new Set(cancelled.map(l => (l.topics[1] as `0x${string}`)))
  const activatedHashes = new Set(activated.map(l => (l.topics[1] as `0x${string}`)))

  // Enrolled = activated minus removed.
  const enrolledHashes = [...activatedHashes].filter(h => !removedHashes.has(h))

  // Pending = added minus (activated OR cancelled).
  const pendingRows: PendingPasskeyRow[] = added
    .filter(l => {
      const hash = l.topics[1] as `0x${string}`
      return !activatedHashes.has(hash) && !cancelledHashes.has(hash)
    })
    .map(l => {
      const pubkeyHash = l.topics[1] as `0x${string}`
      // validFrom is non-indexed, encoded in data. Use block timestamp as fallback.
      const logArgs = l.args as Record<string, unknown> | undefined
      const validFrom = logArgs && typeof logArgs['validFrom'] === 'bigint'
        ? Number(logArgs['validFrom'])
        : 0
      return {
        pubkeyHash,
        pubkeyX: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        pubkeyY: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        proposedAt: validFrom,
      }
    })

  // Latest ecdsaFallback rotation.
  const ecdsaFallbackAddress = fallbackRotated.length > 0
    ? (fallbackRotated[fallbackRotated.length - 1].topics[1] as `0x${string}`)
    : undefined

  return {
    enrolled: enrolledHashes.map(h => ({ pubkeyHash: h, isThisDevice: false })),
    pending: pendingRows,
    ecdsaFallbackAddress,
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface IdentitySectionProps {
  /** In-memory secp256k1 private key — passed from parent session state. */
  inMemoryPrivateKey?: Uint8Array | null
  /** Username for downloaded file names and passkey credential displayName. */
  username?: string
}

export function IdentitySection({
  inMemoryPrivateKey = null,
  username = 'user',
}: IdentitySectionProps): JSX.Element | null {
  const { isDark } = useTheme()
  const t = useT()
  // Source the account address from useWalletPopulation, NOT raw useAccount():
  // in RECOVERY MODE there is no wagmi wallet connected, so useAccount().address
  // is undefined and the whole Identity section (add-passkey, rotate, etc.) would
  // render empty — which is exactly why a recovered user found "nowhere to set a
  // passkey". useWalletPopulation returns the recovered/​passkey owner address for
  // Population B whether or not a wagmi wallet is connected.
  const { population, address } = useWalletPopulation()
  const publicClient = usePublicClient()

  // Only render for Population B (not while loading, not for A/C/none).
  if (population !== 'B') return null

  return (
    <IdentitySectionInner
      walletAddress={address}
      publicClient={publicClient}
      isDark={isDark}
      t={t}
      inMemoryPrivateKey={inMemoryPrivateKey}
      username={username}
    />
  )
}

// Inner component — walletAddress is guaranteed non-null here because the
// outer component only renders for Population B (which requires a connected wallet).
function IdentitySectionInner({
  walletAddress,
  publicClient,
  isDark,
  t,
  inMemoryPrivateKey,
  username,
}: {
  walletAddress: `0x${string}` | undefined
  publicClient: ReturnType<typeof usePublicClient>
  isDark: boolean
  t: (key: string) => string
  inMemoryPrivateKey: Uint8Array | null
  username: string
}): JSX.Element {
  // Hooks for sponsor-relayed rotate.
  const { execute: smartEoaExecute, account: eoaAccount } = useSmartEoaExecute()
  const { signManagement, signManagementWithRecoveryKey } = useSmartEoaManagement()
  const activeToken = useActiveToken()
  const hasActiveSession = useHasActiveSession()

  // Dialog open states.
  const [addPasskeyOpen, setAddPasskeyOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [redownloadOpen, setRedownloadOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<`0x${string}` | null>(null)

  // Deep-link: /settings/account?addPasskey=1 auto-opens the Add-Passkey dialog
  // on arrival (used by the recovery banner so a recovered user is one click from
  // enrolling). Consume the param once, then strip it so a refresh doesn't re-open.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('addPasskey') === '1') {
      setAddPasskeyOpen(true)
      const next = new URLSearchParams(searchParams)
      next.delete('addPasskey')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // Read passkey state from chain events.
  const { data: passkeyState, isLoading, refetch } = useQuery({
    queryKey: ['smart-eoa-passkeys', walletAddress],
    queryFn: () => readPasskeyState(publicClient, walletAddress!),
    enabled: !!walletAddress && !!publicClient,
    staleTime: 5 * 60 * 1000,
  })

  // Local credential ID badge — the passkey credential for the ACTIVE profile
  // (per-account, keyed by tokenId; see passkeyStorage.ts).
  const localCredentialId = useMemo(() => {
    try {
      return getPasskeyCredential(activeToken?.tokenId)
    } catch {
      return null
    }
  }, [activeToken?.tokenId])

  const enrolled = passkeyState?.enrolled ?? []
  const pending = passkeyState?.pending ?? []
  const ecdsaFallbackAddress = passkeyState?.ecdsaFallbackAddress
  const enrolledCount = enrolled.length

  // Sponsor-relayed rotateEcdsaFallback via CAW fee repay.
  //
  // Batch: [rotateEcdsaFallback(newFallback, mgmtSig), CAW.transfer(relayer, feeCaw)]
  // Order: rotate FIRST so the fee leg can be deducted from liquid CAW on the EOA.
  //
  // NOTE: the user must hold liquid CAW in their EOA (not just L2-deposited).
  // If the EOA balance is zero the batch will revert on the fee transfer.
  const handleRotate = useCallback(
    async (newEcdsaAddress: `0x${string}`, _blobJson: string): Promise<void> => {
      if (!eoaAccount) throw new Error('No passkey wallet connected.')

      // 1. Fetch the execute fee quote.
      const quote = await apiFetch<SponsorExecuteQuote>('/api/sponsor/execute-quote')
      if (!quote.priceAvailable) {
        throw new Error('CAW fee pricing is temporarily unavailable. Try again shortly.')
      }
      const feeCaw = BigInt(quote.minFeeCawWei)

      // 2. Build the management sig for rotateEcdsaFallback.
      //    params = abi.encode(newFallback) — matches contract's abi.encode(newFallback).
      const params = encodeAbiParameters(
        [{ type: 'address' }],
        [newEcdsaAddress],
      ) as `0x${string}`
      const mgmtSig = await signManagement('rotateEcdsaFallback', params)

      // 3. Build the batch.
      //    Call 1: rotateEcdsaFallback (selector 0xd76393e7)
      const call1: ExecCall = {
        to: eoaAccount,
        value: 0n,
        data: encodeFunctionData({
          abi: smartEoaAbi,
          functionName: 'rotateEcdsaFallback',
          args: [newEcdsaAddress, mgmtSig],
        }),
      }
      //    Call 2: pay CAW fee to relayer
      const call2: ExecCall = {
        to: CAW_ADDRESS,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [quote.relayer, feeCaw],
        }),
      }

      // 4. Sign the batch with the passkey and POST to /api/sponsor/execute.
      await smartEoaExecute([call1, call2])
    },
    [eoaAccount, signManagement, smartEoaExecute],
  )

  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/60' : 'text-gray-500'
  const subtleBg = isDark ? 'bg-white/5' : 'bg-gray-50'
  const labelClass = `text-sm font-semibold mb-2 uppercase tracking-wide ${isDark ? 'text-white/40' : 'text-gray-400'}`

  return (
    <section className="mb-8" data-testid="identity-section">
      <h2 className={labelClass}>
        {t('account.section.identity')}
      </h2>

      <div className={`rounded-lg ${subtleBg} divide-y ${isDark ? 'divide-white/5' : 'divide-gray-100'}`}>
        {/* Population indicator */}
        <div className="flex items-center gap-3 px-4 py-3">
          <div className={`p-2 rounded-full ${isDark ? 'bg-yellow-500/20' : 'bg-yellow-100'}`}>
            <HiIdentification className="w-4 h-4 text-yellow-500" />
          </div>
          <div>
            <p className={`text-sm font-medium ${strongClass}`}>
              {t('identity.section.pop_b_label')}
            </p>
            <p className={`text-xs ${mutedClass}`}>
              {t('identity.section.pop_b_description')}
            </p>
          </div>
        </div>

        {/* Enrolled passkeys */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <p className={`text-sm font-medium ${strongClass}`}>
              {t('identity.section.passkeys_label')}
            </p>
            <button
              type="button"
              data-testid="add-passkey-btn"
              onClick={() => setAddPasskeyOpen(true)}
              className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white/80 hover:bg-white/20'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <HiPlus className="w-3 h-3" />
              {t('identity.section.add_passkey_btn')}
            </button>
          </div>

          {isLoading && (
            <div className="space-y-2" data-testid="passkeys-loading">
              {[0, 1].map(i => (
                <div
                  key={i}
                  className={`h-10 rounded-lg animate-pulse ${isDark ? 'bg-white/5' : 'bg-gray-100'}`}
                />
              ))}
            </div>
          )}

          {!isLoading && enrolled.length === 0 && pending.length === 0 && (
            <p className={`text-sm ${mutedClass}`} data-testid="no-passkeys">
              {t('identity.section.no_passkeys')}
            </p>
          )}

          {!isLoading && enrolled.length > 0 && (
            <div className="space-y-2">
              {enrolled.map(pk => {
                const shortId = pk.pubkeyHash.slice(2, 10) // 8 chars after 0x
                const isThisDevice = !!localCredentialId &&
                  pk.pubkeyHash.toLowerCase().includes(localCredentialId.toLowerCase().slice(0, 8))

                return (
                  <div
                    key={pk.pubkeyHash}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg ${
                      isDark ? 'bg-white/5' : 'bg-white border border-gray-200'
                    }`}
                    data-testid={`enrolled-passkey-${shortId}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <HiKey className={`w-4 h-4 flex-shrink-0 ${isDark ? 'text-white/50' : 'text-gray-400'}`} />
                      <div className="min-w-0">
                        <p className={`text-xs font-mono truncate ${strongClass}`}>
                          {shortId}…
                        </p>
                        {isThisDevice && (
                          <span className={`text-xs font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}>
                            {t('identity.section.this_device')}
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      data-testid={`remove-passkey-btn-${shortId}`}
                      onClick={() => setRemoveTarget(pk.pubkeyHash)}
                      className={`flex-shrink-0 p-1.5 rounded transition-colors cursor-pointer ${
                        isDark
                          ? 'text-white/40 hover:text-red-400 hover:bg-white/10'
                          : 'text-gray-400 hover:text-red-600 hover:bg-gray-100'
                      }`}
                      aria-label={`Remove passkey ${shortId}`}
                    >
                      <HiTrash className="w-4 h-4" />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Pending passkeys banner */}
          {!isLoading && pending.length > 0 && (
            <div className="mt-2">
              <p className={`text-xs font-medium mb-1 ${mutedClass}`}>
                {t('identity.section.pending_passkeys_label')}
              </p>
              {pending.map(pk => {
                const nowSeconds = Math.floor(Date.now() / 1000)
                const canFinalize = pk.proposedAt + 24 * 3600 <= nowSeconds
                const shortId = pk.pubkeyHash.slice(2, 10)
                return (
                  <div
                    key={pk.pubkeyHash}
                    className={`flex items-center justify-between px-3 py-2 rounded-lg mb-1 border ${
                      isDark ? 'bg-white/5 border-white/10' : 'bg-white border-gray-200'
                    }`}
                    data-testid={`pending-passkey-row-${shortId}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <HiKey className={`w-4 h-4 flex-shrink-0 ${mutedClass}`} />
                      <div>
                        <p className={`text-xs font-mono ${strongClass}`}>{shortId}… (pending)</p>
                      </div>
                    </div>
                    {canFinalize && (
                      <button
                        type="button"
                        data-testid={`finalize-btn-${shortId}`}
                        onClick={() => setAddPasskeyOpen(true)}
                        className="text-xs px-2 py-1 rounded bg-yellow-500 text-black font-medium hover:bg-yellow-400 transition-colors cursor-pointer"
                      >
                        {t('identity.add_passkey.finalize_btn')}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Recovery key section */}
        <div className="px-4 py-3">
          <p className={`text-sm font-medium mb-1 ${strongClass}`}>
            {t('identity.section.recovery_key_label')}
          </p>
          {ecdsaFallbackAddress ? (
            <p className={`text-xs font-mono break-all mb-3 ${mutedClass}`}>
              {ecdsaFallbackAddress}
            </p>
          ) : (
            <p className={`text-xs mb-3 ${mutedClass}`}>
              {t('identity.section.no_fallback')}
            </p>
          )}

          <p className={`text-xs mb-3 ${mutedClass}`}>
            {t('identity.section.rotation_warning')}
          </p>

          <div className="flex flex-col gap-2">
            <button
              type="button"
              data-testid="rotate-fallback-btn"
              onClick={() => setRotateOpen(true)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/20'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <HiRefresh className="w-4 h-4" />
              {t('identity.section.rotate_btn')}
            </button>

            <button
              type="button"
              data-testid="redownload-btn"
              onClick={() => setRedownloadOpen(true)}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/20'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              <HiDownload className="w-4 h-4" />
              {t('identity.section.redownload_btn')}
            </button>
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <AddPasskeyDialog
        open={addPasskeyOpen}
        onClose={() => { setAddPasskeyOpen(false); refetch() }}
        pendingPasskeys={pending}
        onPropose={async (passkey) => {
          // Relay SmartEOA.addPasskey(pubkeyX, pubkeyY, callerSig) via sponsor.
          // selector 0x4f43be60; args (bytes32 pubkeyX, bytes32 pubkeyY, bytes callerSig).
          // The contract bakes the 24h timelock in — validFrom = now + 24h — and the
          // key auto-activates after the timelock with NO second on-chain tx.
          if (!eoaAccount) throw new Error('No passkey wallet connected.')

          const quote = await apiFetch<SponsorExecuteQuote>('/api/sponsor/execute-quote')
          if (!quote.priceAvailable) {
            throw new Error('CAW fee pricing is temporarily unavailable. Try again shortly.')
          }
          const feeCaw = BigInt(quote.minFeeCawWei)

          // RECOVERY MODE: signed in via backup file, no passkey on this device.
          // Two consequences vs the normal add-a-device flow:
          //   1. Sign management ops with the RECOVERY KEY (secp256k1), not a
          //      device passkey — signManagement() would throw "no passkey".
          //   2. SmartEOA.addPasskey only accepts a recovery-key sig when the
          //      on-chain ACTIVE passkey count is 0 (the bootstrap-recovery
          //      branch). A user who lost their device still has that device's
          //      stale passkey enrolled, so we must REMOVE the stale one(s) FIRST.
          //      removePasskey + addPasskey run sequentially IN THE SAME batch tx,
          //      so activeCount is already 0 by the time addPasskey executes.
          const inRecovery = !!inMemoryPrivateKey
          const calls: ExecCall[] = []

          // Nonce sequencing: the contract does ++managementNonce after EACH
          // management op, so op #k in the batch must be signed against
          // (currentNonce + k). Track the running offset.
          let nonceK = 0
          if (inRecovery) {
            // Remove every currently-enrolled (stale) passkey via the recovery key.
            for (const p of passkeyState?.enrolled ?? []) {
              const rmParams = encodeAbiParameters([{ type: 'bytes32' }], [p.pubkeyHash]) as `0x${string}`
              const rmSig = await signManagementWithRecoveryKey('removePasskey', rmParams, nonceK)
              calls.push({
                to: eoaAccount,
                value: 0n,
                data: encodeFunctionData({
                  abi: smartEoaAbi,
                  functionName: 'removePasskey',
                  args: [p.pubkeyHash, rmSig],
                }),
              })
              nonceK++
            }
          }

          // params = abi.encode(pubkeyX, pubkeyY) — TWO bytes32, matching
          // the contract's _managementDigest("addPasskey", abi.encode(newPubkeyX, newPubkeyY)).
          const params = encodeAbiParameters(
            [{ type: 'bytes32' }, { type: 'bytes32' }],
            [passkey.pubkeyX, passkey.pubkeyY],
          ) as `0x${string}`
          const mgmtSig = inRecovery
            ? await signManagementWithRecoveryKey('addPasskey', params, nonceK)
            : await signManagement('addPasskey', params)

          calls.push({
            to: eoaAccount,
            value: 0n,
            data: encodeFunctionData({
              abi: smartEoaAbi,
              functionName: 'addPasskey',
              args: [passkey.pubkeyX, passkey.pubkeyY, mgmtSig],
            }),
          })
          calls.push({
            to: CAW_ADDRESS,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [quote.relayer, feeCaw],
            }),
          })

          const txHash = await smartEoaExecute(calls)
          return { txHash }
        }}
        onFinalize={async (_pubkeyId) => {
          // SmartEOA has NO finalizeAddPasskey / confirmPasskey function.
          // addPasskey() enrolls the key in one call with validFrom = now + 24h;
          // the key becomes active automatically after the timelock — no second tx needed.
          // This callback is therefore a deliberate no-op on-chain: just close and
          // refetch state. As a convenience, nudge the user to enable Quick Sign
          // right after — many add a passkey precisely so they can sign in/act on a
          // new device, and Quick Sign is the next thing they'll want. Only prompt
          // when there's no active session yet. (Slight delay so the dialog close
          // animation finishes before the QS modal opens.)
          setAddPasskeyOpen(false)
          refetch()
          if (!hasActiveSession) {
            setTimeout(() => useQuickSignPromptStore.getState().showConnect(), 300)
          }
        }}
        onCancel={async (pubkeyId) => {
          // Relay SmartEOA.cancelPendingPasskey(targetPubkeyHash, callerSig) via sponsor.
          // selector 0x8713d23a; args (bytes32 targetPubkeyHash, bytes callerSig).
          if (!eoaAccount) throw new Error('No passkey wallet connected.')

          const quote = await apiFetch<SponsorExecuteQuote>('/api/sponsor/execute-quote')
          if (!quote.priceAvailable) {
            throw new Error('CAW fee pricing is temporarily unavailable. Try again shortly.')
          }
          const feeCaw = BigInt(quote.minFeeCawWei)

          // params = abi.encode(targetPubkeyHash) — ONE bytes32.
          const params = encodeAbiParameters(
            [{ type: 'bytes32' }],
            [pubkeyId],
          ) as `0x${string}`
          const mgmtSig = await signManagement('cancelPendingPasskey', params)

          const call1: ExecCall = {
            to: eoaAccount,
            value: 0n,
            data: encodeFunctionData({
              abi: smartEoaAbi,
              functionName: 'cancelPendingPasskey',
              args: [pubkeyId, mgmtSig],
            }),
          }
          const call2: ExecCall = {
            to: CAW_ADDRESS,
            value: 0n,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [quote.relayer, feeCaw],
            }),
          }

          await smartEoaExecute([call1, call2])
        }}
        username={username}
      />

      <RotateEcdsaFallbackDialog
        open={rotateOpen}
        onClose={() => { setRotateOpen(false); refetch() }}
        walletAddress={walletAddress ?? '0x0000000000000000000000000000000000000000'}
        currentFallbackAddress={ecdsaFallbackAddress}
        needsEthFunding={false}
        onRotate={handleRotate}
        username={username}
      />

      <ReDownloadBackupDialog
        open={redownloadOpen}
        onClose={() => setRedownloadOpen(false)}
        inMemoryPrivateKey={inMemoryPrivateKey}
        ecdsaFallbackAddress={ecdsaFallbackAddress}
        username={username}
      />

      {removeTarget && (
        <RemovePasskeyDialog
          open={removeTarget !== null}
          onClose={() => { setRemoveTarget(null); refetch() }}
          targetPasskeyHash={removeTarget}
          activePasskeyCount={enrolledCount}
          ecdsaFallbackAddr={
            ecdsaFallbackAddress ?? '0x0000000000000000000000000000000000000000'
          }
          onConfirm={async ({ unlocked }) => {
            if (!eoaAccount) throw new Error('No passkey wallet connected.')

            // 1. Fetch the execute fee quote.
            const quote = await apiFetch<SponsorExecuteQuote>('/api/sponsor/execute-quote')
            if (!quote.priceAvailable) {
              throw new Error('CAW fee pricing is temporarily unavailable. Try again shortly.')
            }
            const feeCaw = BigInt(quote.minFeeCawWei)

            // 2. ABI-encode the single bytes32 param (targetPubkeyHash).
            const params = encodeAbiParameters(
              [{ type: 'bytes32' }],
              [removeTarget],
            ) as `0x${string}`

            // 3. Sign the management op with the appropriate key.
            //    unlocked=true  → recovery key (secp256k1, 65-byte) → unconditional
            //                     removal regardless of remaining passkey count.
            //    unlocked=false → active passkey (WebAuthn) → co-signer removal
            //                     (contract requires N>=2 and signer != target).
            const mgmtSig = unlocked
              ? await signManagementWithRecoveryKey('removePasskey', params)
              : await signManagement('removePasskey', params)

            // 4. Build the batch mirroring handleRotate exactly.
            //    Call 1: SmartEOA.removePasskey(targetPubkeyHash, callerSig)
            const call1: ExecCall = {
              to: eoaAccount,
              value: 0n,
              data: encodeFunctionData({
                abi: smartEoaAbi,
                functionName: 'removePasskey',
                args: [removeTarget, mgmtSig],
              }),
            }
            //    Call 2: pay CAW fee to relayer
            const call2: ExecCall = {
              to: CAW_ADDRESS,
              value: 0n,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [quote.relayer, feeCaw],
              }),
            }

            // 5. Sign the batch with the passkey/recovery key and relay.
            await smartEoaExecute([call1, call2])
          }}
        />
      )}
    </section>
  )
}

export default IdentitySection
