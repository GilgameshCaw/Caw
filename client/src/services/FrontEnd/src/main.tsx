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
