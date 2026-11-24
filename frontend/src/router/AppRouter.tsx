import {
  Outlet,
  RouterProvider,
  Navigate,
  createRouter,
  createRoute,
  createRootRoute,
} from '@tanstack/react-router'
import { lazy, Suspense } from 'react';
import { Spinner } from '@/components/ui/spinner'
import AppShell from './AppShell';
import AdminGuard from './AdminGuard';
import SignedInGuard from './SignedInGuard';
import { HOME_PATH } from './routePaths';
import DashboardPage from '../pages/DashboardPage';
import GraphsPage from '../pages/GraphsPage';
import HomePage from '../pages/HomePage';
import UsersListPage from '../pages/UsersListPage';
import UserDetailPage from '../pages/UserDetailPage';
import StreamingPage from '../pages/StreamingPage';
import HistoryPage from '../pages/HistoryPage';
import InvitesPage from '../pages/InvitesPage';
import InviteWizardPage from '../pages/InviteWizardPage';
import InviteLandingPage from '../pages/InviteLandingPage';
import LoginPage from '../pages/LoginPage';
import ServersPage from '../pages/ServersPage';
import LibraryDetailPage from '../pages/LibraryDetailPage';
import ServerDetailPage from '../pages/ServerDetailPage';
import MediaDetailPage, { EpisodeDetailPage } from '../pages/MediaDetailPage';
import AdminSettingsAdminRolesPage from '../pages/AdminSettingsAdminRolesPage';
import AdminSettingsAdminRolesEditPage from '../pages/AdminSettingsAdminRolesEditPage';
import AdminSettingsUserRolesPage from '../pages/AdminSettingsUserRolesPage';
import AdminSettingsUserRolesEditPage from '../pages/AdminSettingsUserRolesEditPage';
import AdminSettingsGeneralPage from '../pages/AdminSettingsGeneralPage';
import AdminSettingsUserGeneralPage from '../pages/AdminSettingsUserGeneralPage';
import AdminSettingsAdminManagementPage from '../pages/AdminSettingsAdminManagementPage';
import AdminSettingsMediaServersPage from '../pages/AdminSettingsMediaServersPage';
import AdminSettingsMediaServicePage from '../pages/AdminSettingsMediaServicePage';
import { AdminSettingsMediaServerAddPage } from '../pages/AdminSettingsMediaServerAddPage';
import { AdminSettingsMediaServerEditPage } from '../pages/AdminSettingsMediaServerEditPage';
import AdminSettingsDiscordPage from '../pages/AdminSettingsDiscordPage';
import AdminSettingsAdvancedPage from '../pages/AdminSettingsAdvancedPage';
import AdminSettingsInfoPage from '../pages/AdminSettingsInfoPage';
import AdminSettingsApiDebugPage from '../pages/AdminSettingsApiDebugPage';
import AdminSettingsPage from '../pages/AdminSettingsPage';
import AdminNotificationsPage from '../pages/AdminNotificationsPage';
const ApiDocsPage = lazy(() => import('../pages/ApiDocsPage'));
import AccountPage from '../pages/AccountPage';
import SetupAccountPage from '../pages/SetupAccountPage';
import SetupAppConfigPage from '../pages/SetupAppConfigPage';
import SetupMediaServersPage from '../pages/SetupMediaServersPage';
import SetupMediaServicePage from '../pages/SetupMediaServicePage';
import SetupServerAddPage from '../pages/SetupServerAddPage';
import SetupFinishPage from '../pages/SetupFinishPage';

// Build TanStack Router route tree mirroring the previous React Router setup

// Root with outlet
const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

// Admin login route (actual admin login page)
const userLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: LoginPage,
  validateSearch: (search): { next?: string; error?: string; discord?: string } => {
    return {
      next: typeof search.next === 'string' ? (search.next as string) : undefined,
      error: typeof search.error === 'string' ? (search.error as string) : undefined,
      // The outcome of Sign in with Discord.
      discord: typeof search.discord === 'string' ? (search.discord as string) : undefined,
    }
  },
})

