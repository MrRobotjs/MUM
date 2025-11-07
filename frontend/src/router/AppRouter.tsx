import {
  Outlet,
  RouterProvider,
  Navigate,
  createRouter,
  createRoute,
  createRootRoute,
} from '@tanstack/react-router'
import AdminShell from './AdminShell';
import AdminGuard from './AdminGuard';
import DashboardPage from '../pages/DashboardPage';
import UsersListPage from '../pages/UsersListPage';
import UserDetailPage from '../pages/UserDetailPage';
import StreamingPage from '../pages/StreamingPage';
import InvitesPage from '../pages/InvitesPage';
import InviteWizardPage from '../pages/InviteWizardPage';
import InviteLandingPage from '../pages/InviteLandingPage';
import LoginPage from '../pages/LoginPage';
import UserLoginPage from '../pages/UserLoginPage';
import LibrariesPage from '../pages/LibrariesPage';
import LibraryDetailPage from '../pages/LibraryDetailPage';
import MediaDetailPage from '../pages/MediaDetailPage';
import AdminRolesPage from '../pages/AdminRolesPage';
import AdminRoleEditPage from '../pages/AdminRoleEditPage';
import UserRolesPage from '../pages/UserRolesPage';
import UserRoleEditPage from '../pages/UserRoleEditPage';
import GeneralSettingsPage from '../pages/GeneralSettingsPage';
import UserSettingsGeneralPage from '../pages/UserSettingsGeneralPage';
import AdminsSettingsPage from '../pages/AdminsSettingsPage';
import PluginsPage from '../pages/PluginsPage';
import PluginDetailPage from '../pages/PluginDetailPage';
import { ServerEditPage } from '../pages/ServerEditPage';
import DiscordSettingsPage from '../pages/DiscordSettingsPage';
import AdvancedSettingsPage from '../pages/AdvancedSettingsPage';
import LogsPage from '../pages/LogsPage';
import ApiDebugPage from '../pages/ApiDebugPage';
import ApiDocsPage from '../pages/ApiDocsPage';
import AdminAccountPage from '../pages/AdminAccountPage';
import UserDashboardPage from '../pages/UserDashboardPage';
import SetupAccountPage from '../pages/SetupAccountPage';
import SetupAppConfigPage from '../pages/SetupAppConfigPage';
import SetupPluginsPage from '../pages/SetupPluginsPage';
import SetupDiscordPage from '../pages/SetupDiscordPage';

// Build TanStack Router route tree mirroring the previous React Router setup

// Root with outlet
const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

// Auth routes
const authRoute = createRoute({ getParentRoute: () => rootRoute, path: 'auth' })
const authLoginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: 'login',
  component: LoginPage,
})
const authAdminLoginRoute = createRoute({
  getParentRoute: () => authRoute,
  path: 'admin_login',
  component: LoginPage,
})

// User login route (regular user portal)
const userLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: UserLoginPage,
})

// Admin login route (actual admin login page)
const adminLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/login',
  component: LoginPage,
})

// Legacy auth/login route (redirects to admin/login for backwards compatibility)
const authLoginRedirectRoute = createRoute({
  getParentRoute: () => authRoute,
  path: 'login',
  component: () => <Navigate to="/admin/login" replace />,
})

// Admin layout wrapped with guard
function AdminLayout() {
  return (
    <AdminGuard>
      <AdminShell />
    </AdminGuard>
  )
}

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  component: AdminLayout,
})

// Admin children
const adminIndexRedirect = createRoute({
  getParentRoute: () => adminRoute,
  path: '/',
  component: () => <Navigate to="/admin/dashboard" replace />,
})
const adminDashboard = createRoute({ getParentRoute: () => adminRoute, path: 'dashboard', component: DashboardPage })
const adminAccountTabs = ['overview', 'credentials', 'preferences'] as const
type AdminAccountTab = typeof adminAccountTabs[number]
const adminAccount = createRoute({
  getParentRoute: () => adminRoute,
  path: 'account',
  component: AdminAccountPage,
  validateSearch: (search) => {
    const tabVal = typeof search.tab === 'string' && (adminAccountTabs as readonly string[]).includes(search.tab)
      ? (search.tab as AdminAccountTab)
      : undefined
    return { tab: tabVal }
  },
})
const adminStreaming = createRoute({ getParentRoute: () => adminRoute, path: 'streaming', component: StreamingPage })
const adminUsers = createRoute({ getParentRoute: () => adminRoute, path: 'users', component: UsersListPage })
const userTabs = ['profile', 'history', 'settings', 'overseerr', 'security'] as const
type UserTab = typeof userTabs[number]

