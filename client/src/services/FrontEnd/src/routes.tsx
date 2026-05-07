import { lazy, type ComponentType } from "react";
import { Navigate } from "react-router-dom";

// Reload-on-chunk-404 wrapper around React.lazy.
//
// After a deploy, Vite emits new hash-named chunks and the old ones 404.
// A still-loaded tab navigating to a lazy page tries to fetch the old
// chunk, the dynamic import rejects, and the app's top-level Sentry
// boundary catches it as "Something went wrong. The error has been
// reported." — confusing for users and noisy in Sentry.
//
// First failure: we set a sessionStorage flag and reload(). The new
// bundle takes over and the user lands on the page they wanted (router
// state survives reload). If we've ALREADY reloaded once and the chunk
// STILL fails (real outage, blocked by extension, etc.), we let the
// error propagate so Sentry reports a real bug instead of looping.
const RELOADED_KEY = 'caw:chunk-reloaded'
function lazyWithReload<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>
): ReturnType<typeof lazy<T>> {
  return lazy(() =>
    loader().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      const isChunkError = /Failed to fetch dynamically imported module|Loading chunk|ChunkLoadError|error loading dynamically imported module/i.test(msg)
      if (isChunkError && !sessionStorage.getItem(RELOADED_KEY)) {
        sessionStorage.setItem(RELOADED_KEY, '1')
        window.location.reload()
        // Return a never-resolving promise so React stays in <Suspense>
        // until the reload kicks in.
        return new Promise<never>(() => {})
      }
      throw err
    })
  )
}

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
import ModeratorGate from "./components/ModeratorGate";

// Lazy. Each line below produces a separate chunk named after the
// imported file's basename, so dist/ stays legible
// (Marketplace-<hash>.js, Messages-<hash>.js, etc.). The two `.then`
// adapters below convert named exports to React.lazy's required
// `{ default }` shape.
const NewProfile = lazyWithReload(() => import("./pages/Profile/New"));
const Staking = lazyWithReload(() => import("./pages/Staking").then(m => ({ default: m.Staking })));
const NotificationsPage = lazyWithReload(() => import("./pages/NotificationsPage"));
const SettingsPage = lazyWithReload(() => import("./pages/Settings").then(m => ({ default: m.SettingsPage })));
const MutedContentPage = lazyWithReload(() => import("./pages/MutedContent"));
const NotificationSettings = lazyWithReload(() => import("./pages/NotificationSettings"));
const LanguageSettings = lazyWithReload(() => import("./pages/LanguageSettings"));
const AccountSettings = lazyWithReload(() => import("./pages/AccountSettings"));
const SessionKeySettings = lazyWithReload(() => import("./pages/SessionKeySettings"));
const HelpPage = lazyWithReload(() => import("./pages/HelpPage"));
const MessagesPage = lazyWithReload(() => import("./pages/Messages"));
const InviteRedeemPage = lazyWithReload(() => import("./pages/InviteRedeemPage"));
const BookmarksPage = lazyWithReload(() => import("./pages/Bookmarks"));
const ExplorePage = lazyWithReload(() => import("./pages/Explore"));
const ScheduledPage = lazyWithReload(() => import("./pages/Scheduled"));
const HashtagPage = lazyWithReload(() => import("./pages/HashtagPage"));
const SearchResultsPage = lazyWithReload(() => import("./pages/SearchResultsPage"));
const FaucetPage = lazyWithReload(() => import("./pages/FaucetPage"));
const CawActivity = lazyWithReload(() => import("./pages/CawActivity"));
const BugReportsAdmin = lazyWithReload(() => import("./pages/BugReportsAdmin"));
const ReportsAdmin = lazyWithReload(() => import("./pages/ReportsAdmin"));
const ValidatorAnalytics = lazyWithReload(() => import("./pages/ValidatorAnalytics"));
const ValidatorSettings = lazyWithReload(() => import("./pages/ValidatorSettings"));
const DatabaseAdmin = lazyWithReload(() => import("./pages/DatabaseAdmin"));
const ModeratorsAdmin = lazyWithReload(() => import("./pages/ModeratorsAdmin"));
const Admin = lazyWithReload(() => import("./pages/Admin"));
const WelcomePage = lazyWithReload(() => import("./pages/WelcomePage"));
const Marketplace = lazyWithReload(() => import("./pages/Marketplace"));
const AddressTokens = lazyWithReload(() => import("./pages/AddressTokens"));

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
  { path: "/dm/invite/:token", component: <AuthGate><InviteRedeemPage /></AuthGate> },
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
  { path: "/admin/moderators", component: <AdminGate><ModeratorsAdmin /></AdminGate> },
  // Moderator-tier mirrors of the admin moderation pages. Same components,
  // wallet-session-gated instead of admin-cookie-gated. Admins land here too
  // because requireModerator accepts the admin cookie as a superset.
  { path: "/moderation/bugs", component: <ModeratorGate><BugReportsAdmin /></ModeratorGate> },
  { path: "/moderation/reports", component: <ModeratorGate><ReportsAdmin /></ModeratorGate> },
];

// Back-compat default export — old shape, all routes flat. Kept so any
// straggling consumer still resolves. New code should import the named
// groups above.
export default [...layoutRoutes, ...bareRoutes];
