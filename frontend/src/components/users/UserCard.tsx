
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
import { getServicePalette, type ThemePalette } from '@/config/pluginMetadata';
import { Folder, Play, Pause, Activity, Music, Loader2, Mail, Calendar, Clock, Server, StickyNote, Link, Library, Shield, User, Crown, Layers } from 'lucide-react';

export type UserNowPlaying = {
  state: string;
  mediaTitle: string;
  serviceType?: string | null;
  serverName?: string | null;
  sessionCount?: number;
};

interface UserCardProps {
  user: UserRow;
  isSelected?: boolean;
  onToggleSelection?: (userId: string) => void;
  nowPlaying?: UserNowPlaying | null;
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


export const UserCard = ({ user, isSelected = false, onToggleSelection, nowPlaying }: UserCardProps) => {
  const navigate = useNavigate();
  const serviceType = user.service_type?.toLowerCase();
  const isService = user.user_type.toLowerCase() === 'service';
  const palette = getServicePalette(serviceType);

  // Avatar loading state
  const [avatarLoading, setAvatarLoading] = useState(true);
  const [avatarError, setAvatarError] = useState(false);
  const effectiveAvatar = user.avatar_url;
  const [showAllLibraries, setShowAllLibraries] = useState(false);

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

  // Helper to determine icon and color based on playback state
  const getPlaybackInfo = (state?: string) => {
    const s = state?.toLowerCase() || '';
    if (s === 'playing') return { icon: Play, color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-green-500/20', animate: true };
    if (s === 'listening') return { icon: Music, color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-green-500/20', animate: true };
    if (s === 'paused') return { icon: Pause, color: 'text-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/20', animate: false };
    if (s === 'buffering') return { icon: Loader2, color: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-blue-500/20', animate: true, spin: true };
    return { icon: Activity, color: 'text-muted-foreground', bg: 'bg-secondary/50', border: 'border-border/50', animate: false };
  };

  const playbackInfo = nowPlaying ? getPlaybackInfo(nowPlaying.state) : null;
  const PlaybackIcon = playbackInfo?.icon;
  const showLinkedSection = !isService || Boolean(user.linked_local_user);

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
      <CardContent className="p-4 flex flex-col flex-1 gap-4">
        {/* Redesigned Header */}
        <div className="flex flex-row items-center gap-4">
          <div className="relative shrink-0">
            {effectiveAvatar && !avatarError ? (
              <>
                {avatarLoading && (
                  <Skeleton className="w-12 h-12 rounded-full absolute inset-0" />
                )}
                <img
                  src={effectiveAvatar}
                  alt={user.display_name || user.username || 'User avatar'}
                  className={cn(
                    "w-12 h-12 rounded-full object-cover ring-2 ring-background/50 shadow-sm",
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
              <div className={cn(
                "w-12 h-12 rounded-full flex items-center justify-center text-xl font-medium ring-2 ring-background/50 shadow-sm",
                isService ? palette.avatar : 'bg-primary text-primary-foreground'
              )}>
                {(user.display_name || user.username || 'U')[0].toUpperCase()}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 flex flex-col justify-center">
            <h2 className="text-lg font-bold leading-tight truncate tracking-tight mb-1" title={user.display_name || user.username}>
              {user.display_name || user.username || 'Unnamed User'}
            </h2>

            <div className="flex items-center gap-2">
              {isService ? (
                <Badge color={palette.avatar} className="text-xs font-semibold tracking-wider gap-1.5 border-border/30" hover={false}>
                  <Server strokeWidth={3} className="w-3 h-3" />
                  <span className="truncate max-w-[120px]">{user.server_nickname || 'Service Account'}</span>
                </Badge>
              ) : user.user_type.toLowerCase() === 'owner' ? (
                <Badge color="bg-amber-500" className="text-xs font-semibold tracking-wider gap-1.5" hover={false}>
                  <Crown strokeWidth={3} className="w-3 h-3" />
                  <span>Owner</span>
                </Badge>
              ) : (
                <Badge color="bg-primary" className="text-xs font-semibold tracking-wider gap-1.5" hover={false}>
                  <User strokeWidth={3} className="w-3 h-3" />
                  <span>Local User</span>
                </Badge>
              )}
            </div>
          </div>
        </div>

        {/* User Details */}
        <div className="flex flex-col gap-1.5 text-xs">

          <div className="flex flex-col gap-1.5">
            {settings.show_email_section && (
              <div className="flex items-center gap-1.5 overflow-hidden" title={user.external_email ?? 'No email'}>
                <Mail strokeWidth={3} className="h-3 w-3 shrink-0 text-blue-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0">Email:</span>
                <span className="truncate">{user.external_email ?? 'No email'}</span>
              </div>
            )}
            {settings.show_added_section && (
              <div className="flex items-center gap-1.5 overflow-hidden" title={`Added: ${user.created_at ? new Date(user.created_at).toLocaleString() : 'Unknown'}`}>
                <Calendar strokeWidth={3} className="h-3 w-3 shrink-0 text-blue-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0">Added:</span>
                <span className="truncate">{user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</span>
              </div>
            )}
            {user.service_join_date && (
              <div className="flex items-center gap-1.5 overflow-hidden" title={`Service Join: ${new Date(user.service_join_date).toLocaleString()}`}>
                <Server strokeWidth={3} className="h-3 w-3 shrink-0 text-blue-400" />
                <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0">Joined:</span>
                <span className="truncate">{new Date(user.service_join_date).toLocaleDateString()}</span>
              </div>
            )}
            {settings.show_streamed_section && (
              <div className="flex items-center gap-1.5 overflow-hidden" title={`Last Streamed: ${user.last_streamed_at ? new Date(user.last_streamed_at).toLocaleString() : 'Never'}`}>
                <Clock strokeWidth={3} className={cn("h-3 w-3 shrink-0", user.last_streamed_at && "text-green-500")} />
                <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0">Seen:</span>
                <span className="truncate">{user.last_streamed_at ? new Date(user.last_streamed_at).toLocaleDateString() : 'Never'}</span>
              </div>
            )}
          </div>
        </div>

        {/* Notes Section - Redesigned */}
        {settings.show_user_notes && user.notes && (
          <div className="relative rounded-md bg-yellow-500/5 border border-yellow-500/10 p-2">
            <div className="flex items-start gap-2">
              <StickyNote strokeWidth={3} className="h-3 w-3 text-yellow-500 shrink-0" />
              <p className="text-[10px] text-muted-foreground leading-tight line-clamp-3">{user.notes}</p>
            </div>
          </div>
        )}

        {/* Linked Accounts - Redesigned */}
        {showLinkedSection ? (
          <div className="space-y-1">
            {!isService && (
              <div className="flex items-center justify-between rounded-md bg-secondary/30 px-2 py-1.5 border border-border/40">
                <span className="text-[10px] font-medium text-muted-foreground flex items-center gap-1.5">
                  <Link className="h-3 w-3" />
                  Linked Services
                </span>
                <span className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded-sm",
                  user.linked_service_count > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                )}>
                  {user.linked_service_count}
                </span>
              </div>
            )}

            {isService && user.linked_local_user && (
              <div className="flex items-center gap-2 rounded-md bg-primary/5 px-2 py-1.5 border border-primary/10">
                <Link className="h-3 w-3 text-primary shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-[10px] font-medium leading-none text-muted-foreground mb-0.5">Linked to</span>
                  <span className="text-xs font-semibold leading-none truncate text-primary" title={user.linked_local_user.display_name || user.linked_local_user.username}>
                    {user.linked_local_user.display_name || user.linked_local_user.username}
                  </span>
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* Now Playing Section Redesign */}
        {settings.show_streamed_section && nowPlaying && playbackInfo && PlaybackIcon ? (
          <div className={cn(
            "relative overflow-hidden rounded-md border p-2.5",
            playbackInfo.bg,
            playbackInfo.border
          )}>
            <div className="flex items-start gap-3">
              <div className={cn(
                "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/50 shadow-sm",
                playbackInfo.color
              )}>
                <PlaybackIcon className={cn("h-4 w-4", playbackInfo.spin && "animate-spin")} />
              </div>

              <div className="flex-1 min-w-0 flex flex-col justify-center">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold leading-none truncate w-full" title={nowPlaying.mediaTitle}>
                    {nowPlaying.mediaTitle || 'Unknown Title'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-wider",
                    playbackInfo.color
                  )}>
                    {nowPlaying.state}
                  </span>
                  {nowPlaying.serverName && (
                    <>
                      <span className="text-[10px] text-muted-foreground/60">•</span>
                      <span className="text-[10px] text-muted-foreground font-medium truncate max-w-[80px]" title={nowPlaying.serverName}>
                        {nowPlaying.serverName}
                      </span>
                    </>
                  )}
                </div>
              </div>

              {nowPlaying.sessionCount && nowPlaying.sessionCount > 1 && (
                <div className="flex shrink-0 items-center justify-center h-5 px-1.5 rounded-full bg-background/50 border border-border/50 shadow-sm">
                  <span className="text-[10px] font-medium text-muted-foreground">
                    +{nowPlaying.sessionCount - 1}
                  </span>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {isService && settings.show_libraries_section && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
              <Library strokeWidth={3} className="h-3 w-3 text-blue-400" />
              Libraries <span className="text-muted-foreground/60 font-normal">({user.has_all_libraries ? 'All' : (user.libraries?.length ?? 0)})</span>
            </div>

            {user.has_all_libraries ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color="bg-blue-500" className="text-xs font-medium gap-1" hover={false}>
                    <Layers strokeWidth={3} className="w-3 h-3" />
                    All Libraries
                  </Badge>
                  {user.libraries && user.libraries.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 px-2 text-[10px] rounded-full hover:bg-white/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        setShowAllLibraries((prev) => !prev);
                      }}
                    >
                      {showAllLibraries ? 'Hide' : 'Show'}
                      <i
                        className={cn(
                          'fa-solid ml-1 text-[8px]',
                          showAllLibraries ? 'fa-chevron-up' : 'fa-chevron-down'
                        )}
                      />
                    </Button>
                  )}
                </div>
                {showAllLibraries && user.libraries && user.libraries.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-1">
                    {user.libraries.map((library) => (
                      <Badge
                        key={library}
                        color="bg-blue-500"
                        className="text-xs font-medium gap-1"
                        hover={false}
                      >
                        {library}
                      </Badge>
                    ))}
                  </div>
                )}
              </>
            ) : user.libraries && user.libraries.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {user.libraries.map((library) => (
                  <Badge
                    key={library}
                    color="bg-blue-500"
                    className="text-xs font-medium gap-1"
                    hover={false}
                  >
                    <Folder strokeWidth={3} className="w-3 h-3" />
                    {library}
                  </Badge>
                ))}
              </div>
            ) : (
              <span className="text-[10px] text-muted-foreground italic pl-1">
                No libraries shared
              </span>
            )}
          </div>
        )}

        {settings.show_roles_section && user.user_roles.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
              <Shield className="h-3 w-3 text-blue-400" strokeWidth={3}/>
              Roles
            </div>
            <div className="flex flex-wrap gap-1.5">
              {user.user_roles.map((role) => (
                <Badge
                  key={role.name}
                  hexColor={role.color}
                  iconClass={role.icon}
                  roleKind="user"
                  className="text-xs font-medium gap-1"
                  hover={false}
                >
                  {role.name}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {settings.show_roles_section && user.admin_roles.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold mb-2 flex items-center gap-1.5">
              <Crown strokeWidth={3} className="h-3 w-3 text-amber-500" />
              Admin Roles
            </div>
            <div className="flex flex-wrap gap-1.5">
              {user.admin_roles.map((role) => (
                <Badge key={role} roleKind="admin" className="rounded-full px-2.5 py-0.5 text-[10px] font-medium shadow-sm bg-amber-500 text-white border-amber-600" hover={false}>
                  {role}
                </Badge>
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
