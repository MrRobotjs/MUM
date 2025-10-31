import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
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

export const AppRouter = () => (
  <BrowserRouter>
    <Routes>
      <Route path="/auth/login" element={<LoginPage />} />
      <Route path="/auth/admin_login" element={<LoginPage />} />
      <Route element={<AdminGuard />}>
        <Route path="/admin/api-docs" element={<ApiDocsPage />} />
        <Route path="/admin" element={<AdminShell />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="account" element={<AdminAccountPage />} />
          <Route path="streaming" element={<StreamingPage />} />
          <Route path="users" element={<UsersListPage />} />
          <Route path="users/:serverNickname/:username" element={<UserDetailPage />} />
          <Route path="users/:uuid" element={<UserDetailPage />} />
          <Route path="invites" element={<InvitesPage />} />
          <Route path="libraries" element={<LibrariesPage />} />
          <Route path="libraries/:libraryId" element={<LibraryDetailPage />} />
          <Route path="libraries/:libraryId/:mediaId" element={<MediaDetailPage />} />
          <Route path="settings" element={<Navigate to="settings/general" replace />} />
          <Route path="settings/general" element={<GeneralSettingsPage />} />
          <Route path="settings/admin-roles" element={<AdminRolesPage />} />
          <Route path="settings/admin-roles/:roleId/edit" element={<AdminRoleEditPage />} />
          <Route path="settings/user-roles" element={<UserRolesPage />} />
          <Route path="settings/user-roles/:roleId/edit" element={<UserRoleEditPage />} />
          <Route path="settings/plugins" element={<PluginsPage />} />
          <Route path="settings/plugins/:pluginId" element={<PluginDetailPage />} />
          <Route path="settings/plugins/:pluginId/servers/:serverId" element={<ServerEditPage />} />
          <Route path="settings/discord" element={<DiscordSettingsPage />} />
          <Route path="settings/advanced" element={<AdvancedSettingsPage />} />
          <Route path="settings/logs" element={<LogsPage />} />
          <Route path="settings/api-debug" element={<ApiDebugPage />} />
          <Route path="settings/users/general" element={<UserSettingsGeneralPage />} />
          <Route path="settings/admins" element={<AdminsSettingsPage />} />
        </Route>
      </Route>

      <Route path="/invite" element={<InviteLandingPage />} />
      <Route path="/invite/:token" element={<InviteWizardPage />} />
      {/* User portal (SPA) */}
      <Route path="/user" element={<UserDashboardPage />} />
      <Route path="/user/dashboard" element={<UserDashboardPage />} />
      {/* Public setup UI routes (SPA) */}
      <Route path="/setup/ui/account" element={<SetupAccountPage />} />
      <Route path="/setup/ui/app" element={<SetupAppConfigPage />} />
      <Route path="/setup/ui/plugins" element={<SetupPluginsPage />} />
      <Route path="/setup/ui/discord" element={<SetupDiscordPage />} />
      <Route path="/setup" element={<Navigate to="/setup/ui/account" replace />} />
      <Route path="/setup/*" element={<Navigate to="/setup/ui/account" replace />} />
      <Route path="/" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
    </Routes>
  </BrowserRouter>
);

export default AppRouter;