// Admin layout wrapped with guard
function AdminLayout() {
  return (
    <AdminGuard>
      <AppShell />
    </AdminGuard>
  )
}

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  component: AdminLayout,
})

const adminWildcardRedirect = createRoute({ getParentRoute: () => adminRoute, path: '$', component: () => <Navigate to={HOME_PATH} replace /> })

// Admin children
const adminIndexRedirect = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: () => <Navigate to="/admin/dashboard" replace />,
})
const adminDashboard = createRoute({ getParentRoute: () => adminRoute, path: 'dashboard', component: DashboardPage })
const adminGraphs = createRoute({ getParentRoute: () => adminRoute, path: 'graphs', component: GraphsPage })
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: 'home', component: () => <SignedInGuard><AppShell /></SignedInGuard> })
const homeIndex = createRoute({ getParentRoute: () => homeRoute, path: '/', component: HomePage })
const adminNotifications = createRoute({ getParentRoute: () => adminRoute, path: 'notifications', component: AdminNotificationsPage })
const adminAccountTabs = ['overview', 'credentials', 'linked-accounts', 'preferences'] as const
type AdminAccountTab = typeof adminAccountTabs[number]
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'account',
  component: () => <SignedInGuard><AppShell /></SignedInGuard>,
  validateSearch: (search): { tab?: AdminAccountTab; discord?: string } => {
    const tabVal = typeof search.tab === 'string' && (adminAccountTabs as readonly string[]).includes(search.tab)
      ? (search.tab as AdminAccountTab)
      : undefined
    // The outcome of linking Discord.
    return { tab: tabVal, discord: typeof search.discord === 'string' ? search.discord : undefined }
  },
})
const adminStreaming = createRoute({ getParentRoute: () => adminRoute, path: 'streaming', component: StreamingPage })
const adminHistory = createRoute({ getParentRoute: () => adminRoute, path: 'history', component: HistoryPage })
const adminUsers = createRoute({ getParentRoute: () => adminRoute, path: 'users', component: UsersListPage })
const userTabs = ['profile', 'history', 'settings', 'linked-accounts', 'overseerr', 'security'] as const
type UserTab = typeof userTabs[number]

