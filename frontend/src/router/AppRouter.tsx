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
import AdminSettingsAdminRolesPage from '../pages/AdminSettingsAdminRolesPage';
import AdminSettingsAdminRolesEditPage from '../pages/AdminSettingsAdminRolesEditPage';
import AdminSettingsUserRolesPage from '../pages/AdminSettingsUserRolesPage';
import AdminSettingsUserRolesEditPage from '../pages/AdminSettingsUserRolesEditPage';
import AdminSettingsGeneralPage from '../pages/AdminSettingsGeneralPage';
import AdminSettingsUserGeneralPage from '../pages/AdminSettingsUserGeneralPage';
import AdminSettingsAdminManagementPage from '../pages/AdminSettingsAdminManagementPage';
import AdminSettingsPluginsPage from '../pages/AdminSettingsPluginsPage';
import AdminSettingsPluginsDetailPage from '../pages/AdminSettingsPluginsDetailPage';
import { AdminSettingsPluginsServerAddPage } from '../pages/AdminSettingsPluginsServerAddPage';
import { AdminSettingsPluginsServerEditPage } from '../pages/AdminSettingsPluginsServerEditPage';
import AdminSettingsDiscordPage from '../pages/AdminSettingsDiscordPage';
import AdminSettingsAdvancedPage from '../pages/AdminSettingsAdvancedPage';
import AdminSettingsLogsPage from '../pages/AdminSettingsLogsPage';
import AdminSettingsApiDebugPage from '../pages/AdminSettingsApiDebugPage';
import AdminSettingsPage from '../pages/AdminSettingsPage';
import AdminNotificationsPage from '../pages/AdminNotificationsPage';
import ApiDocsPage from '../pages/ApiDocsPage';
import AdminAccountPage from '../pages/AdminAccountPage';
import UserDashboardPage from '../pages/UserDashboardPage';
import SetupAccountPage from '../pages/SetupAccountPage';
import SetupAppConfigPage from '../pages/SetupAppConfigPage';
import SetupPluginsPage from '../pages/SetupPluginsPage';
import SetupPluginConfigPage from '../pages/SetupPluginConfigPage';
import SetupServerAddPage from '../pages/SetupServerAddPage';
import SetupFinishPage from '../pages/SetupFinishPage';

// Build TanStack Router route tree mirroring the previous React Router setup

// Root with outlet
const rootRoute = createRootRoute({
  component: () => <Outlet />,
})

// User login route (regular user portal)
const userLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  component: UserLoginPage,
  validateSearch: (search) => {
    return { next: typeof search.next === 'string' ? (search.next as string) : undefined }
  },
})

