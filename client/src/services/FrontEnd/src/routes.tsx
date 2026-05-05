import { lazy } from "react";
import { Navigate } from "react-router-dom";

// Critical-path pages stay eagerly imported. Everything below this block
// is `React.lazy` so it splits into its own chunk and is fetched only
// when the route is visited. The router renders these inside a
// <Suspense> boundary in App.tsx, so navigation shows a one-frame blank
// fallback while the chunk fetches.
//
// Eager: Main (post-auth landing), Pending (early-load fallback), Profile
// (most-trafficked deep-link from external links), CawPage (every
// /caws/:id share link), CaptiveSplash (pre-auth landing).
import { Main } from "./pages/Main";
import { PendingPage } from "./pages/Pending";
import { Profile } from "./pages/Profile/Profile";
import { CawPage } from "./pages/CawPage";
import CaptiveSplash from "./pages/CaptiveSplash";
import AuthGate from "./components/AuthGate";
import AdminGate from "./components/AdminGate";

// Lazy. Each line below produces a separate chunk named after the
// imported file's basename, so dist/ stays legible
// (Marketplace-<hash>.js, Messages-<hash>.js, etc.). The two `.then`
// adapters below convert named exports to React.lazy's required
// `{ default }` shape.
const NewProfile = lazy(() => import("./pages/Profile/New"));
const Staking = lazy(() => import("./pages/Staking").then(m => ({ default: m.Staking })));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const SettingsPage = lazy(() => import("./pages/Settings").then(m => ({ default: m.SettingsPage })));
const MutedContentPage = lazy(() => import("./pages/MutedContent"));
const NotificationSettings = lazy(() => import("./pages/NotificationSettings"));
const LanguageSettings = lazy(() => import("./pages/LanguageSettings"));
const AccountSettings = lazy(() => import("./pages/AccountSettings"));
const SessionKeySettings = lazy(() => import("./pages/SessionKeySettings"));
const HelpPage = lazy(() => import("./pages/HelpPage"));
const MessagesPage = lazy(() => import("./pages/Messages"));
const BookmarksPage = lazy(() => import("./pages/Bookmarks"));
const ExplorePage = lazy(() => import("./pages/Explore"));
const ScheduledPage = lazy(() => import("./pages/Scheduled"));
const HashtagPage = lazy(() => import("./pages/HashtagPage"));
const SearchResultsPage = lazy(() => import("./pages/SearchResultsPage"));
const FaucetPage = lazy(() => import("./pages/FaucetPage"));
const CawActivity = lazy(() => import("./pages/CawActivity"));
const BugReportsAdmin = lazy(() => import("./pages/BugReportsAdmin"));
const ReportsAdmin = lazy(() => import("./pages/ReportsAdmin"));
const ValidatorAnalytics = lazy(() => import("./pages/ValidatorAnalytics"));
const ValidatorSettings = lazy(() => import("./pages/ValidatorSettings"));
const DatabaseAdmin = lazy(() => import("./pages/DatabaseAdmin"));
const Admin = lazy(() => import("./pages/Admin"));
const WelcomePage = lazy(() => import("./pages/WelcomePage"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const AddressTokens = lazy(() => import("./pages/AddressTokens"));

// Routes are split into two groups so `<MainLayout>` can be hoisted to a
// single shared parent route. The layout stays mounted across navigation
// between layoutRoutes — Sidebar / ProfileChooser / Avatar no longer
// remount, killing the brief avatar-flash on every nav. Bare routes
// (captive splash, welcome, admin shell) render outside the layout.
//
// Transient per-page chrome suppression (e.g. /usernames/new mid-mint)
// is done via useLayoutStore, not route handles — <BrowserRouter> isn't
// a data router so useMatches() can't be used inside MainLayout.

export interface RouteDef {
  path: string;
  component: React.ReactNode;
}

export const layoutRoutes: RouteDef[] = [
  { path: "/", component: <Navigate to="/home" replace /> },
  { path: "/home", component: <AuthGate><Main /></AuthGate> },
  { path: "/explore", component: <AuthGate><ExplorePage /></AuthGate> },
  { path: "/pending", component: <AuthGate><PendingPage /></AuthGate> },
  { path: "/staking", component: <AuthGate><Staking /></AuthGate> },
  { path: "/staking/activity", component: <AuthGate><CawActivity /></AuthGate> },
  { path: "/staking/unstake", component: <AuthGate><Staking /></AuthGate> },
  { path: "/staking/info", component: <AuthGate><Staking /></AuthGate> },
  { path: "/usernames", component: <Marketplace /> },
  // /usernames/new doesn't pin handle.hideSidebars — captive users hit
  // the path-based hideSidebars in MainLayout, and the post-mint
  // "creating profile…" fullscreen takeover uses useLayoutStore to flip
  // the chrome off transiently.
  { path: "/usernames/new", component: <NewProfile /> },
  { path: "/profile", component: <Profile /> },
  { path: "/users/:username", component: <Profile /> },
  { path: "/users/:username/activity", component: <CawActivity /> },
  { path: "/address/:address", component: <AddressTokens /> },
  { path: "/caws/:id", component: <CawPage /> },
  { path: "/hashtags/:hashtag", component: <HashtagPage /> },
  { path: "/notifications", component: <AuthGate><NotificationsPage /></AuthGate> },
  { path: "/messages", component: <AuthGate><MessagesPage /></AuthGate> },
  { path: "/messages/:username", component: <AuthGate><MessagesPage /></AuthGate> },
  { path: "/settings", component: <AuthGate><SettingsPage /></AuthGate> },
  { path: "/settings/muted", component: <AuthGate><MutedContentPage /></AuthGate> },
  { path: "/settings/notifications", component: <AuthGate><NotificationSettings /></AuthGate> },
  { path: "/settings/language", component: <AuthGate><LanguageSettings /></AuthGate> },
  { path: "/settings/account", component: <AuthGate><AccountSettings /></AuthGate> },
  { path: "/settings/session-keys", component: <AuthGate><SessionKeySettings /></AuthGate> },
  { path: "/help", component: <HelpPage /> },
  { path: "/help/faq", component: <HelpPage defaultTab="faq" /> },
  { path: "/help/history", component: <HelpPage defaultTab="history" /> },
  { path: "/help/manifesto", component: <HelpPage defaultTab="manifesto" /> },
  { path: "/help/howto", component: <HelpPage defaultTab="gettingstarted" /> },
  { path: "/help/gettingstarted", component: <HelpPage defaultTab="gettingstarted" /> },
  { path: "/help/developers", component: <HelpPage defaultTab="developers" /> },
  { path: "/help/resources", component: <HelpPage defaultTab="resources" /> },
  { path: "/bookmarks", component: <AuthGate><BookmarksPage /></AuthGate> },
  { path: "/scheduled", component: <AuthGate><ScheduledPage /></AuthGate> },
  // { path: "/gamefi", component: <GameFiPage /> },
  { path: "/search", component: <AuthGate><SearchResultsPage /></AuthGate> },
  { path: "/search/caws", component: <AuthGate><SearchResultsPage defaultTab="caws" /></AuthGate> },
  { path: "/search/users", component: <AuthGate><SearchResultsPage defaultTab="users" /></AuthGate> },
  { path: "/search/hashtags", component: <AuthGate><SearchResultsPage defaultTab="hashtags" /></AuthGate> },
  { path: "/faucet", component: <FaucetPage /> },
];

// Routes that render WITHOUT MainLayout: pre-auth captive splash, the
// welcome screen, admin shells. These never had MainLayout pre-hoist.
export const bareRoutes: RouteDef[] = [
  { path: "/welcome", component: <CaptiveSplash /> },
  { path: "/welcome/:username", component: <WelcomePage /> },
  { path: "/admin", component: <AdminGate><Admin /></AdminGate> },
  { path: "/admin/bugs", component: <AdminGate><BugReportsAdmin /></AdminGate> },
  { path: "/admin/reports", component: <AdminGate><ReportsAdmin /></AdminGate> },
  { path: "/admin/validator", component: <AdminGate><ValidatorAnalytics /></AdminGate> },
  { path: "/admin/validator/settings", component: <AdminGate><ValidatorSettings /></AdminGate> },
  { path: "/admin/database", component: <AdminGate><DatabaseAdmin /></AdminGate> },
];

// Back-compat default export — old shape, all routes flat. Kept so any
// straggling consumer still resolves. New code should import the named
// groups above.
export default [...layoutRoutes, ...bareRoutes];