const adminUserByUuid = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users/$uuid',
  component: UserDetailPage,
  validateSearch: (search): { tab?: UserTab } => {
    const tabVal = typeof search.tab === 'string' && (userTabs as readonly string[]).includes(search.tab)
      ? (search.tab as UserTab)
      : undefined
    return { tab: tabVal }
  },
})
const adminInvites = createRoute({ getParentRoute: () => adminRoute, path: 'invites', component: InvitesPage })
const adminServersList = createRoute({ getParentRoute: () => adminRoute, path: 'servers', component: ServersPage })
// A server's Overview, Users and Libraries are separate pages sharing the hero.
const adminServerDetail = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId', component: () => <ServerDetailPage section="overview" /> })
const adminServerUsers = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId/users', component: () => <ServerDetailPage section="users" /> })
const adminServerUserProfile = createRoute({
  getParentRoute: () => adminRoute,
  path: 'servers/$serverType/$serverId/users/$username',
  component: UserDetailPage,
  validateSearch: (search): { tab?: UserTab; id?: string } => {
    const tabVal = typeof search.tab === 'string' && (userTabs as readonly string[]).includes(search.tab)
      ? (search.tab as UserTab) : undefined
    return { tab: tabVal, id: typeof search.id === 'string' ? search.id : undefined }
  },
})
const adminServerLibraries = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId/libraries', component: () => <ServerDetailPage section="libraries" /> })
const adminServerGraphs = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId/graphs', component: () => <ServerDetailPage section="graphs" /> })
const adminServerHistory = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId/history', component: () => <ServerDetailPage section="history" /> })
const adminServerResources = createRoute({ getParentRoute: () => adminRoute, path: 'servers/$serverType/$serverId/resources', component: () => <ServerDetailPage section="resources" /> })
const adminLibraryDetail = createRoute({
  getParentRoute: () => adminRoute,
  // A library lives under its server: /admin/servers/<server>/libraries/<library>.
  path: 'servers/$serverType/$serverId/libraries/$libraryId',
  component: LibraryDetailPage,
  // Validate search param "tab" for stronger typing
  validateSearch: (search): { tab?: 'overview' | 'media' | 'collections' | 'stats' | 'activity' } => {
    const allowed = ['overview', 'media', 'collections', 'stats', 'activity'] as const
    const tabVal = typeof search.tab === 'string' && allowed.includes(search.tab as any) ? (search.tab as typeof allowed[number]) : undefined
    return { tab: tabVal }
  },
})
const mediaTabs = ['overview', 'episodes', 'tracks', 'activity'] as const
type MediaTab = typeof mediaTabs[number]
const adminMediaDetail = createRoute({
  getParentRoute: () => adminRoute,
  path: 'servers/$serverType/$serverId/libraries/$libraryId/$mediaId',
  component: MediaDetailPage,
  validateSearch: (search): { tab?: MediaTab } => {
    const tabVal = typeof search.tab === 'string' && (mediaTabs as readonly string[]).includes(search.tab)
      ? (search.tab as MediaTab)
      : undefined
    return { tab: tabVal }
  },
})
// An episode lives under its show: .../libraries/<library>/<show>/episodes/<episode>.
const episodeTabs = ['overview', 'activity'] as const
type EpisodeTab = typeof episodeTabs[number]
const adminEpisodeDetail = createRoute({
  getParentRoute: () => adminRoute,
  path: 'servers/$serverType/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId',
  component: EpisodeDetailPage,
  validateSearch: (search): { tab?: EpisodeTab } => {
    const tabVal = typeof search.tab === 'string' && (episodeTabs as readonly string[]).includes(search.tab)
      ? (search.tab as EpisodeTab)
      : undefined
    return { tab: tabVal }
  },
})
const adminSettings = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  component: AdminSettingsPage,
})
const adminSettingsGeneral = createRoute({ getParentRoute: () => adminRoute, path: 'settings/general', component: AdminSettingsGeneralPage })
const adminSettingsInfo = createRoute({ getParentRoute: () => adminRoute, path: 'settings/info', component: AdminSettingsInfoPage })
const adminAdminRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles', component: AdminSettingsAdminRolesPage })
const adminAdminRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles/$roleId/edit', component: AdminSettingsAdminRolesEditPage })
const adminUserRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles', component: AdminSettingsUserRolesPage })
const adminUserRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles/$roleId/edit', component: AdminSettingsUserRolesEditPage })
const adminMediaServers = createRoute({ getParentRoute: () => adminRoute, path: 'settings/media-servers', component: AdminSettingsMediaServersPage })
const adminMediaService = createRoute({ getParentRoute: () => adminRoute, path: 'settings/media-servers/$serviceId', component: AdminSettingsMediaServicePage })
const adminServerAdd = createRoute({ getParentRoute: () => adminRoute, path: 'settings/media-servers/$serviceId/servers/add', component: AdminSettingsMediaServerAddPage })
const adminServerEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/media-servers/$serviceId/servers/$serverId/edit', component: AdminSettingsMediaServerEditPage })
const adminDiscord = createRoute({ getParentRoute: () => adminRoute, path: 'settings/discord', component: AdminSettingsDiscordPage })
const adminAdvanced = createRoute({ getParentRoute: () => adminRoute, path: 'settings/advanced', component: AdminSettingsAdvancedPage })
const adminApiDebug = createRoute({ getParentRoute: () => adminRoute, path: 'settings/api-debug', component: AdminSettingsApiDebugPage })
const adminUsersGeneral = createRoute({ getParentRoute: () => adminRoute, path: 'settings/users/general', component: AdminSettingsUserGeneralPage })
const adminAdmins = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admins', component: AdminSettingsAdminManagementPage })
// API Docs is a standalone administrator page.
const adminApiDocsStandalone = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/api-docs',
  component: () => (
    <AdminGuard>
      <Suspense
        fallback={
          <div className="flex min-h-[50vh] items-center justify-center px-6 py-10 text-muted-foreground">
            <div className="flex items-center gap-3 text-base sm:text-lg">
              <Spinner className="size-5 sm:size-6 text-muted-foreground" />
              <span>Loading API docs...</span>
            </div>
          </div>
        }
      >
        <ApiDocsPage />
      </Suspense>
    </AdminGuard>
  ),
})

