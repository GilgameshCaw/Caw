import { BrowserRouter, Route, Routes } from "react-router";
import { useCawonceSync } from '~/hooks/useCawonce'
import { useAccount } from "wagmi"
import routes from "./routes";

function App() {
  useCawonceSync();
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
