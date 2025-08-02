import { Profile } from "./pages/Profile/Profile";
import { NewProfile } from "./pages/Profile/New";
import { PendingPage } from "./pages/Pending";
import { CawPage } from "./pages/CawPage";
import { Staking } from "./pages/Staking";
import { Main } from "./pages/Main";

export default [
  {
    path: "/home",
    component: <Main />,
  },
  {
    path: "/pending",
    component: <PendingPage />,
  },
  {
    path: "/staking",
    component: <Staking />,
  },
  {
    path: "/mint",
    component: <NewProfile />,
  },
  {
    path: "/users/:username",
    component: <Profile />,
  },
  {
    path: "/caws/:id",
    component: <CawPage />,
  },
];