// Invite routes
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: 'invite' })
const inviteLanding = createRoute({ getParentRoute: () => inviteRoute, path: '/', component: InviteLandingPage })
const inviteWizard = createRoute({ getParentRoute: () => inviteRoute, path: '$token', component: InviteWizardPage })

const accountIndex = createRoute({ getParentRoute: () => accountRoute, path: '/', component: AccountPage })

// Setup UI
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: 'setup' })
const setupAccount = createRoute({ getParentRoute: () => setupRoute, path: 'account', component: SetupAccountPage })
const setupApp = createRoute({ getParentRoute: () => setupRoute, path: 'app', component: SetupAppConfigPage })
const setupMediaServers = createRoute({ getParentRoute: () => setupRoute, path: 'media-servers', component: SetupMediaServersPage })
const setupMediaService = createRoute({ getParentRoute: () => setupRoute, path: 'media-servers/$serviceId', component: SetupMediaServicePage })
const setupServerAdd = createRoute({ getParentRoute: () => setupRoute, path: 'media-servers/$serviceId/servers/add', component: SetupServerAddPage })
const setupFinish = createRoute({ getParentRoute: () => setupRoute, path: 'finish', component: SetupFinishPage })
const setupRootRedirect = createRoute({ getParentRoute: () => setupRoute, path: '/', component: () => <Navigate to="/setup/account" replace /> })
const setupWildcardRedirect = createRoute({ getParentRoute: () => setupRoute, path: '*', component: () => <Navigate to="/setup/account" replace /> })

// Root redirects
const rootIndexRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <Navigate to={HOME_PATH} replace /> })
const rootWildcardRedirect = createRoute({ getParentRoute: () => rootRoute, path: '$', component: () => <Navigate to={HOME_PATH} replace /> })

const routeTree = rootRoute.addChildren([
  userLoginRoute,
  homeRoute.addChildren([homeIndex]),
  accountRoute.addChildren([accountIndex]),
  adminRoute.addChildren([
    adminIndexRedirect,
    adminWildcardRedirect,
    adminDashboard,
    adminGraphs,
    adminNotifications,
    adminStreaming,
    adminHistory,
    adminUsers,
    adminUserByUuid,
    adminInvites,
    adminServersList,
    adminServerDetail,
    adminServerUsers,
    adminServerUserProfile,
    adminServerLibraries,
    adminServerGraphs,
    adminServerHistory,
    adminServerResources,
    adminLibraryDetail,
    adminMediaDetail,
    adminEpisodeDetail,
    adminSettings,
    adminSettingsGeneral,
    adminSettingsInfo,
    adminAdminRoles,
    adminAdminRoleEdit,
    adminUserRoles,
    adminUserRoleEdit,
    adminMediaServers,
    adminMediaService,
    adminServerAdd,
    adminServerEdit,
    adminDiscord,
    adminAdvanced,
    adminApiDebug,
    adminUsersGeneral,
    adminAdmins,
  ]),
  adminApiDocsStandalone,
  inviteRoute.addChildren([inviteLanding, inviteWizard]),
  setupRoute.addChildren([setupAccount, setupApp, setupMediaServers, setupMediaService, setupServerAdd, setupFinish, setupRootRedirect, setupWildcardRedirect]),
  rootIndexRedirect,
  rootWildcardRedirect,
])

const router = createRouter({
  routeTree,
  // Keep '+' characters unencoded in path params (e.g., server nicknames like 'Kavita++')
  pathParamsAllowedCharacters: ['+'],
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
  interface HistoryState {
    from?: string
    userUuid?: string
  }
}

export const AppRouter = () => <RouterProvider router={router} />

export default AppRouter;
