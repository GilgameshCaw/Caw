import { BrowserRouter, Route, Routes } from "react-router";
import { useCawonceSync } from '~/hooks/useCawonce'
import { useTxQueueMonitor } from '~/hooks/useTxQueueMonitor'
import { useClientConfig } from '~/store/clientConfigStore'
import { CLIENT_ID } from '~/api/actions'
import { useAccount } from "wagmi"
import routes from "./routes";

function App() {
  useCawonceSync();
  useTxQueueMonitor();
  useClientConfig(CLIENT_ID); // Fetch client config on init for dynamic tip calculation

  return (
    <BrowserRouter>
      <Routes>
        {routes.map((route) => (
          <Route key={route.path} path={route.path} element={route.component} />
        ))}
      </Routes>
    </BrowserRouter>
  );
}

export default App;
