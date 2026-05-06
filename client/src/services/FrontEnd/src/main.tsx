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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,       // 30s before data is considered stale
      refetchOnWindowFocus: false, // don't refetch on tab switch
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
