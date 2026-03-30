import { Profile } from "./pages/Profile/Profile";
import { NewProfile } from "./pages/Profile/New";
import { PendingPage } from "./pages/Pending";
import { CawPage } from "./pages/CawPage";
import { Staking } from "./pages/Staking";
import { Main } from "./pages/Main";
import NotificationsPage from "./pages/NotificationsPage";
import { SettingsPage } from "./pages/Settings";
import MutedContentPage from "./pages/MutedContent";
import NotificationSettings from "./pages/NotificationSettings";
import AccountSettings from "./pages/AccountSettings";
import SessionKeySettings from "./pages/SessionKeySettings";
import HelpPage from "./pages/HelpPage";
import MessagesPage from "./pages/Messages";
import BookmarksPage from "./pages/Bookmarks";
import ExplorePage from "./pages/Explore";
import ScheduledPage from "./pages/Scheduled";
// import GameFiPage from "./pages/GameFiPage";
import HashtagPage from "./pages/HashtagPage";
import SearchResultsPage from "./pages/SearchResultsPage";
import FaucetPage from "./pages/FaucetPage";
import BugReportsAdmin from "./pages/BugReportsAdmin";
import ReportsAdmin from "./pages/ReportsAdmin";
import ValidatorAnalytics from "./pages/ValidatorAnalytics";
import ValidatorSettings from "./pages/ValidatorSettings";
import WelcomePage from "./pages/WelcomePage";
import Marketplace from "./pages/Marketplace";
import CaptiveSplash from "./pages/CaptiveSplash";
import AuthGate from "./components/AuthGate";
import { Navigate } from "react-router-dom";



export default [
  {
    path: "/",
    component: <Navigate to="/home" replace />,
  },
  // Captive splash for unauthenticated users
  {
    path: "/welcome",
    component: <CaptiveSplash />,
  },
  // Protected routes — redirect to /welcome if no username
  {
    path: "/home",
    component: <AuthGate><Main /></AuthGate>,
  },
  {
    path: "/explore",
    component: <AuthGate><ExplorePage /></AuthGate>,
  },
  {
    path: "/pending",
    component: <AuthGate><PendingPage /></AuthGate>,
  },
  {
    path: "/staking",
    component: <AuthGate><Staking /></AuthGate>,
  },
  {
    path: "/staking/unstake",
    component: <AuthGate><Staking /></AuthGate>,
  },
  {
    path: "/staking/info",
    component: <AuthGate><Staking /></AuthGate>,
  },
  {
    path: "/usernames",
    component: <Marketplace />,
  },
  {
    path: "/usernames/new",
    component: <NewProfile />,
  },
  {
    path: "/profile",
    component: <Profile />,
  },
  {
    path: "/users/:username",
    component: <Profile />,
  },
  {
    path: "/caws/:id",
    component: <CawPage />,
  },
  {
    path: "/hashtags/:hashtag",
    component: <HashtagPage />,
  },
  {
    path: "/notifications",
    component: <AuthGate><NotificationsPage /></AuthGate>,
  },
  {
    path: "/messages",
    component: <AuthGate><MessagesPage /></AuthGate>,
  },
  {
    path: "/messages/:username",
    component: <AuthGate><MessagesPage /></AuthGate>,
  },
  {
    path: "/settings",
    component: <AuthGate><SettingsPage /></AuthGate>,
  },
  {
    path: "/settings/muted",
    component: <AuthGate><MutedContentPage /></AuthGate>,
  },
  {
    path: "/settings/notifications",
    component: <AuthGate><NotificationSettings /></AuthGate>,
  },
  {
    path: "/settings/account",
    component: <AuthGate><AccountSettings /></AuthGate>,
  },
  {
    path: "/settings/session-keys",
    component: <AuthGate><SessionKeySettings /></AuthGate>,
  },
  {
    path: "/help",
    component: <HelpPage />,
  },
  {
    path: "/help/faq",
    component: <HelpPage defaultTab="faq" />,
  },
  {
    path: "/help/history",
    component: <HelpPage defaultTab="history" />,
  },
  {
    path: "/help/manifesto",
    component: <HelpPage defaultTab="manifesto" />,
  },
  {
    path: "/help/howto",
    component: <HelpPage defaultTab="howto" />,
  },
  {
    path: "/help/developers",
    component: <HelpPage defaultTab="developers" />,
  },
  {
    path: "/help/resources",
    component: <HelpPage defaultTab="resources" />,
  },
  {
    path: "/bookmarks",
    component: <AuthGate><BookmarksPage /></AuthGate>,
  },
  {
    path: "/scheduled",
    component: <AuthGate><ScheduledPage /></AuthGate>,
  },
  // {
  //   path: "/gamefi",
  //   component: <GameFiPage />,
  // },
  {
    path: "/search",
    component: <AuthGate><SearchResultsPage /></AuthGate>,
  },
  {
    path: "/search/caws",
    component: <AuthGate><SearchResultsPage defaultTab="caws" /></AuthGate>,
  },
  {
    path: "/search/users",
    component: <AuthGate><SearchResultsPage defaultTab="users" /></AuthGate>,
  },
  {
    path: "/search/hashtags",
    component: <AuthGate><SearchResultsPage defaultTab="hashtags" /></AuthGate>,
  },
  {
    path: "/faucet",
    component: <FaucetPage />,
  },
  {
    path: "/admin/bugs",
    component: <BugReportsAdmin />,
  },
  {
    path: "/admin/reports",
    component: <ReportsAdmin />,
  },
  {
    path: "/admin/validator",
    component: <ValidatorAnalytics />,
  },
  {
    path: "/admin/validator/settings",
    component: <ValidatorSettings />,
  },
  {
    path: "/welcome/:username",
    component: <WelcomePage />,
  },
];
