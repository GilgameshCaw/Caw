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
import { Navigate } from "react-router-dom";



export default [
  {
    path: "/",
    component: <Navigate to="/home" replace />,
  },
  {
    path: "/home",
    component: <Main />,
  },
  {
    path: "/explore",
    component: <ExplorePage />,
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
    path: "/staking/unstake",
    component: <Staking />,
  },
  {
    path: "/staking/info",
    component: <Staking />,
  },
  {
    path: "/mint",
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
    component: <NotificationsPage />,
  },
  {
    path: "/messages",
    component: <MessagesPage />,
  },
  {
    path: "/settings",
    component: <SettingsPage />,
  },
  {
    path: "/settings/muted",
    component: <MutedContentPage />,
  },
  {
    path: "/settings/notifications",
    component: <NotificationSettings />,
  },
  {
    path: "/settings/account",
    component: <AccountSettings />,
  },
  {
    path: "/settings/session-keys",
    component: <SessionKeySettings />,
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
    component: <BookmarksPage />,
  },
  {
    path: "/scheduled",
    component: <ScheduledPage />,
  },
  // {
  //   path: "/gamefi",
  //   component: <GameFiPage />,
  // },
  {
    path: "/search",
    component: <SearchResultsPage />,
  },
  {
    path: "/search/caws",
    component: <SearchResultsPage defaultTab="caws" />,
  },
  {
    path: "/search/users",
    component: <SearchResultsPage defaultTab="users" />,
  },
  {
    path: "/search/hashtags",
    component: <SearchResultsPage defaultTab="hashtags" />,
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
];
