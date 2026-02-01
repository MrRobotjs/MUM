import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useAlerts } from '../contexts/AlertContext';
import { useUserDetail, UserDetail, UserHistoryEntry } from '../hooks/useUserDetail';
import { useUserHistoryPaginated } from '../hooks/useUserHistoryPaginated';
import { useServiceAccounts } from '../hooks/useServiceAccounts';
import { useAvailableServiceAccounts } from '../hooks/useAvailableServiceAccounts';
import { useOverseerr } from '../hooks/useOverseerr';
import { useServers } from '../hooks/useServers';
import { useUserSettings } from '../hooks/useUserSettings';
import { useUserUuidBySlug } from '../hooks/useUserUuidBySlug';
import { useStreamingWebSocket } from '../hooks/useStreamingWebSocket';
import { requestJson } from '../util/apiClient';
import {
  ServiceAccountsCard,
  ServiceAccountLinkModal,
  OverseerrCard,
  UserSettingsCard
} from '../components/users';
import type { ServiceAccount } from '../components/users/ServiceAccountsCard';
import type { UserSettings } from '../components/users/UserSettingsCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/common/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Pagination } from '@/components/common/Pagination';
import { getServiceMeta } from '@/config/pluginMetadata';
import type { UnifiedSession } from '@/types/realtime';
import type { UserNowPlaying } from '@/components/users/UserCard';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faAt,
  faIdCard,
  faFingerprint,
  faCalendarPlus,
  faServer,
  faDatabase,
  faLink,
  faCircleCheck,
  faCircleXmark,
  faHouse,
  faShareNodes,
  faShieldHalved,
  faFolder,
  faChartSimple,
  faClock,
  faCalendarWeek,
  faCalendarDays,
  faInfinity,
  faLayerGroup,
  faTv,
  faPlay,
  faClockRotateLeft,
  faUserClock,
  faLock,
  faUnlock,
  faKey,
  faUser,
  faMusic,
  faPause,
  faSpinner,
  faWaveSquare,
} from '@fortawesome/free-solid-svg-icons';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
import { Spinner } from '@/components/ui/spinner'

type TabKey = 'profile' | 'history' | 'settings' | 'overseerr' | 'security';

const formatDateTime = (value?: string | null, withTime = true) => {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleString(undefined, withTime ? undefined : { dateStyle: 'medium' });
};

const formatDuration = (value?: string | null) => value || '0m';
const formatNumber = (value?: number | null) => (typeof value === 'number' ? value.toLocaleString() : '0');

const getSessionPriority = (state?: string) => {
  const normalized = state?.toLowerCase();
  if (normalized === 'playing' || normalized === 'listening' || normalized === 'active') return 4;
  if (normalized === 'buffering') return 3;
  if (normalized === 'paused') return 2;
  if (normalized) return 1;
  return 0;
};

