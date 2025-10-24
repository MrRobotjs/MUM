import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import clsx from 'clsx';
import { clearCsrfToken, requestJson } from '../../util/apiClient';
import { useNavigate } from 'react-router-dom';

type NavItem = {
  label: string;
  path: string;
  icon: string;
  permission?: string;
  badge?: string | number;
};

type NavSection = {
  label: string;
  icon: string;
  permission?: string;
  items: NavItem[];
};

type SidebarProps = {
  onNavigate?: () => void;
};

export const Sidebar = ({ onNavigate }: SidebarProps) => {
  const { hasPermission, hasAnyPermission, isOwner, refresh } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    try {
      await requestJson('/admin/api/v1/auth/logout', { method: 'POST' });
    } catch (error) {
      console.warn('Failed to logout via API, falling back to legacy endpoint', error);
    } finally {
      clearCsrfToken();
      await refresh();
      if (onNavigate) {
        onNavigate();
      }
      navigate('/auth/login', { replace: true });
    }
  };

  const mainNavItems: NavItem[] = [
    { label: 'Dashboard', path: '/admin/dashboard', icon: 'fa-chart-line' },
    { label: 'Users', path: '/admin/users', icon: 'fa-users', permission: 'view_users' },
    { label: 'Invites', path: '/admin/invites', icon: 'fa-ticket', permission: 'view_invites' },
    { label: 'Libraries', path: '/admin/libraries', icon: 'fa-layer-group', permission: 'view_servers' },
    { label: 'Streaming', path: '/admin/streaming', icon: 'fa-tower-broadcast', permission: 'view_streaming' },
  ];

  const settingsSections: NavSection[] = [
    {
      label: 'Settings',
      icon: 'fa-cog',
      permission: 'manage_general_settings',
      items: [
        {
          label: 'General',
          path: '/admin/settings/general',
          icon: 'fa-sliders',
          permission: 'manage_general_settings',
        },
      ],
    },
    {
      label: 'Users',
      icon: 'fa-users',
      permission: 'view_users',
      items: [
        {
          label: 'General',
          path: '/admin/settings/users/general',
          icon: 'fa-cog',
          permission: 'manage_users_general',
        },
        {
          label: 'Roles',
          path: '/admin/settings/user-roles',
          icon: 'fa-user-tag',
          permission: 'manage_user_roles',
        },
      ],
    },
    {
      label: 'Manage Admins',
      icon: 'fa-user-shield',
      permission: 'view_admins_tab',
      items: [
        {
          label: 'Admins',
          path: '/admin/settings/admins',
          icon: 'fa-shield-halved',
          permission: 'manage_admins',
        },
        {
          label: 'Roles',
          path: '/admin/settings/admin-roles',
          icon: 'fa-shield',
          permission: 'manage_roles',
        },
      ],
    },
  ];

  const additionalSettingsItems: NavItem[] = [
    {
      label: 'Plugins',
      path: '/admin/settings/plugins',
      icon: 'fa-puzzle-piece',
      permission: 'manage_plugins',
    },
    {
      label: 'Discord',
      path: '/admin/settings/discord',
      icon: 'fa-brands fa-discord',
      permission: 'manage_discord_settings',
    },
    {
      label: 'Logs',
      path: '/admin/settings/logs',
      icon: 'fa-timeline',
      permission: 'view_logs',
    },
    {
      label: 'API Debug',
      path: '/admin/settings/api-debug',
      icon: 'fa-code',
      permission: 'manage_advanced_settings',
    },
    {
      label: 'Advanced',
      path: '/admin/settings/advanced',
      icon: 'fa-gears',
      permission: 'manage_advanced_settings',
    },
  ];

  const canAccessSettings =
    isOwner ||
    hasAnyPermission(
      'manage_general_settings',
      'manage_discord_settings',
      'manage_advanced_settings',
      'view_admins_tab'
    );

  const filterByPermission = (item: NavItem) => {
    if (!item.permission) return true;
    return isOwner || hasPermission(item.permission);
  };

  const filterSectionByPermission = (section: NavSection) => {
    if (!section.permission && section.items.every((item) => !item.permission)) return true;
    if (isOwner) return true;
    if (section.permission && !hasPermission(section.permission)) return false;
    return section.items.some(filterByPermission);
  };

  return (
    <ul className="menu w-60 min-h-full bg-base-100 p-4 text-base-content shadow-sm sm:w-80">
      {/* Main Navigation */}
      {mainNavItems.filter(filterByPermission).map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            className={({ isActive }) => clsx({ active: isActive })}
            onClick={onNavigate}
          >
            <i className={`fa-solid ${item.icon} fa-fw`}></i>
            {item.label}
            {item.badge !== undefined && (
              <span className="badge badge-primary badge-sm">{item.badge}</span>
            )}
          </NavLink>
        </li>
      ))}

      {/* Settings Section */}
      {canAccessSettings && (
        <>
          <div className="divider"></div>
          <li>
            <details open>
              <summary>
                <i className="fa-solid fa-cog fa-fw"></i>
                Settings
              </summary>
              <ul className="ml-4">
                {/* Nested sections */}
                {settingsSections.filter(filterSectionByPermission).map((section) => {
                  const visibleItems = section.items.filter(filterByPermission);
                  if (visibleItems.length === 0) return null;

                  return (
                    <li key={section.label}>
                      <details>
                        <summary>
                          <i className={`fa-solid ${section.icon} fa-fw`}></i>
                          {section.label}
                        </summary>
                        <ul className="ml-4">
                          {visibleItems.map((item) => (
                            <li key={item.path}>
                              <NavLink
                                to={item.path}
                                className={({ isActive }) => clsx({ active: isActive })}
                                onClick={onNavigate}
                              >
                                <i className={`fa-solid ${item.icon}`}></i>
                                {item.label}
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </li>
                  );
                })}

                {/* Additional flat settings items */}
                {additionalSettingsItems.filter(filterByPermission).map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) => clsx({ active: isActive })}
                      onClick={onNavigate}
                    >
                      <i className={`fa-solid ${item.icon} fa-fw`}></i>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        </>
      )}

      {/* Logout */}
      <div className="divider"></div>
      <li>
        <button type="button" className="btn btn-ghost btn-sm justify-start gap-3" onClick={handleLogout}>
          <i className="fa-solid fa-arrow-right-from-bracket fa-fw"></i>
          Logout
        </button>
      </li>
    </ul>
  );
};