const adminUserByNick = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users/$serverNickname/$username',
  component: UserDetailPage,
  validateSearch: (search) => {
    const tabVal = typeof search.tab === 'string' && (userTabs as readonly string[]).includes(search.tab)
      ? (search.tab as UserTab)
      : undefined
    return { tab: tabVal }
  },
})
const adminUserByUuid = createRoute({
  getParentRoute: () => adminRoute,
  path: 'users/$uuid',
  component: UserDetailPage,
  validateSearch: (search) => {
    const tabVal = typeof search.tab === 'string' && (userTabs as readonly string[]).includes(search.tab)
      ? (search.tab as UserTab)
      : undefined
    return { tab: tabVal }
  },
})
const adminInvites = createRoute({ getParentRoute: () => adminRoute, path: 'invites', component: InvitesPage })
const adminLibraries = createRoute({ getParentRoute: () => adminRoute, path: 'libraries', component: LibrariesPage })
const adminLibraryDetail = createRoute({
  getParentRoute: () => adminRoute,
  path: 'libraries/$libraryId',
  component: LibraryDetailPage,
  // Validate search param "tab" for stronger typing
  validateSearch: (search) => {
    const allowed = ['overview', 'media', 'collections', 'stats', 'activity'] as const
    const tabVal = typeof search.tab === 'string' && allowed.includes(search.tab as any) ? (search.tab as typeof allowed[number]) : undefined
    return { tab: tabVal }
  },
})
const adminMediaDetail = createRoute({ getParentRoute: () => adminRoute, path: 'libraries/$libraryId/$mediaId', component: MediaDetailPage })
const adminSettingsRedirect = createRoute({
  getParentRoute: () => adminRoute,
  path: 'settings',
  component: () => <Navigate to="/admin/settings/general" replace />,
})
const adminSettingsGeneral = createRoute({ getParentRoute: () => adminRoute, path: 'settings/general', component: GeneralSettingsPage })
const adminAdminRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles', component: AdminRolesPage })
const adminAdminRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles/$roleId/edit', component: AdminRoleEditPage })
const adminUserRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles', component: UserRolesPage })
const adminUserRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles/$roleId/edit', component: UserRoleEditPage })
const adminPlugins = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins', component: PluginsPage })
const adminPluginDetail = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins/$pluginId', component: PluginDetailPage })
const adminServerEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins/$pluginId/servers/$serverId', component: ServerEditPage })
const adminDiscord = createRoute({ getParentRoute: () => adminRoute, path: 'settings/discord', component: DiscordSettingsPage })
const adminAdvanced = createRoute({ getParentRoute: () => adminRoute, path: 'settings/advanced', component: AdvancedSettingsPage })
const adminLogs = createRoute({ getParentRoute: () => adminRoute, path: 'settings/logs', component: LogsPage })
const adminApiDebug = createRoute({ getParentRoute: () => adminRoute, path: 'settings/api-debug', component: ApiDebugPage })
const adminUsersGeneral = createRoute({ getParentRoute: () => adminRoute, path: 'settings/users/general', component: UserSettingsGeneralPage })
const adminAdmins = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admins', component: AdminsSettingsPage })
// API Docs should be a standalone page, not wrapped in the admin app layout
const apiDocsStandalone = createRoute({
  getParentRoute: () => rootRoute,
  path: 'api-docs',
  component: () => (
    <AdminGuard>
      <ApiDocsPage />
    </AdminGuard>
  ),
})

// Legacy/admin-prefixed path so servers that serve SPA under /admin/* will still resolve
const adminApiDocsStandalone = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/api-docs',
  component: () => (
    <AdminGuard>
      <ApiDocsPage />
    </AdminGuard>
  ),
})

// Invite routes
const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: 'invite' })
const inviteLanding = createRoute({ getParentRoute: () => inviteRoute, path: '/', component: InviteLandingPage })
const inviteWizard = createRoute({ getParentRoute: () => inviteRoute, path: '$token', component: InviteWizardPage })

// User portal
const userRoute = createRoute({ getParentRoute: () => rootRoute, path: 'user' })
const userIndex = createRoute({ getParentRoute: () => userRoute, path: '/', component: UserDashboardPage })
const userDashboard = createRoute({ getParentRoute: () => userRoute, path: 'dashboard', component: UserDashboardPage })

// Setup UI
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: 'setup' })
const setupUIRoute = createRoute({ getParentRoute: () => setupRoute, path: 'ui' })
const setupAccount = createRoute({ getParentRoute: () => setupUIRoute, path: 'account', component: SetupAccountPage })
const setupApp = createRoute({ getParentRoute: () => setupUIRoute, path: 'app', component: SetupAppConfigPage })
const setupPlugins = createRoute({ getParentRoute: () => setupUIRoute, path: 'plugins', component: SetupPluginsPage })
const setupDiscord = createRoute({ getParentRoute: () => setupUIRoute, path: 'discord', component: SetupDiscordPage })
const setupRootRedirect = createRoute({ getParentRoute: () => setupRoute, path: '/', component: () => <Navigate to="/setup/ui/account" replace /> })
const setupWildcardRedirect = createRoute({ getParentRoute: () => setupRoute, path: '*', component: () => <Navigate to="/setup/ui/account" replace /> })

// Root redirects
const rootIndexRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <Navigate to="/admin/dashboard" replace /> })
const rootWildcardRedirect = createRoute({ getParentRoute: () => rootRoute, path: '*', component: () => <Navigate to="/admin/dashboard" replace /> })

const routeTree = rootRoute.addChildren([
  authRoute.addChildren([authLoginRedirectRoute, authAdminLoginRoute]),
  userLoginRoute,
  adminLoginRoute,
  adminRoute.addChildren([
    adminIndexRedirect,
    adminDashboard,
    adminAccount,
    adminStreaming,
    adminUsers,
    adminUserByNick,
    adminUserByUuid,
    adminInvites,
    adminLibraries,
    adminLibraryDetail,
    adminMediaDetail,
    adminSettingsRedirect,
    adminSettingsGeneral,
    adminAdminRoles,
    adminAdminRoleEdit,
    adminUserRoles,
    adminUserRoleEdit,
    adminPlugins,
    adminPluginDetail,
    adminServerEdit,
    adminDiscord,
    adminAdvanced,
    adminLogs,
    adminApiDebug,
    adminUsersGeneral,
    adminAdmins,
  ]),
  apiDocsStandalone,
  adminApiDocsStandalone,
  inviteRoute.addChildren([inviteLanding, inviteWizard]),
  userRoute.addChildren([userIndex, userDashboard]),
  setupRoute.addChildren([
    setupUIRoute.addChildren([setupAccount, setupApp, setupPlugins, setupDiscord]),
    setupRootRedirect,
    setupWildcardRedirect,
  ]),
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
}

export const AppRouter = () => <RouterProvider router={router} />

export default AppRouter;