const getPlaybackInfo = (state?: string) => {
  const s = state?.toLowerCase() || '';
  if (s === 'playing') return { icon: faPlay, color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-green-500/20', animate: true };
  if (s === 'listening' || s === 'active') return { icon: faMusic, color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-green-500/20', animate: true };
  if (s === 'paused') return { icon: faPause, color: 'text-amber-500', bg: 'bg-amber-500/10', border: 'border-amber-500/20', animate: false };
  if (s === 'buffering') return { icon: faSpinner, color: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-blue-500/20', animate: true, spin: true };
  return { icon: faWaveSquare, color: 'text-muted-foreground', bg: 'bg-secondary/50', border: 'border-border/50', animate: false };
};

const ProfileTab = ({ user }: { user: UserDetail }) => {
  const theme = getServiceMeta(user.service_type ?? user.service_types?.[0]);
  const { lastSessionData } = useStreamingWebSocket({ autoConnect: false });
  const globalStats = user.stream_stats?.global ?? {};
  const playerStats = user.stream_stats?.players ?? [];
  const isServiceUser = user.user_type.toLowerCase() === 'service';
  const roleBadges = user.user_roles_detail;
  const adminRoleBadges = user.admin_roles_detail && user.admin_roles_detail.length > 0
    ? user.admin_roles_detail
    : user.roles.admin_roles.map((role) => ({ name: role }));
  const nowPlaying = useMemo<UserNowPlaying | null>(() => {
    const sessions = (lastSessionData?.sessions ?? []) as UnifiedSession[];
    if (!sessions.length) return null;
    const userSessions = sessions.filter(
      (session) => session.user?.uuid && String(session.user.uuid) === String(user.uuid)
    );
    if (!userSessions.length) return null;
    const sorted = [...userSessions].sort(
      (left, right) => getSessionPriority(right.state) - getSessionPriority(left.state)
    );
    const primary = sorted[0];
    if (!primary) return null;
    return {
      state: primary.state ?? 'unknown',
      mediaTitle: primary.item?.title ?? 'Unknown Title',
      serviceType: primary.server?.service ?? null,
      serverName: primary.server?.name ?? null,
      sessionCount: userSessions.length,
    };
  }, [lastSessionData?.sessions, user.uuid]);
  const playbackInfo = nowPlaying ? getPlaybackInfo(nowPlaying.state) : null;
  const PlaybackIcon = playbackInfo?.icon as IconDefinition | undefined;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        {nowPlaying && playbackInfo && PlaybackIcon ? (
          <Card>
            <CardHeader>
              <CardTitle>Now Playing</CardTitle>
              <CardDescription>Live session status for this user.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className={cn(
                "relative overflow-hidden rounded-md border p-2.5",
                playbackInfo.bg,
                playbackInfo.border
              )}>
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/50 shadow-sm",
                      playbackInfo.color
                    )}
                  >
                    <FontAwesomeIcon
                      icon={PlaybackIcon}
                      className={cn("h-4 w-4", playbackInfo.spin && "animate-spin")}
                    />
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
                          <span className="text-[10px] text-muted-foreground/60">·</span>
                          <span className="text-[10px] text-muted-foreground font-medium truncate max-w-[140px]" title={nowPlaying.serverName}>
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
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Account Snapshot</CardTitle>
            <CardDescription>
              Core identity and service information pulled from connected systems.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            <div className="space-y-3 text-sm">
              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faAt} className="mt-1 text-blue-600 dark:text-blue-400" />
                <div>
                  <div className="text-muted-foreground">Email</div>
                  <div className="font-medium">{user.email ?? user.external_email ?? 'Not provided'}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <FontAwesomeIcon icon={faIdCard} className="mt-1 text-green-600 dark:text-green-400" />
                <div>
                  <div className="text-muted-foreground">Username</div>
                  <div className="font-medium">
                    {user.local_username ?? user.external_username ?? user.username ?? 'Unknown'}
                  </div>
                </div>
              </div>

              {user.external_user_id ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faFingerprint} className="mt-1 text-amber-600 dark:text-amber-400" />
                  <div>
                    <div className="text-muted-foreground">External User ID</div>
                    <div className="font-mono text-sm">{user.external_user_id}</div>
                  </div>
                </div>
              ) : null}

              {user.service_join_date ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faCalendarPlus} className="mt-1 text-primary" />
                  <div>
                    <div className="text-muted-foreground">Service Join Date</div>
                    <div className="font-medium">{formatDateTime(user.service_join_date, false)}</div>
                  </div>
                </div>
              ) : null}

              {user.server_names.length > 0 ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faServer} className="mt-1 text-secondary" />
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      Connected {user.server_names.length > 1 ? 'Servers' : 'Server'}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {user.server_names.map((server) => (
                        <Badge
                          key={server}
                          color={theme.palette?.avatar ?? 'bg-primary'}
                          className="text-xs font-semibold gap-2"
                          hover={false}
                        >
                          <FontAwesomeIcon icon={faDatabase} className="w-3 h-3" />
                          {server}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {isServiceUser && user.linked_local_user ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faLink} className="mt-1 text-primary" />
                  <div>
                    <div className="text-muted-foreground">Linked Local Account</div>
                    <div className="font-medium">
                      {user.linked_local_user.display_name ?? user.linked_local_user.username ?? 'Local account'}
                    </div>
                    {user.linked_local_user.email ? (
                      <div className="text-xs text-muted-foreground">{user.linked_local_user.email}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {user.discord_username || user.discord_user_id ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faDiscord} className="mt-1 text-indigo-500" />
                  <div>
                    <div className="text-muted-foreground">Discord</div>
                    <div className="font-medium">
                      {user.discord_username ?? user.discord_user_id ?? 'Linked account'}
                    </div>
                    {user.discord_email ? (
                      <div className="text-xs text-muted-foreground">{user.discord_email}</div>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {(user.is_active || !user.is_active || user.is_home_user || user.shares_back || user.is_purge_whitelisted || user.is_discord_bot_whitelisted) && (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-foreground">Status Flags</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {user.is_active && (
                    <Badge color="bg-green-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faCircleCheck} className="w-3 h-3 mt-0.5" />
                      Active
                    </Badge>
                  )}
                  {!user.is_active && (
                    <Badge color="bg-amber-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faCircleXmark} className="w-3 h-3 mt-0.5" />
                      Inactive
                    </Badge>
                  )}
                  {user.is_home_user && (
                    <Badge color="bg-blue-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faHouse} className="w-3 h-3 mt-0.5" />
                      Home User
                    </Badge>
                  )}
                  {user.shares_back && (
                    <Badge color="bg-purple-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faShareNodes} className="w-3 h-3 mt-0.5" />
                      Shares Back
                    </Badge>
                  )}
                  {user.is_purge_whitelisted && (
                    <Badge color="bg-amber-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faShieldHalved} className="w-3 h-3 mt-0.5" />
                      Purge Protected
                    </Badge>
                  )}
                  {user.is_discord_bot_whitelisted && (
                    <Badge color="bg-blue-600" className="text-xs font-semibold gap-1" hover={false}>
                      <FontAwesomeIcon icon={faDiscord} className="w-3 h-3 mt-0.5" />
                      Discord Bot Allowed
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {user.libraries.length > 0 || isServiceUser ? (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-foreground">Library Access</div>
                {user.has_all_libraries ? (
                  <p className="mt-2 text-sm text-muted-foreground">Has access to all libraries on this server.</p>
                ) : user.libraries.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No specific libraries assigned.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {user.libraries.map((library) => (
                      <Badge
                        key={library}
                        color={theme.palette?.avatar ?? 'bg-primary'}
                        className="text-xs font-medium gap-2"
                        hover={false}
                      >
                        <FontAwesomeIcon icon={faFolder} className="w-3 h-3" />
                        {library}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Roles & Permissions</CardTitle>
            <CardDescription>
              Visual roles and administrative access assigned to this account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">

            <div>
              <div className="text-xs uppercase text-muted-foreground/60">Admin Roles</div>
              {adminRoleBadges.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No admin roles assigned.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {adminRoleBadges.map((role) => (
                    <Badge
                      key={role.name}
                      hexColor={role.color}
                      iconClass={role.icon}
                      roleKind="admin"
                      badgeStyle={role.badge_style ?? undefined}
                      className="text-xs font-semibold"
                      title={role.description ?? undefined}
                      hover={false}
                    >
                      {role.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-xs uppercase text-muted-foreground/60">User Roles</div>
              {roleBadges.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No visual roles have been added yet.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {roleBadges.map((role) => (
                    <Badge
                      key={role.name}
                      hexColor={role.color}
                      iconClass={role.icon}
                      roleKind="user"
                      badgeStyle={role.badge_style ?? undefined}
                      className="text-xs font-medium"
                      title={role.description ?? undefined}
                      hover={false}
                    >
                      {role.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Global Streaming Stats</CardTitle>
            <CardDescription>
              Aggregated playback history compiled across all connected services.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {Object.keys(globalStats).length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <FontAwesomeIcon icon={faChartSimple} className="text-3xl" />
                <p className="text-sm">No streaming activity has been recorded for this user yet.</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  {
                    title: 'Last 24 Hours',
                    plays: globalStats.plays_24h ?? 0,
                    duration: globalStats.duration_24h,
                    gradient: 'from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20',
                    icon: <FontAwesomeIcon icon={faClock} className="text-blue-600 dark:text-blue-300" />
                  },
                  {
                    title: 'Last 7 Days',
                    plays: globalStats.plays_7d ?? 0,
                    duration: globalStats.duration_7d,
                    gradient: 'from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20',
                    icon: <FontAwesomeIcon icon={faCalendarWeek} className="text-green-600 dark:text-green-300" />
                  },
                  {
                    title: 'Last 30 Days',
                    plays: globalStats.plays_30d ?? 0,
                    duration: globalStats.duration_30d,
                    gradient: 'from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20',
                    icon: <FontAwesomeIcon icon={faCalendarDays} className="text-purple-600 dark:text-purple-300" />
                  },
                  {
                    title: 'All Time',
                    plays: globalStats.all_time_plays ?? 0,
                    duration: globalStats.all_time_duration,
                    gradient: 'from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20',
                    icon: <FontAwesomeIcon icon={faInfinity} className="text-orange-600 dark:text-orange-300" />
                  }
                ].map((stat) => (
                  <div
                    key={stat.title}
                    className={cn(
                      'rounded-xl border border-border p-4 shadow-sm transition-shadow hover:shadow-md',
                      `bg-gradient-to-br ${stat.gradient}`
                    )}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                      {stat.icon}
                      {stat.title}
                    </div>
                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="text-3xl font-bold text-foreground">{formatNumber(stat.plays)}</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground/60">plays</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Watch time: {formatDuration(stat.duration)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>Preferred Players</CardTitle>
              <CardDescription>Top devices or apps used to play content.</CardDescription>
            </div>
            {playerStats.length > 0 ? (
              <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium bg-muted text-muted-foreground">
                <FontAwesomeIcon icon={faLayerGroup} className="mr-1" />
                {playerStats.length} unique players
              </span>
            ) : null}
          </CardHeader>
          <CardContent>
            {playerStats.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <FontAwesomeIcon icon={faTv} className="text-3xl" />
                <p className="text-sm">No player telemetry has been captured yet.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {playerStats.map((player) => (
                  <div
                    key={player?.name ?? 'unknown'}
                    className="rounded-xl border border-border bg-muted/40 p-4 text-center shadow-sm transition-shadow hover:shadow-md dark:border-border/70 dark:bg-muted/20"
                  >
                    <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FontAwesomeIcon icon={faPlay} className="text-xl" />
                    </div>
                    <div className="mb-3 text-sm font-semibold text-foreground" title={player?.name ?? 'Unknown'}>
                      {player?.name ?? 'Unknown Player'}
                    </div>
                    <div className="flex items-baseline justify-center gap-1">
                      <span className="text-2xl font-bold text-primary">
                        {formatNumber(player?.plays ?? 0)}
                      </span>
                      <span className="text-xs text-muted-foreground">plays</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

type HistoryTabProps = {
  entries: UserHistoryEntry[];
  loading: boolean;
  error?: Error | null;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

const HistoryTab = ({ entries, loading, error, currentPage, totalPages, onPageChange }: HistoryTabProps) => {
  const formatDuration = (seconds?: number | null) => {
    if (!seconds) return '0m';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins > 0) {
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }
    return `${secs}s`;
  };

  const formatProgress = (viewOffset?: number | null, totalDuration?: number | null) => {
    if (!viewOffset || !totalDuration || totalDuration === 0) return 0;
    return Math.min(Math.round((viewOffset / totalDuration) * 100), 100);
  };

  return (
    <section className="space-y-4">
      {loading && entries.length === 0 ? (
        <div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Fetching recent history…
        </div>
      ) : null}
      {error ? (
        <div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          Failed to load history: {error.message}
        </div>
      ) : null}

      {entries.length === 0 && !loading ? (
        <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground/60">
          <FontAwesomeIcon icon={faClockRotateLeft} className="text-3xl" />
          <p className="text-sm">No streaming history to display yet.</p>
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Streaming history and playback sessions</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="w-20 py-3 px-4 text-sm font-medium text-muted-foreground">Poster</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Media Title</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Player / Platform</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Started</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">Duration</th>
                    <th className="text-center py-3 px-4 text-sm font-medium text-muted-foreground">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const details = entry.details || {};
                    const progress = formatProgress(
                      details.view_offset_at_end_seconds as number,
                      details.duration_seconds as number
                    );

                    return (
                      <tr key={entry.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                        <td className="py-3 px-4">
                          <div className="w-12 h-18 rounded bg-muted/30 flex items-center justify-center overflow-hidden">
                            {details.poster_url ? (
                              <img
                                src={details.poster_url as string}
                                alt={details.media_title as string || 'Media poster'}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                  (e.target as HTMLImageElement).parentElement!.innerHTML = '<span class="text-muted-foreground/40 text-sm">▶</span>';
                                }}
                              />
                            ) : (
                              <FontAwesomeIcon icon={faPlay} className="text-muted-foreground/40 text-sm" />
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium">{details.media_title as string || 'Unknown Title'}</div>
                          {details.grandparent_title && (
                            <div className="text-xs text-muted-foreground">{details.grandparent_title as string}</div>
                          )}
                          {details.library_name && (
                            <div className="text-xs text-muted-foreground/60">
                              <FontAwesomeIcon icon={faFolder} className="mr-1 h-3 w-3" />
                              {details.library_name as string}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-medium text-sm">{details.player as string || 'Unknown Player'}</div>
                          <div className="text-xs text-muted-foreground">
                            {details.platform as string || details.product as string || 'Unknown Platform'}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-sm">{entry.timestamp ? formatDateTime(entry.timestamp, false) : 'N/A'}</div>
                          {entry.timestamp && (
                            <div className="text-xs text-muted-foreground">
                              {new Date(entry.timestamp).toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit'
                              })}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-sm font-medium">
                            {formatDuration(details.view_offset_at_end_seconds as number)}
                          </div>
                          {details.duration_seconds && (
                            <div className="text-xs text-muted-foreground">
                              of {formatDuration(details.duration_seconds as number)}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          <div className="inline-flex items-center justify-center">
                            <div className="relative size-12">
                              <svg className="size-12 transform -rotate-90">
                                <circle
                                  cx="24"
                                  cy="24"
                                  r="20"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                  fill="none"
                                  className="text-muted/30"
                                />
                                <circle
                                  cx="24"
                                  cy="24"
                                  r="20"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                  fill="none"
                                  strokeDasharray={`${2 * Math.PI * 20}`}
                                  strokeDashoffset={`${2 * Math.PI * 20 * (1 - progress / 100)}`}
                                  className="text-primary transition-all"
                                />
                              </svg>
                              <div className="absolute inset-0 flex items-center justify-center">
                                <span className="text-xs font-mono font-semibold">{progress}%</span>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={onPageChange}
              loading={loading}
            />
          </CardContent>
        </Card>
      )}
    </section>
  );
};

type SettingsTabProps = {
  settings: UserSettings | null;
  settingsLoading: boolean;
  settingsError?: Error | null;
  onSaveSettings: (payload: Partial<UserSettings>) => Promise<void>;
  serviceAccounts: ServiceAccount[];
  serviceAccountsLoading: boolean;
  serviceAccountsError?: Error | null;
  onLinkAccount?: () => void;
  onUnlinkAccount: (serviceUuid: string) => Promise<void>;
  allowLinking: boolean;
};

const SettingsTab = ({
  settings,
  settingsLoading,
  settingsError,
  onSaveSettings,
  serviceAccounts,
  serviceAccountsLoading,
  serviceAccountsError,
  onLinkAccount,
  onUnlinkAccount,
  allowLinking
}: SettingsTabProps) => (
  <div className="space-y-6">
    <UserSettingsCard settings={settings} loading={settingsLoading} error={settingsError ?? undefined} onSave={onSaveSettings} />
    {allowLinking ? (
      <ServiceAccountsCard
        accounts={serviceAccounts}
        loading={serviceAccountsLoading}
        error={serviceAccountsError ?? undefined}
        onLink={onLinkAccount}
        onUnlink={onUnlinkAccount}
      />
    ) : null}
  </div>
);

type SecurityTabProps = {
  user: UserDetail;
  onResetPassword: () => Promise<void>;
  resetting: boolean;
};

const SecurityTab = ({ user, onResetPassword, resetting }: SecurityTabProps) => (
  <div className="space-y-6">
    <section className="rounded-lg border border-border bg-background shadow-sm">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Login Activity</h3>
            <p className="text-sm text-muted-foreground">Recent access details for this local account.</p>
          </div>
          <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-muted text-muted-foreground">
            <FontAwesomeIcon icon={faUserClock} className="mr-1" />
            {user.is_active ? 'Active' : 'Inactive'}
          </span>
        </header>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="text-xs uppercase text-muted-foreground/60">Last Login</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatDateTime(user.last_login_at)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="text-xs uppercase text-muted-foreground/60">Last Activity</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatDateTime(user.last_activity_at)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="text-xs uppercase text-muted-foreground/60">Account Created</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatDateTime(user.created_at)}</div>
          </div>
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <div className="text-xs uppercase text-muted-foreground/60">Access Expires</div>
            <div className="mt-1 text-lg font-semibold text-foreground">
              {user.access_expires_at ? formatDateTime(user.access_expires_at) : 'Never'}
            </div>
          </div>
        </div>
      </div>
    </section>

    <section className="rounded-lg border border-border bg-background shadow-sm">
      <div className="p-6 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Password & Account Security</h3>
            <p className="text-sm text-muted-foreground">Enforce password resets and review security posture.</p>
          </div>
          {user.has_password ? (
            <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-300 gap-2">
              <FontAwesomeIcon icon={faLock} />
              Password Protected
            </span>
          ) : (
            <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 gap-2">
              <FontAwesomeIcon icon={faUnlock} />
              No Password Set
            </span>
          )}
        </header>

        <div className="rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold text-foreground">Force Password Change</div>
              <p className="text-sm text-muted-foreground">
                Trigger a password reset flow for the next login session.
              </p>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-amber-300 bg-transparent text-amber-700 hover:bg-amber-50 h-9 px-4 py-2 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
              onClick={onResetPassword}
              disabled={resetting}
            >
              <FontAwesomeIcon icon={faKey} className="mr-2" />
              {resetting ? 'Resetting…' : 'Reset Password'}
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-border bg-muted/30 p-4 text-sm">
            <div className="text-muted-foreground">Invite Usage</div>
            <div className="mt-1 text-base font-semibold text-foreground">
              {user.used_invite ? 'Linked to invite code' : 'No invite usage recorded'}
            </div>
          </div>
          <div className="rounded border border-border bg-muted/30 p-4 text-sm">
            <div className="text-muted-foreground">Download Permissions</div>
            <div className="mt-1 text-base font-semibold text-foreground">
              {user.allow_downloads ? 'Downloads enabled' : 'Downloads disabled'}
            </div>
            <div className="text-xs text-muted-foreground/60">
              4K transcode {user.allow_4k_transcode ? 'permitted' : 'blocked'}.
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
);

export const UserDetailPage = () => {
  const location = useLocation();
  const navigate = useNavigate();
  // Read params from TanStack Router (route matches: /admin/users/$uuid or /admin/users/$serverNickname/$username)
  const { uuid: uuidParam, serverNickname, username } = (useParams({ strict: false }) as {
    uuid?: string;
    serverNickname?: string;
    username?: string;
  });

  const locationState = location.state as { userUuid?: string } | undefined;
  const stateUuid = locationState?.userUuid;

  const needsSlugLookup = !uuidParam && !stateUuid && serverNickname && username;
  const {
    uuid: slugUuid,
    loading: slugLoading,
    error: slugError
  } = useUserUuidBySlug(needsSlugLookup ? serverNickname : undefined, needsSlugLookup ? username : undefined);
  const effectiveUuid = uuidParam ?? stateUuid ?? slugUuid ?? undefined;

  const search = useSearch({ strict: false }) as { tab?: TabKey; page?: number };
  const activeTab: TabKey = search.tab ?? 'profile';
  const historyPage = search.page ?? 1;
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resettingPassword, setResettingPassword] = useState(false);

  const { success, error: showError } = useAlerts();
  const { user, loading, error } = useUserDetail(effectiveUuid);
  const userType = user?.user_type?.toLowerCase();
  const canManageServiceAccounts = Boolean(effectiveUuid) && Boolean(userType) && userType !== 'service';
  const {
    entries: historyEntries,
    loading: historyLoading,
    error: historyError,
    currentPage,
    totalPages
  } = useUserHistoryPaginated(effectiveUuid, historyPage, 10);
  const {
    accounts: serviceAccounts,
    loading: accountsLoading,
    error: accountsError,
    refresh: refreshAccounts
  } = useServiceAccounts(effectiveUuid, canManageServiceAccounts);
  const {
    accounts: availableAccounts,
    loading: availableLoading,
    error: availableError,
    refresh: refreshAvailable
  } = useAvailableServiceAccounts(effectiveUuid, canManageServiceAccounts);
  const {
    overseerrLinks,
    loading: overseerrLoading,
    error: overseerrError
  } = useOverseerr(effectiveUuid);
  const { servers: plexServers } = useServers({ serviceType: 'plex' });
  const {
    settings,
    loading: settingsLoading,
    error: settingsError,
    refresh: refreshSettings
  } = useUserSettings(effectiveUuid);

  const handlePageChange = (page: number) => {
    navigate({
      // @ts-expect-error - TanStack Router types are complex
      search: (prev: any) => ({ ...prev, page })
    });
  };

  if (!effectiveUuid) {
    if (slugLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Resolving user path…
        </div>
      );
    }

    if (slugError) {
      return (
        <div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 p-4 text-sm text-red-600 dark:text-red-400">
          Failed to resolve user path: {String(slugError)}
        </div>
      );
    }

    if (serverNickname && username) {
      return (
        <div className="rounded border border-border bg-background p-4 text-sm text-muted-foreground">
          Could not locate a user for <span className="font-semibold">{serverNickname}</span> /{' '}
          <span className="font-semibold">{username}</span>.
        </div>
      );
    }

    return <div className="text-sm text-muted-foreground">No user selected.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading user profile…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 p-4 text-sm text-red-600 dark:text-red-400">
        Failed to load user profile: {(error as Error).message}
      </div>
    );
  }

  if (!user) {
    return <div className="text-sm text-muted-foreground">User not found.</div>;
  }

  const isServiceUser = user.user_type.toLowerCase() === 'service';
  const plexServerNicknames = new Set(
    (user.server_names ?? [])
      .map((name) => name?.toLowerCase())
      .filter((name): name is string => Boolean(name))
  );
  const isPlexUser = (user.service_types ?? []).some((type) => type?.toLowerCase() === 'plex');
  const plexServerWithOverseerr = plexServers.find(
    (server) =>
      server.overseerr_enabled &&
      (plexServerNicknames.has(server.server_nickname?.toLowerCase() ?? '') ||
        plexServerNicknames.has(server.server_name?.toLowerCase() ?? ''))
  );
  const showOverseerrTab = isPlexUser && Boolean(plexServerWithOverseerr);
  const showSecurityTab = !isServiceUser && user.has_password && user.used_invite;

  const heroTheme = getServiceMeta(user.service_type ?? user.service_types?.[0]);
  const effectiveAvatar = user.avatar_url ?? user.discord_avatar_url;
  const initials = (user.display_name ?? user.username ?? 'U').slice(0, 2).toUpperCase();

  const tabs: Array<{ key: TabKey; label: string; hidden?: boolean }> = [
    { key: 'profile', label: 'Profile' },
    { key: 'history', label: 'History' },
    { key: 'settings', label: 'Settings' },
    { key: 'overseerr', label: 'Overseerr', hidden: !showOverseerrTab },
    { key: 'security', label: 'Security', hidden: !showSecurityTab }
  ];

  const handleResetPassword = async () => {
    if (resettingPassword) return;
    setResettingPassword(true);
    try {
      await requestJson(`/api/v2/users/${user.uuid}/reset-password`, {
        method: 'POST'
      });
      success('User will be prompted to set a new password on next login.');
    } catch (err) {
      showError('Password reset failed: ' + String(err));
    } finally {
      setResettingPassword(false);
    }
  };

  const handleUnlink = async (serviceUuid: string) => {
    try {
      await requestJson(`/api/v2/users/${user.uuid}/service-accounts/${serviceUuid}`, {
        method: 'DELETE'
      });
      await refreshAccounts();
      success('Service account unlinked');
    } catch (err) {
      showError('Unlink failed: ' + String(err));
    }
  };

  const handleLink = async (serviceUuid: string) => {
    await requestJson(`/api/v2/users/${user.uuid}/service-accounts`, {
      method: 'POST',
      body: JSON.stringify({ service_uuid: serviceUuid })
    });
    await Promise.all([refreshAccounts(), refreshAvailable()]);
    success('Service account linked');
  };

  const handleSaveSettings = async (payload: Partial<UserSettings>) => {
    await requestJson(`/api/v2/users/${user.uuid}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    });
    await refreshSettings();
    success('Settings saved');
  };

  const handleResync = async () => {
    if (resyncing) return;
    setResyncing(true);
    try {
      await requestJson(`/api/v2/users/${user.uuid}/sync`, {
        method: 'POST'
      });
      await Promise.all([refreshAccounts(), refreshAvailable()]);
      success('Linked service accounts are being refreshed.');
    } catch (err) {
      showError('Sync failed: ' + String(err));
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-border bg-background shadow-lg">
        <div className={cn('bg-gradient-to-r p-8 text-center border-b border-border', heroTheme.gradient)}>
          <div className="flex flex-col items-center space-y-4">
            {/* Avatar */}
            <div className="avatar">
              <div className="w-24 h-24 rounded-full ring-4 ring-primary/30 ring-offset-4 ring-offset-background">
                {effectiveAvatar ? (
                  <img
                    src={effectiveAvatar}
                    alt={user.display_name ?? user.username ?? 'User avatar'}
                    className="w-24 h-24 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-normal text-white"
                    style={{
                      backgroundColor: isServiceUser
                        ? `var(--color-${user.service_type?.toLowerCase() ?? 'primary'}, #3b82f6)`
                        : 'var(--color-primary, #3b82f6)'
                    }}
                  >
                    {initials}
                  </div>
                )}
              </div>
            </div>

            {/* User Info */}
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">
                {user.display_name ?? user.username ?? 'User'}
              </h1>
              <div className="flex items-center justify-center gap-2 flex-wrap">
                {!isServiceUser ? (
                  <>
                    <Badge color="bg-primary" className="text-sm font-medium px-3 py-1 gap-2" hover={false}>
                      <FontAwesomeIcon icon={faUser} className="h-4 w-4" />
                      Local Account
                    </Badge>

                    {/* Show badges for linked service accounts */}
                    {serviceAccounts.map((serviceAccount) => {
                      const serviceTheme = getServiceMeta(serviceAccount.service_type);
                      return (
                        <Badge
                          key={serviceAccount.uuid}
                          color={serviceTheme.palette?.avatar ?? 'bg-primary'}
                          className="text-sm font-medium gap-2"
                          hover={false}
                        >
                          {serviceTheme.icon}
                          {serviceAccount.display_name ?? serviceAccount.username}
                        </Badge>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <Badge color={heroTheme.palette?.avatar ?? 'bg-primary'} className="text-sm font-medium gap-2" hover={false}>
                      <FontAwesomeIcon icon={faServer} className="h-3 w-3 mb-0.5" />
                      {user.server_nickname || `${heroTheme.label} User`}
                    </Badge>

                    {/* Show linked local user badge if this service user is linked to a local account */}
                    {user.linked_local_user && (
                      <Badge color="bg-primary" className="text-sm font-medium px-3 py-1 gap-2" hover={false}>
                        <FontAwesomeIcon icon={faLink} className="h-4 w-4" />
                        {user.linked_local_user.display_name ?? user.linked_local_user.username ?? 'Local account'}
                      </Badge>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg bg-background">
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            // @ts-expect-error - TanStack Router types are complex, using any for search
            navigate({ search: (prev: any) => ({ ...prev, tab: value as TabKey }) });
          }}
        >
          <TabsList className="w-full justify-start overflow-x-auto">
            {tabs
              .filter((tab) => !tab.hidden)
              .map((tab) => (
                <TabsTrigger key={tab.key} value={tab.key}>
                  {tab.label}
                </TabsTrigger>
              ))}
          </TabsList>

          <TabsContent value="profile" className="pt-5">
            <ProfileTab user={user} />
          </TabsContent>

          <TabsContent value="history" className="pt-5">
            <HistoryTab
              entries={historyEntries}
              loading={historyLoading}
              error={(historyError as Error) ?? undefined}
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePageChange}
            />
          </TabsContent>

          <TabsContent value="settings" className="pt-5">
            <SettingsTab
              settings={settings}
              settingsLoading={settingsLoading}
              settingsError={(settingsError as Error) ?? undefined}
              onSaveSettings={async (payload) => {
                await handleSaveSettings(payload);
              }}
              serviceAccounts={serviceAccounts}
              serviceAccountsLoading={accountsLoading}
              serviceAccountsError={(accountsError as Error) ?? undefined}
              onLinkAccount={
                !isServiceUser
                  ? () => {
                      refreshAvailable();
                      setLinkModalOpen(true);
                    }
                  : undefined
              }
              onUnlinkAccount={handleUnlink}
              allowLinking={!isServiceUser}
            />
          </TabsContent>

          <TabsContent value="overseerr" className="pt-5">
            <OverseerrCard
              links={overseerrLinks}
              loading={overseerrLoading}
              error={(overseerrError as Error) ?? undefined}
            />
          </TabsContent>

          <TabsContent value="security" className="pt-5">
            <SecurityTab user={user} onResetPassword={handleResetPassword} resetting={resettingPassword} />
          </TabsContent>
        </Tabs>
      </section>

      <ServiceAccountLinkModal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        accounts={availableAccounts}
        loading={availableLoading}
        error={(availableError as Error) ?? undefined}
        onSubmit={async (serviceUuid) => {
          try {
            await handleLink(serviceUuid);
            setLinkModalOpen(false);
          } catch (err) {
            showError('Link failed: ' + String(err));
            throw err;
          }
        }}
      />
    </div>
  );
};

export default UserDetailPage;
