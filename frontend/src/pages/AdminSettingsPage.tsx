import { Link } from '@tanstack/react-router';
import {
  IconSettings,
  IconUsers,
  IconShield,
  IconUserShield,
  IconPuzzle,
  IconBrandDiscord,
  IconShieldCheck,
  IconFileText,
  IconCode,
  IconChevronRight,
} from '@tabler/icons-react';
import { PageHeader } from '../components';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

interface SettingsCategoryProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  href: string;
}

const SettingsCategory = ({ title, description, icon, href }: SettingsCategoryProps) => {
  return (
    <Link to={href} className="block">
      <Card className="group cursor-pointer transition-all hover:border-primary hover:shadow-md">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                {icon}
              </div>
              <div>
                <CardTitle className="text-lg font-semibold transition-colors group-hover:text-primary">
                  {title}
                </CardTitle>
                <CardDescription className="mt-1 text-sm">
                  {description}
                </CardDescription>
              </div>
            </div>
            <IconChevronRight className="size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
};

export const AdminSettingsPage = () => {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Configure and manage your MUM installation"
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* General Settings */}
        <SettingsCategory
          title="General"
          description="Configure application name, URL, and global settings"
          icon={<IconSettings className="size-6" />}
          href="/admin/settings/general"
        />

        {/* User Settings */}
        <SettingsCategory
          title="User Settings"
          description="Configure default user settings and preferences"
          icon={<IconUsers className="size-6" />}
          href="/admin/settings/users/general"
        />

        {/* User Roles */}
        <SettingsCategory
          title="User Roles"
          description="Manage user roles and permissions for end users"
          icon={<IconShield className="size-6" />}
          href="/admin/settings/user-roles"
        />

        {/* Admin Roles */}
        <SettingsCategory
          title="Admin Roles"
          description="Manage administrator roles and access control"
          icon={<IconUserShield className="size-6" />}
          href="/admin/settings/admin-roles"
        />

        {/* Admins */}
        <SettingsCategory
          title="Admin Management"
          description="Manage administrator accounts and privileges"
          icon={<IconUserShield className="size-6" />}
          href="/admin/settings/admins"
        />

        {/* Plugins & Servers */}
        <SettingsCategory
          title="Plugins & Servers"
          description="Connect and configure media servers (Plex, Jellyfin, Emby, etc.)"
          icon={<IconPuzzle className="size-6" />}
          href="/admin/settings/plugins"
        />

        {/* Discord Integration */}
        <SettingsCategory
          title="Discord"
          description="Configure Discord bot integration and notifications"
          icon={<IconBrandDiscord className="size-6" />}
          href="/admin/settings/discord"
        />

        {/* Advanced Settings */}
        <SettingsCategory
          title="Advanced"
          description="Advanced configuration, scheduled tasks, and system information"
          icon={<IconShieldCheck className="size-6" />}
          href="/admin/settings/advanced"
        />

        {/* Logs */}
        <SettingsCategory
          title="Logs"
          description="View application logs and debugging information"
          icon={<IconFileText className="size-6" />}
          href="/admin/settings/logs"
        />

        {/* API Debug */}
        <SettingsCategory
          title="API Debug"
          description="Test and debug API endpoints with live requests"
          icon={<IconCode className="size-6" />}
          href="/admin/settings/api-debug"
        />
      </div>
    </div>
  );
};

export default AdminSettingsPage;
