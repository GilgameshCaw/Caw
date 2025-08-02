import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import "@rainbow-me/rainbowkit/styles.css";
import App from "./App.tsx";
import Web3Provider from "./config/Web3Provider";
import StateProvider from "./config/StateProvider.tsx";
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
const queryClient = new QueryClient();


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Web3Provider>
      <StateProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>,
      </StateProvider>
    </Web3Provider>
  </StrictMode>
);
