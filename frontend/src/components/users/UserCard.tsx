
import { useState, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { buildUserProfilePath } from '../../util/routes';
import type { UserRow } from './UsersTable';
import { Checkbox } from '../ui/checkbox';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { UserDebugModal } from './UserDebugModal';
import { cn } from '@/lib/utils';
import { Badge } from '../common/Badge';

interface UserCardProps {
  user: UserRow;
  isSelected?: boolean;
  onToggleSelection?: (userId: string) => void;
}

interface UserDisplaySettings {
  show_user_notes: boolean;
  show_email_section: boolean;
  show_added_section: boolean;
  show_streamed_section: boolean;
  show_libraries_section: boolean;
  show_roles_section: boolean;
  preferred_view: 'cards' | 'table';
  auto_sync_users: boolean;
}

type ThemePalette = {
  bg: string;
  bgDark: string;
  text: string;
  textDark: string;
  accent: string;
  accentDark: string;
  ring: string;
  ringDark: string;
  avatar: string;
};

type ServicePalettes = {
  light: ThemePalette;
  dark: ThemePalette;
};

const servicePalettes: Record<string, ThemePalette> = {
  plex: {
    bg: 'bg-plex-50',
    bgDark: 'dark:bg-plex-400/10',
    text: 'text-plex-700',
    textDark: 'dark:text-plex-400',
    accent: 'bg-plex-100',
    accentDark: 'dark:bg-plex-400/20',
    ring: 'ring-plex-600/20',
    ringDark: 'dark:ring-plex-500/20',
    avatar: 'bg-plex'
  },
  jellyfin: {
    bg: 'bg-jellyfin-50',
    bgDark: 'dark:bg-jellyfin-400/10',
    text: 'text-jellyfin-700',
    textDark: 'dark:text-jellyfin-400',
    accent: 'bg-jellyfin-100',
    accentDark: 'dark:bg-jellyfin-400/20',
    ring: 'ring-jellyfin-600/20',
    ringDark: 'dark:ring-jellyfin-500/20',
    avatar: 'bg-jellyfin'
  },
  emby: {
    bg: 'bg-emby-50',
    bgDark: 'dark:bg-emby-400/10',
    text: 'text-emby-700',
    textDark: 'dark:text-emby-400',
    accent: 'bg-emby-100',
    accentDark: 'dark:bg-emby-400/20',
    ring: 'ring-emby-600/20',
    ringDark: 'dark:ring-emby-500/20',
    avatar: 'bg-emby'
  },
  kavita: {
    bg: 'bg-kavita-50',
    bgDark: 'dark:bg-kavita-400/10',
    text: 'text-kavita-700',
    textDark: 'dark:text-kavita-400',
    accent: 'bg-kavita-100',
    accentDark: 'dark:bg-kavita-400/20',
    ring: 'ring-kavita-600/20',
    ringDark: 'dark:ring-kavita-500/20',
    avatar: 'bg-kavita'
  },
  audiobookshelf: {
    bg: 'bg-audiobookshelf-50',
    bgDark: 'dark:bg-audiobookshelf-400/10',
    text: 'text-audiobookshelf-700',
    textDark: 'dark:text-audiobookshelf-400',
    accent: 'bg-audiobookshelf-100',
    accentDark: 'dark:bg-audiobookshelf-400/20',
    ring: 'ring-audiobookshelf-600/20',
    ringDark: 'dark:ring-audiobookshelf-500/20',
    avatar: 'bg-audiobookshelf'
  },
  komga: {
    bg: 'bg-komga-50',
    bgDark: 'dark:bg-komga-400/10',
    text: 'text-komga-700',
    textDark: 'dark:text-komga-400',
    accent: 'bg-komga-100',
    accentDark: 'dark:bg-komga-400/20',
    ring: 'ring-komga-600/20',
    ringDark: 'dark:ring-komga-500/20',
    avatar: 'bg-komga'
  },
  romm: {
    bg: 'bg-romm-50',
    bgDark: 'dark:bg-romm-400/10',
    text: 'text-romm-700',
    textDark: 'dark:text-romm-400',
    accent: 'bg-romm-100',
    accentDark: 'dark:bg-romm-400/20',
    ring: 'ring-romm-600/20',
    ringDark: 'dark:ring-romm-500/20',
    avatar: 'bg-romm'
  }
};

const getServicePalette = (serviceType?: string) => {
  if (!serviceType) {
    return servicePalettes['plex'];
  }
  return servicePalettes[serviceType] ?? servicePalettes['plex'];
};

export const UserCard = ({ user, isSelected = false, onToggleSelection }: UserCardProps) => {
  const navigate = useNavigate();
  const serviceType = user.service_type?.toLowerCase();
  const isService = user.user_type.toLowerCase() === 'service';
  const palette = getServicePalette(serviceType);

  // Avatar loading state
  const [avatarLoading, setAvatarLoading] = useState(true);
  const [avatarError, setAvatarError] = useState(false);
  const effectiveAvatar = user.avatar_url;

  // Debug modal state
  const [debugModalOpen, setDebugModalOpen] = useState(false);

  // Load display settings from localStorage
  const [settings, setSettings] = useState<UserDisplaySettings>({
    show_user_notes: false,
    show_email_section: true,
    show_added_section: true,
    show_streamed_section: true,
    show_libraries_section: true,
    show_roles_section: true,
    preferred_view: 'cards',
    auto_sync_users: false
  });

  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem('userDisplaySettings');
      if (savedSettings) {
        setSettings(JSON.parse(savedSettings));
      }
    } catch (err) {
      console.error('Failed to load user display settings:', err);
    }
  }, []);

  // Reset avatar loading state when avatar URL changes
  useEffect(() => {
    if (effectiveAvatar) {
      setAvatarLoading(true);
      setAvatarError(false);
    } else {
      setAvatarLoading(false);
    }
  }, [effectiveAvatar]);

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking checkbox or buttons
    const target = e.target as HTMLElement;
    if (target.closest('input, button, a')) {
      return;
    }
    // Toggle selection on card click if selection is enabled
    if (onToggleSelection) {
      onToggleSelection(user.uuid);
    } else {
      navigate({ to: buildUserProfilePath(user), state: { userUuid: user.uuid } });
    }
  };

  const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (onToggleSelection) {
      onToggleSelection(user.uuid);
    }
  };

  const cardGradient = () => {
    if (!isService) {
      return 'bg-gradient-to-br from-card to-primary/20';
    }
    switch (serviceType) {
      case 'plex':
        return 'bg-gradient-to-br from-card to-plex/20';
      case 'jellyfin':
        return 'bg-gradient-to-br from-card to-jellyfin/20';
      case 'emby':
        return 'bg-gradient-to-br from-card to-emby/20';
      case 'kavita':
        return 'bg-gradient-to-br from-card to-kavita/20';
      case 'audiobookshelf':
        return 'bg-gradient-to-br from-card to-audiobookshelf/20';
      case 'komga':
        return 'bg-gradient-to-br from-card to-komga/20';
      case 'romm':
        return 'bg-gradient-to-br from-card to-romm/20';
      default:
        return 'bg-card';
    }
  };

  const avatarClasses = cn(
    'text-white w-10 h-10 rounded-full flex items-center justify-center text-2xl font-normal',
    isService ? palette.avatar : 'bg-primary'
  );

  return (
    <Card
      className={cn(
        'shadow-lg hover:shadow-xl transition-all p-0 duration-200 ease-in-out relative group cursor-pointer flex flex-col',
        cardGradient(),
        isSelected && 'ring-2 ring-primary ring-offset-2 ring-offset-background'
      )}
      onClick={handleCardClick}
      style={
        isSelected
          ? {
              backgroundColor: `${palette.avatar}20`,
              outlineColor: palette.avatar
            }
          : undefined
      }
    >
      {/* Selection Checkbox */}
      {onToggleSelection && (
        <div
          className={cn(
            'absolute top-2 right-2 z-10 transition-opacity duration-200',
            isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelection(user.uuid)}
            title="Select user"
          />
        </div>
      )}
      <CardContent className="p-4 flex flex-col flex-1">
        <div className="flex flex-row items-center mb-3">
          <div className="mr-3 relative">
            {effectiveAvatar && !avatarError ? (
              <>
                {avatarLoading && (
                  <Skeleton className="w-10 h-10 rounded-full absolute inset-0" />
                )}
                <img
                  src={effectiveAvatar}
                  alt={user.display_name || user.username || 'User avatar'}
                  className={cn(
                    "w-10 h-10 rounded-full object-cover ring-2 ring-primary/20",
                    avatarLoading && "opacity-0"
                  )}
                  onLoad={() => setAvatarLoading(false)}
                  onError={() => {
                    setAvatarLoading(false);
                    setAvatarError(true);
                  }}
                />
              </>
            ) : (
              <div className={avatarClasses}>
                {(user.display_name || user.username || 'U')[0].toUpperCase()}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 space-y-1">
            <h2 className="text-lg font-semibold truncate" title={user.display_name || user.username}>
              {user.display_name || user.username || 'Unnamed User'}
            </h2>
            {isService ? (
              <Badge color={palette.avatar} className="text-xs font-semibold gap-1" hover={false}>
                <i className="fa-solid fa-server w-3 h-3 mt-0.5" />
                {user.server_nickname || 'Service Account'}
              </Badge>
            ) : user.user_type.toLowerCase() === 'owner' ? (
              <Badge color="bg-amber-500" className="text-xs font-semibold gap-1" hover={false}>
                <i className="fa-solid fa-crown w-3 h-3 mt-0.5" />
                Owner
              </Badge>
            ) : (
              <Badge color="bg-primary" className="text-xs font-semibold gap-1" hover={false}>
                <i className="fa-solid fa-user w-3 h-3 mt-0.5" />
                Local Account
              </Badge>
            )}
          </div>
        </div>

        {/* Notes Section */}
        {settings.show_user_notes && user.notes && (
          <div className="mb-3 p-2 bg-yellow-500/10 rounded-md border border-yellow-500/20">
            <div className="flex items-start gap-2">
              <i className="fa-solid fa-sticky-note text-yellow-400 mt-0.5" />
              <div className="flex-1">
                <p className="text-xs font-semibold text-yellow-400 mb-1">Notes:</p>
                <p className="text-xs text-muted-foreground whitespace-pre-wrap">{user.notes}</p>
              </div>
            </div>
          </div>
        )}

        <div className="text-xs space-y-1 mb-3">
          {settings.show_email_section && (
            <p className="text-xs text-muted-foreground truncate" title={user.external_email ?? 'No email'}>
              <i className="fa-solid fa-at fa-fw mr-1 text-blue-400" /> Email: {user.external_email ?? 'No email'}
            </p>
          )}
          {settings.show_added_section && (
            <p title={user.created_at ? new Date(user.created_at).toLocaleString() : undefined}>
              <i className="fa-solid fa-calendar-plus fa-fw mr-1 text-blue-400" /> Added:{' '}
              {user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
            </p>
          )}
          {settings.show_streamed_section && (
            <p title={user.last_streamed_at ? new Date(user.last_streamed_at).toLocaleString() : undefined}>
              <i className={`fa-solid fa-clock fa-fw mr-1 ${user.last_streamed_at ? 'text-green-400' : 'text-yellow-400'}`} /> Last
              Streamed: {user.last_streamed_at ? new Date(user.last_streamed_at).toLocaleDateString() : 'Never'}
            </p>
          )}
          {user.service_join_date && (
            <p title={new Date(user.service_join_date).toLocaleString()}>
              <i className="fa-solid fa-server fa-fw mr-1 text-blue-400" /> Service Join:{' '}
              {new Date(user.service_join_date).toLocaleDateString()}
            </p>
          )}
        </div>

        {!isService && (
          <div className="mb-3">
            <p className="text-xs font-semibold mb-2">
              Service Accounts (<span className="font-normal">{user.linked_service_count}</span>):
            </p>
            {user.linked_service_count > 0 ? (
              <div className="flex flex-wrap gap-1">
                <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium ring-1 ring-inset ring-border gap-1">
                  <i className="fa-solid fa-link w-3 h-3" />
                  {user.linked_service_count} linked
                </span>
              </div>
            ) : (
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border gap-1">
                <i className="fa-solid fa-unlink w-2.5 h-2.5" />
                No linked service accounts
              </span>
            )}
          </div>
        )}

        {isService && user.linked_local_user && (
          <div className="mb-3">
            <p className="text-xs font-semibold mb-2">Linked Local Account:</p>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary ring-1 ring-inset ring-primary/20 gap-1">
              <i className="fa-solid fa-link w-3 h-3" />
              {user.linked_local_user.display_name || user.linked_local_user.username || 'Local Account'}
            </span>
          </div>
        )}

        {isService && settings.show_libraries_section && (
          <div className="mb-3">
            <p className="text-xs font-semibold mb-2">
              Libraries (<span className="font-normal">
                {user.has_all_libraries ? 'All' : (user.libraries?.length ?? 0)}
              </span>):
            </p>
            {user.has_all_libraries ? (
              <Badge color="bg-blue-500" className="text-xs font-medium gap-1" hover={false}>
                <i className="fa-solid fa-layer-group w-3 h-3" />
                All libraries on {user.server_nickname || 'server'}
              </Badge>
            ) : user.libraries && user.libraries.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {user.libraries.map((library) => (
                  <Badge
                    key={library}
                    color="bg-blue-500"
                    className="text-xs font-medium gap-1"
                    hover={false}
                  >
                    <i className="fa-solid fa-folder w-3 h-3 mt-0.5" />
                    {library}
                  </Badge>
                ))}
              </div>
            ) : (
              <Badge color="bg-muted" className="text-xs font-medium gap-1" hover={false}>
                <i className="fa-solid fa-folder-open w-3 h-3" />
                No libraries specifically shared
              </Badge>
            )}
          </div>
        )}

        {settings.show_roles_section && user.user_roles.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium mb-1">Roles:</div>
            <div className="flex flex-wrap gap-1">
              {user.user_roles.map((role) => (
                <span
                  key={role.name}
                  className={cn(
                    'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset gap-1',
                    role.color
                      ? undefined
                      : 'bg-purple-500/10 text-purple-400 ring-purple-500/20'
                  )}
                  style={
                    role.color
                      ? {
                          backgroundColor: `${role.color}20`,
                          color: role.color,
                          borderColor: `${role.color}40`
                        }
                      : undefined
                  }
                >
                  {role.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {settings.show_roles_section && user.admin_roles.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium mb-1">Admin:</div>
            <div className="flex flex-wrap gap-1">
              {user.admin_roles.map((role) => (
                <span
                  key={role}
                  className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset gap-1 bg-blue-500/10 text-blue-400 ring-blue-500/20"
                >
                  {role}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Spacer to push footer to bottom */}
        <div className="flex-1" />

        <div className="flex justify-end pt-3 border-t border-border/90">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setDebugModalOpen(true);
            }}
            title="Show Raw User Data"
            className="text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:bg-amber-400/10"
          >
            <i className="fa-solid fa-info" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              navigate({ to: buildUserProfilePath(user), state: { userUuid: user.uuid } });
            }}
            title="View User Profile"
          >
            <i className="fa-solid fa-user" />
          </Button>
        </div>
      </CardContent>

      <UserDebugModal
        open={debugModalOpen}
        onClose={() => setDebugModalOpen(false)}
        userUuid={user.uuid}
      />
    </Card>
  );
};
