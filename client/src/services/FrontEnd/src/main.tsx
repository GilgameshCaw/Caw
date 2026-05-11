import './instrument';
import './utils/polyfills';
import { StrictMode } from "react";

// We manage scroll restoration ourselves (per-feed anchors in Feed.tsx).
// Disable the browser's default so it doesn't fight our restore on back/fwd.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// Reaching this line means the main bundle loaded successfully — clear
// the chunk-reload flag so a future post-deploy chunk-404 gets its
// own one-shot reload rather than being silently let through.
// See lazyWithReload in routes.tsx.
try { sessionStorage.removeItem('caw:chunk-reloaded') } catch {}

import { createRoot } from "react-dom/client";
import * as Sentry from '@sentry/react';

import "./index.css";
import "@rainbow-me/rainbowkit/styles.css";
import App from "./App.tsx";
import Web3Provider from "./config/Web3Provider";
import StateProvider from "./config/StateProvider.tsx";
import { QueryClient } from '@tanstack/react-query'

// staleTime tuned for L2 chain reads + API responses. wagmi's
// useReadContract uses this same client, so bumping staleTime cuts
// every duplicate eth_call across components. 5min covers a typical
// session of activity without making fresh data feel old; mutations
// still invalidate the right keys to refresh on demand.
//
// gcTime keeps cached values around for 30min so a return-trip to a
// page (e.g. /home → /caws/1 → /home) reuses the prior fetch.
//
// 30s was burning ~20× the RPC quota an actual user needs.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
      refetchOnReconnect: false,
    },
  },
});

// Diagnostic: count how often each query key fires. Enable from the
// browser console with `localStorage.cawRpcDebug = '1'` then refresh.
// Inspect with `__cawRpcCounts` (object keyed by query hash → fire
// count + last-fetched-at). Disable with `localStorage.removeItem`.
// No-op unless explicitly enabled, so production traffic is unaffected.
if (typeof window !== 'undefined' && localStorage.getItem('cawRpcDebug') === '1') {
  const counts: Record<string, { count: number; lastAt: number; key: any }> = {}
  ;(window as any).__cawRpcCounts = counts
  queryClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated') return
    const action = (event.action as any)?.type
    // 'fetch' fires when a query actually hits the network. (Cache
    // hits don't trigger this — exactly what we want for RPC accounting.)
    if (action !== 'fetch') return
    const hash = event.query.queryHash
    const existing = counts[hash]
    counts[hash] = {
      count: (existing?.count ?? 0) + 1,
      lastAt: Date.now(),
      key: event.query.queryKey,
    }
  })
  console.log('[CAW RPC Debug] enabled — top callers visible at window.__cawRpcCounts')
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<p>Something went wrong. The error has been reported.</p>}>
      <Web3Provider queryClient={queryClient}>
        <StateProvider>
          <App />
        </StateProvider>
      </Web3Provider>
    </Sentry.ErrorBoundary>
  </StrictMode>
);
