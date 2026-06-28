import useTokenDataUpdate from "~/hooks/useTokenDataUpdate";
import { useTokenDataStore } from "~/store/tokenDataStore"
import { useFetchPrices } from "~/hooks/useFetchPrices";
import { useEffect, useRef } from 'react';
import { useAccount } from "wagmi";
import { clearInMemoryKeyCache } from "~/services/DmCryptoService"
import { useBlockedUsersStore } from "~/store/blockedUsersStore";


interface StateProviderProps {
  children: React.ReactNode;
}

export default function StateProvider({ children }: StateProviderProps) {
  const { address } = useAccount();
  const prevAddress = useRef<string | undefined>(undefined)

  useFetchPrices(),
  useTokenDataUpdate();

  useEffect(() => {
    // Note: the AI provider key (Gemini BYOK) is intentionally NOT cleared
    // on wallet change. It's a human-scoped credential — one person may
    // have several wallets/profiles in CAW, and forcing them to re-enter
    // the Gemini key on every switch would be hostile. Clearing the key
    // is handled by the explicit Disconnect button in AIProviderSettings,
    // and by AccountSettings' "clear all data" path.
    // DM key policy: wallet/account changes clear ONLY the in-memory DM keys +
    // ECDH shared-secret caches (satisfies F6 audit 2026-05-13 — XSS can no
    // longer read a decrypted key from the JS heap once you leave a wallet). The
    // PERSISTED localStorage blob is NEVER purged here. A user with multiple
    // wallets/passkeys must be able to switch between profiles seamlessly, each
    // keeping its DM keys — and Pop-B passkey users have no real wagmi address
    // (wagmi flickers address↔undefined on cold start / bfcache reload), so
    // purging on these transitions forced a vault-password re-prompt on every
    // reload. Persisted-key purge now lives ONLY in the explicit user actions in
    // /settings/account ("Log out" → clearKeyCache(tokenId), "Clear all data" →
    // clearKeyCache()). The plaintext-at-rest blob is the same threat surface as
    // before login; a shared device is handled by the user clicking Log Out.
    if (address && prevAddress.current && prevAddress.current !== address) {
      // ACCOUNT-SWITCH (prev defined → new defined, different address).
      useTokenDataStore.getState().removeActiveToken()
      try { clearInMemoryKeyCache() } catch { /* clearing in-memory state can't really fail */ }
      useBlockedUsersStore.getState().resetBlocks()
    }
    // DISCONNECT (address goes from defined → undefined).
    if (!address && prevAddress.current) {
      try { clearInMemoryKeyCache() } catch { /* same */ }
      useBlockedUsersStore.getState().resetBlocks()
    }
    prevAddress.current = address
  }, [address])

  // Refetch token data (balances, staked amounts) when the tab becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const refetch = useTokenDataStore.getState().refetchTokenData
        if (refetch) refetch()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  return children;
}
