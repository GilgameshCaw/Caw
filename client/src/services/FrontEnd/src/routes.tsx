import { Profile } from "./pages/Profile/Profile";
import { NewProfile } from "./pages/Profile/New";
import { PendingPage } from "./pages/Pending";
import { CawPage } from "./pages/CawPage";
import { Staking } from "./pages/Staking";
import { Main } from "./pages/Main";
import NotificationsPage from "./pages/NotificationsPage";
import { SettingsPage } from "./pages/Settings";
import MessagesPage from "./pages/Messages";
import BookmarksPage from "./pages/Bookmarks";
import ExplorePage from "./pages/Explore";
import GameFiPage from "./pages/GameFiPage";
import HashtagPage from "./pages/HashtagPage";
import SearchResultsPage from "./pages/SearchResultsPage";
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
    path: "/bookmarks",
    component: <BookmarksPage />,
  },
  {
    path: "/gamefi",
    component: <GameFiPage />,
  },
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
];
