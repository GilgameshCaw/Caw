import './utils/polyfills';
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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
    <Web3Provider queryClient={queryClient}>
      <StateProvider>
        <App />
      </StateProvider>
    </Web3Provider>
  </StrictMode>
);
