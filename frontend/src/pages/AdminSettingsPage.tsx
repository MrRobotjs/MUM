import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faGear,
  faUsers,
  faShield,
  faUserShield,
  faPuzzlePiece,
  faShieldHalved,
  faFileLines,
  faCode,
  faChevronRight,
} from '@fortawesome/free-solid-svg-icons';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
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
            <FontAwesomeIcon icon={faChevronRight} className="size-5 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-primary" />
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
          icon={<FontAwesomeIcon icon={faGear} className="size-6" />}
          href="/admin/settings/general"
        />

        {/* User Settings */}
        <SettingsCategory
          title="User Settings"
          description="Configure default user settings and preferences"
          icon={<FontAwesomeIcon icon={faUsers} className="size-6" />}
          href="/admin/settings/users/general"
        />

        {/* User Roles */}
        <SettingsCategory
          title="User Roles"
          description="Manage user roles and permissions for end users"
          icon={<FontAwesomeIcon icon={faShield} className="size-6" />}
          href="/admin/settings/user-roles"
        />

        {/* Admin Roles */}
        <SettingsCategory
          title="Admin Roles"
          description="Manage administrator roles and access control"
          icon={<FontAwesomeIcon icon={faUserShield} className="size-6" />}
          href="/admin/settings/admin-roles"
        />

        {/* Admins */}
        <SettingsCategory
          title="Admin Management"
          description="Manage administrator accounts and privileges"
          icon={<FontAwesomeIcon icon={faUserShield} className="size-6" />}
          href="/admin/settings/admins"
        />

        {/* Plugins & Servers */}
        <SettingsCategory
          title="Plugins & Servers"
          description="Connect and configure media servers (Plex, Jellyfin, Emby, etc.)"
          icon={<FontAwesomeIcon icon={faPuzzlePiece} className="size-6" />}
          href="/admin/settings/plugins"
        />

        {/* Discord Integration */}
        <SettingsCategory
          title="Discord"
          description="Configure Discord bot integration and notifications"
          icon={<FontAwesomeIcon icon={faDiscord} className="size-6" />}
          href="/admin/settings/discord"
        />

        {/* Advanced Settings */}
        <SettingsCategory
          title="Advanced"
          description="Advanced configuration, scheduled tasks, and system information"
          icon={<FontAwesomeIcon icon={faShieldHalved} className="size-6" />}
          href="/admin/settings/advanced"
        />

        {/* Logs */}
        <SettingsCategory
          title="Logs"
          description="View application logs and debugging information"
          icon={<FontAwesomeIcon icon={faFileLines} className="size-6" />}
          href="/admin/settings/logs"
        />

        {/* API Debug */}
        <SettingsCategory
          title="API Debug"
          description="Test and debug API endpoints with live requests"
          icon={<FontAwesomeIcon icon={faCode} className="size-6" />}
          href="/admin/settings/api-debug"
        />
      </div>
    </div>
  );
};

export default AdminSettingsPage;