// Admin login route (actual admin login page)
const adminLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/login',
  component: LoginPage,
  validateSearch: (search) => {
    return {
      next: typeof search.next === 'string' ? (search.next as string) : undefined,
      error: typeof search.error === 'string' ? (search.error as string) : undefined,
    }
  },
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
const adminNotifications = createRoute({ getParentRoute: () => adminRoute, path: 'notifications', component: AdminNotificationsPage })
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
const mediaTabs = ['overview', 'episodes', 'activity'] as const
type MediaTab = typeof mediaTabs[number]
const adminMediaDetail = createRoute({
  getParentRoute: () => adminRoute,
  path: 'libraries/$libraryId/$mediaId',
  component: MediaDetailPage,
  validateSearch: (search) => {
    const tabVal = typeof search.tab === 'string' && (mediaTabs as readonly string[]).includes(search.tab)
      ? (search.tab as MediaTab)
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
const adminAdminRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles', component: AdminSettingsAdminRolesPage })
const adminAdminRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admin-roles/$roleId/edit', component: AdminSettingsAdminRolesEditPage })
const adminUserRoles = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles', component: AdminSettingsUserRolesPage })
const adminUserRoleEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/user-roles/$roleId/edit', component: AdminSettingsUserRolesEditPage })
const adminPlugins = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins', component: AdminSettingsPluginsPage })
const adminPluginDetail = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins/$pluginId', component: AdminSettingsPluginsDetailPage })
const adminServerAdd = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins/$pluginId/servers/add', component: AdminSettingsPluginsServerAddPage })
const adminServerEdit = createRoute({ getParentRoute: () => adminRoute, path: 'settings/plugins/$pluginId/servers/$serverId', component: AdminSettingsPluginsServerEditPage })
const adminDiscord = createRoute({ getParentRoute: () => adminRoute, path: 'settings/discord', component: AdminSettingsDiscordPage })
const adminAdvanced = createRoute({ getParentRoute: () => adminRoute, path: 'settings/advanced', component: AdminSettingsAdvancedPage })
const adminLogs = createRoute({ getParentRoute: () => adminRoute, path: 'settings/logs', component: AdminSettingsLogsPage })
const adminApiDebug = createRoute({ getParentRoute: () => adminRoute, path: 'settings/api-debug', component: AdminSettingsApiDebugPage })
const adminUsersGeneral = createRoute({ getParentRoute: () => adminRoute, path: 'settings/users/general', component: AdminSettingsUserGeneralPage })
const adminAdmins = createRoute({ getParentRoute: () => adminRoute, path: 'settings/admins', component: AdminSettingsAdminManagementPage })
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
const userIndex = createRoute({
  getParentRoute: () => userRoute,
  path: '/',
  component: UserDashboardPage,
  validateSearch: (search) => ({ next: typeof search.next === 'string' ? (search.next as string) : undefined }),
})
const userDashboard = createRoute({
  getParentRoute: () => userRoute,
  path: 'dashboard',
  component: UserDashboardPage,
  validateSearch: (search) => ({ next: typeof search.next === 'string' ? (search.next as string) : undefined }),
})

// Setup UI
const setupRoute = createRoute({ getParentRoute: () => rootRoute, path: 'setup' })
const setupAccount = createRoute({ getParentRoute: () => setupRoute, path: 'account', component: SetupAccountPage })
const setupApp = createRoute({ getParentRoute: () => setupRoute, path: 'app', component: SetupAppConfigPage })
const setupPlugins = createRoute({ getParentRoute: () => setupRoute, path: 'plugins', component: SetupPluginsPage })
const setupPluginConfig = createRoute({ getParentRoute: () => setupRoute, path: 'plugins/$pluginId', component: SetupPluginConfigPage })
const setupServerAdd = createRoute({ getParentRoute: () => setupRoute, path: 'plugins/$pluginId/servers/add', component: SetupServerAddPage })
const setupFinish = createRoute({ getParentRoute: () => setupRoute, path: 'finish', component: SetupFinishPage })
const setupRootRedirect = createRoute({ getParentRoute: () => setupRoute, path: '/', component: () => <Navigate to="/setup/account" replace /> })
const setupWildcardRedirect = createRoute({ getParentRoute: () => setupRoute, path: '*', component: () => <Navigate to="/setup/account" replace /> })

// Root redirects
const rootIndexRedirect = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <Navigate to="/admin/dashboard" replace /> })
const rootWildcardRedirect = createRoute({ getParentRoute: () => rootRoute, path: '*', component: () => <Navigate to="/admin/dashboard" replace /> })

const routeTree = rootRoute.addChildren([
  userLoginRoute,
  adminLoginRoute,
  adminRoute.addChildren([
    adminIndexRedirect,
    adminDashboard,
    adminNotifications,
    adminAccount,
    adminStreaming,
    adminUsers,
    adminUserByNick,
    adminUserByUuid,
    adminInvites,
    adminLibraries,
    adminLibraryDetail,
    adminMediaDetail,
    adminSettings,
    adminSettingsGeneral,
    adminAdminRoles,
    adminAdminRoleEdit,
    adminUserRoles,
    adminUserRoleEdit,
    adminPlugins,
    adminPluginDetail,
    adminServerAdd,
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
  setupRoute.addChildren([setupAccount, setupApp, setupPlugins, setupPluginConfig, setupServerAdd, setupFinish, setupRootRedirect, setupWildcardRedirect]),
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
