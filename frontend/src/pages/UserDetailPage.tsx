import { ReactNode, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useAlerts } from '../contexts/AlertContext';
import { useUserDetail, UserDetail, UserHistoryEntry } from '../hooks/useUserDetail';
import { useUserHistory } from '../hooks/useUserHistory';
import { useServiceAccounts } from '../hooks/useServiceAccounts';
import { useAvailableServiceAccounts } from '../hooks/useAvailableServiceAccounts';
import { useOverseerr } from '../hooks/useOverseerr';
import { useServers } from '../hooks/useServers';
import { useUserSettings } from '../hooks/useUserSettings';
import { useUserUuidBySlug } from '../hooks/useUserUuidBySlug';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';

type TabKey = 'profile' | 'history' | 'settings' | 'overseerr' | 'security';

type ServiceTheme = {
  label: string;
  gradient: string;
  badgeClass: string;
  chipClass: string;
  icon: ReactNode;
};

const plexIcon = (
  <svg className="h-4 w-4" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
    <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
  </svg>
);

const defaultTheme: ServiceTheme = {
  label: 'Media Server',
  gradient: 'from-primary/10 via-primary/5 to-secondary/10',
  badgeClass: 'bg-primary/10 text-primary ring-primary/20',
  chipClass: 'bg-primary/10 text-primary ring-primary/20',
  icon: <i className="fa-solid fa-server" />
};

const serviceThemes: Record<string, ServiceTheme> = {
  plex: {
    label: 'Plex',
    gradient: 'from-plex/10 via-plex/10 to-plex/20',
    badgeClass: 'bg-plex-50 text-plex-700 ring-plex-500/30 dark:bg-plex-400/10 dark:text-plex-300',
    chipClass: 'bg-plex-100 text-plex-700 ring-plex-600/30 dark:bg-plex-400/20 dark:text-plex-200',
    icon: plexIcon
  },
  jellyfin: {
    label: 'Jellyfin',
    gradient: 'from-jellyfin/10 via-jellyfin/10 to-jellyfin/20',
    badgeClass: 'bg-jellyfin-50 text-jellyfin-700 ring-jellyfin-500/30 dark:bg-jellyfin-400/10 dark:text-jellyfin-300',
    chipClass: 'bg-jellyfin-100 text-jellyfin-700 ring-jellyfin-600/30 dark:bg-jellyfin-400/20 dark:text-jellyfin-200',
    icon: <i className="fa-solid fa-cube" />
  },
  emby: {
    label: 'Emby',
    gradient: 'from-emby/10 via-emby/10 to-emby/20',
    badgeClass: 'bg-emby-50 text-emby-700 ring-emby-500/30 dark:bg-emby-400/10 dark:text-emby-300',
    chipClass: 'bg-emby-100 text-emby-700 ring-emby-600/30 dark:bg-emby-400/20 dark:text-emby-200',
    icon: <i className="fa-solid fa-play-circle" />
  },
  kavita: {
    label: 'Kavita',
    gradient: 'from-kavita/10 via-kavita/10 to-kavita/20',
    badgeClass: 'bg-kavita-50 text-kavita-700 ring-kavita-500/30 dark:bg-kavita-400/10 dark:text-kavita-300',
    chipClass: 'bg-kavita-100 text-kavita-700 ring-kavita-600/30 dark:bg-kavita-400/20 dark:text-kavita-200',
    icon: <i className="fa-solid fa-book" />
  },
  audiobookshelf: {
    label: 'AudiobookShelf',
    gradient: 'from-audiobookshelf/10 via-audiobookshelf/10 to-audiobookshelf/20',
    badgeClass:
      'bg-audiobookshelf-50 text-audiobookshelf-700 ring-audiobookshelf-500/30 dark:bg-audiobookshelf-400/10 dark:text-audiobookshelf-300',
    chipClass:
      'bg-audiobookshelf-100 text-audiobookshelf-700 ring-audiobookshelf-600/30 dark:bg-audiobookshelf-400/20 dark:text-audiobookshelf-200',
    icon: <i className="fa-solid fa-headphones" />
  },
  komga: {
    label: 'Komga',
    gradient: 'from-komga/10 via-komga/10 to-komga/20',
    badgeClass: 'bg-komga-50 text-komga-700 ring-komga-500/30 dark:bg-komga-400/10 dark:text-komga-300',
    chipClass: 'bg-komga-100 text-komga-700 ring-komga-600/30 dark:bg-komga-400/20 dark:text-komga-200',
    icon: <i className="fa-solid fa-book-open" />
  },
  romm: {
    label: 'RomM',
    gradient: 'from-romm/10 via-romm/10 to-romm/20',
    badgeClass: 'bg-romm-50 text-romm-700 ring-romm-500/30 dark:bg-romm-400/10 dark:text-romm-300',
    chipClass: 'bg-romm-100 text-romm-700 ring-romm-600/30 dark:bg-romm-400/20 dark:text-romm-200',
    icon: <i className="fa-solid fa-gamepad" />
  }
};

const getServiceTheme = (serviceType?: string | null): ServiceTheme => {
  if (!serviceType) {
    return defaultTheme;
  }
  const key = serviceType.toLowerCase();
  return serviceThemes[key] ?? defaultTheme;
};

const formatDateTime = (value?: string | null, withTime = true) => {
  if (!value) return '—';
  const date = new Date(value);
  return date.toLocaleString(undefined, withTime ? undefined : { dateStyle: 'medium' });
};

const formatDuration = (value?: string | null) => value || '0m';
const formatNumber = (value?: number | null) => (typeof value === 'number' ? value.toLocaleString() : '0');

const ProfileTab = ({ user }: { user: UserDetail }) => {
  const theme = getServiceTheme(user.service_type ?? user.service_types?.[0]);
  const globalStats = user.stream_stats?.global ?? {};
  const playerStats = user.stream_stats?.players ?? [];
  const isServiceUser = user.user_type.toLowerCase() === 'service';

  const statusBadges = [
    user.is_active && { label: 'Active', icon: <i className="fa-solid fa-circle-check" />, className: 'bg-green-100 text-green-700 ring-green-600/20 dark:bg-green-400/10 dark:text-green-300' },
    !user.is_active && { label: 'Inactive', icon: <i className="fa-solid fa-circle-xmark" />, className: 'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300' },
    user.is_home_user && { label: 'Home User', icon: <i className="fa-solid fa-house" />, className: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300' },
    user.shares_back && { label: 'Shares Back', icon: <i className="fa-solid fa-share-nodes" />, className: 'bg-purple-100 text-purple-700 ring-purple-600/20 dark:bg-purple-400/10 dark:text-purple-300' },
    user.is_purge_whitelisted && {
      label: 'Purge Protected',
      icon: <i className="fa-solid fa-shield-halved" />,
      className: 'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-400/10 dark:text-amber-300'
    },
    user.is_discord_bot_whitelisted && {
      label: 'Discord Bot Allowed',
      icon: <i className="fa-brands fa-discord" />,
      className: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-400/10 dark:text-blue-300'
    }
  ].filter(Boolean) as Array<{ label: string; icon: ReactNode; className: string }>;

  const roleBadges = user.user_roles_detail;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6">
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
                <i className="fa-solid fa-at mt-1 text-blue-600 dark:text-blue-400" />
                <div>
                  <div className="text-muted-foreground">Email</div>
                  <div className="font-medium">{user.email ?? user.external_email ?? 'Not provided'}</div>
                </div>
              </div>

              <div className="flex items-start gap-3">
                <i className="fa-solid fa-id-card mt-1 text-green-600 dark:text-green-400" />
                <div>
                  <div className="text-muted-foreground">Username</div>
                  <div className="font-medium">
                    {user.local_username ?? user.external_username ?? user.username ?? 'Unknown'}
                  </div>
                </div>
              </div>

              {user.external_user_id ? (
                <div className="flex items-start gap-3">
                  <i className="fa-solid fa-fingerprint mt-1 text-amber-600 dark:text-amber-400" />
                  <div>
                    <div className="text-muted-foreground">External User ID</div>
                    <div className="font-mono text-sm">{user.external_user_id}</div>
                  </div>
                </div>
              ) : null}

              {user.service_join_date ? (
                <div className="flex items-start gap-3">
                  <i className="fa-solid fa-calendar-plus mt-1 text-primary" />
                  <div>
                    <div className="text-muted-foreground">Service Join Date</div>
                    <div className="font-medium">{formatDateTime(user.service_join_date, false)}</div>
                  </div>
                </div>
              ) : null}

              {user.server_names.length > 0 ? (
                <div className="flex items-start gap-3">
                  <i className="fa-solid fa-server mt-1 text-secondary" />
                  <div className="space-y-1">
                    <div className="text-muted-foreground">
                      Connected {user.server_names.length > 1 ? 'Servers' : 'Server'}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {user.server_names.map((server) => (
                        <span
                          key={server}
                          className={cn(
                            'inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset',
                            theme.chipClass
                          )}
                        >
                          <i className="fa-solid fa-database" />
                          {server}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {isServiceUser && user.linked_local_user ? (
                <div className="flex items-start gap-3">
                  <i className="fa-solid fa-link mt-1 text-primary" />
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
                  <i className="fa-brands fa-discord mt-1 text-indigo-500" />
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

            {statusBadges.length > 0 ? (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-foreground">Status Flags</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {statusBadges.map((badge) => (
                    <span key={badge.label} className={cn('badge gap-2 text-xs', badge.className)}>
                      {badge.icon}
                      {badge.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

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
                      <span
                        key={library}
                        className={cn(
                          'inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
                          theme.chipClass
                        )}
                      >
                        <i className="fa-solid fa-folder" />
                        {library}
                      </span>
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
              {user.roles.admin_roles.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">No admin roles assigned.</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {user.roles.admin_roles.map((role) => (
                    <span
                      key={role}
                      className="inline-flex items-center gap-2 rounded-md bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700 ring-1 ring-inset ring-rose-200 dark:bg-rose-400/10 dark:text-rose-200 dark:ring-rose-400/30"
                    >
                      <i className="fa-solid fa-user-shield" />
                      {role}
                    </span>
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
                    <span
                      key={role.name}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset',
                        role.color ? undefined : 'bg-secondary/10 text-secondary ring-secondary/20'
                      )}
                      style={
                        role.color
                          ? { backgroundColor: `${role.color}20`, color: role.color, borderColor: `${role.color}40` }
                          : undefined
                      }
                      title={role.description ?? undefined}
                    >
                      {role.icon ? <i className={role.icon} /> : null}
                      {role.name}
                    </span>
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
                <i className="fa-solid fa-chart-simple text-3xl" />
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
                    icon: <i className="fa-solid fa-clock text-blue-600 dark:text-blue-300" />
                  },
                  {
                    title: 'Last 7 Days',
                    plays: globalStats.plays_7d ?? 0,
                    duration: globalStats.duration_7d,
                    gradient: 'from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20',
                    icon: <i className="fa-solid fa-calendar-week text-green-600 dark:text-green-300" />
                  },
                  {
                    title: 'Last 30 Days',
                    plays: globalStats.plays_30d ?? 0,
                    duration: globalStats.duration_30d,
                    gradient: 'from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20',
                    icon: <i className="fa-solid fa-calendar-days text-purple-600 dark:text-purple-300" />
                  },
                  {
                    title: 'All Time',
                    plays: globalStats.all_time_plays ?? 0,
                    duration: globalStats.all_time_duration,
                    gradient: 'from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20',
                    icon: <i className="fa-solid fa-infinity text-orange-600 dark:text-orange-300" />
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
                <i className="fa-solid fa-layer-group mr-1" />
                {playerStats.length} unique players
              </span>
            ) : null}
          </CardHeader>
          <CardContent>
            {playerStats.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <i className="fa-solid fa-tv text-3xl" />
                <p className="text-sm">No player telemetry has been captured yet.</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {playerStats.map((player) => (
                  <div
                    key={player?.name ?? 'unknown'}
                    className="rounded-xl border border-border bg-muted/40 p-4 text-center shadow-sm transition-shadow hover:shadow-md dark:border-border/70 dark:bg-muted/20"
                  >
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
  onLoadMore: () => void;
  hasMore: boolean;
};

const HistoryTab = ({ entries, loading, error, onLoadMore, hasMore }: HistoryTabProps) => (
  <section className="space-y-4">
    {loading && entries.length === 0 ? (
      <div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
        <i className="fa-solid fa-clock-rotate-left text-3xl" />
        <p className="text-sm">No history entries to display yet.</p>
      </div>
    ) : (
      <ul className="space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="relative rounded border border-border bg-muted/40 p-4 dark:border-border/60 dark:bg-muted/10">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-primary">
                  {entry.event_type ?? 'EVENT'}
                </div>
                <div className="mt-1 text-sm font-medium text-foreground">{entry.message ?? '—'}</div>
              </div>
              <div className="text-xs text-muted-foreground/60">
                {entry.timestamp ? formatDateTime(entry.timestamp) : 'No timestamp'}
              </div>
            </div>
            {entry.details && Object.keys(entry.details).length > 0 ? (
              <pre className="mt-3 overflow-x-auto rounded bg-muted/40 p-3 text-xs text-muted-foreground">
                {JSON.stringify(entry.details, null, 2)}
              </pre>
            ) : null}
          </li>
        ))}
      </ul>
    )}

    <div className="flex justify-center">
      {loading && entries.length > 0 ? (
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : hasMore ? (
        <button type="button" className="text-sm font-medium text-primary hover:underline" onClick={onLoadMore}>
          Load more history
        </button>
      ) : entries.length > 0 ? (
        <span className="text-xs text-muted-foreground/60">End of history</span>
      ) : null}
    </div>
  </section>
);

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
            <i className="fa-solid fa-user-clock mr-1" />
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
              <i className="fa-solid fa-lock" />
              Password Protected
            </span>
          ) : (
            <span className="inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 gap-2">
              <i className="fa-solid fa-unlock" />
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
              <i className="fa-solid fa-key mr-2" />
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
  const currentFrom = (uuidParam ? '/admin/users/$uuid' : '/admin/users/$serverNickname/$username') as const;
  
  const locationState = location.state as { userUuid?: string } | undefined;
  const stateUuid = locationState?.userUuid;

  const needsSlugLookup = !uuidParam && !stateUuid && serverNickname && username;
  const {
    uuid: slugUuid,
    loading: slugLoading,
    error: slugError
  } = useUserUuidBySlug(needsSlugLookup ? serverNickname : undefined, needsSlugLookup ? username : undefined);
  const effectiveUuid = uuidParam ?? stateUuid ?? slugUuid ?? undefined;

  const search = useSearch({ from: currentFrom, strict: false }) as { tab?: TabKey };
  const activeTab: TabKey = search.tab ?? 'profile';
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
    loadMore,
    hasMore
  } = useUserHistory(effectiveUuid);
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

  const combinedHistory = useMemo<UserHistoryEntry[]>(
    () => (historyEntries.length > 0 ? historyEntries : user?.history ?? []),
    [historyEntries, user?.history]
  );

  if (!effectiveUuid) {
    if (slugLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
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
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
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

  const heroTheme = getServiceTheme(user.service_type ?? user.service_types?.[0]);
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
      await requestJson(`/admin/api/v2/users/${user.uuid}/reset-password`, {
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
      await requestJson(`/admin/api/v2/users/${user.uuid}/service-accounts/${serviceUuid}`, {
        method: 'DELETE'
      });
      await refreshAccounts();
      success('Service account unlinked');
    } catch (err) {
      showError('Unlink failed: ' + String(err));
    }
  };

  const handleLink = async (serviceUuid: string) => {
    await requestJson(`/admin/api/v2/users/${user.uuid}/service-accounts`, {
      method: 'POST',
      body: JSON.stringify({ service_uuid: serviceUuid })
    });
    await Promise.all([refreshAccounts(), refreshAvailable()]);
    success('Service account linked');
  };

  const handleSaveSettings = async (payload: Partial<UserSettings>) => {
    await requestJson(`/admin/api/v2/users/${user.uuid}/settings`, {
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
      await requestJson(`/admin/api/v2/users/${user.uuid}/sync`, {
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
                    <span className="inline-flex items-center rounded-md bg-primary/10 px-3 py-1 text-sm font-medium text-primary ring-1 ring-inset ring-primary/20 gap-2">
                      <i className="fa-solid fa-user w-4 h-4" />
                      Local Account
                    </span>

                    {/* Show badges for linked service accounts */}
                    {serviceAccounts.map((serviceAccount) => {
                      const serviceTheme = getServiceTheme(serviceAccount.service_type);
                      return (
                        <span
                          key={serviceAccount.uuid}
                          className={cn(
                            'inline-flex items-center rounded-md px-3 py-1 text-sm font-medium ring-1 ring-inset gap-2',
                            serviceTheme.badgeClass
                          )}
                        >
                          {serviceTheme.icon}
                          {serviceAccount.display_name ?? serviceAccount.username}
                        </span>
                      );
                    })}
                  </>
                ) : (
                  <>
                    {user.server_nickname ? (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md px-3 py-1 text-sm font-medium ring-1 ring-inset gap-2',
                          heroTheme.badgeClass
                        )}
                      >
                        {heroTheme.icon}
                        {user.server_nickname}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'inline-flex items-center rounded-md px-3 py-1 text-sm font-medium ring-1 ring-inset gap-2',
                          heroTheme.badgeClass
                        )}
                      >
                        {heroTheme.icon}
                        {heroTheme.label} User
                      </span>
                    )}

                    {/* Show linked local user badge if this service user is linked to a local account */}
                    {user.linked_local_user ? (
                      <span className="inline-flex items-center rounded-md bg-primary/10 px-3 py-1 text-sm font-medium text-primary ring-1 ring-inset ring-primary/20 gap-2">
                        <i className="fa-solid fa-link w-4 h-4" />
                        {user.linked_local_user.display_name ?? user.linked_local_user.username ?? 'Local account'}
                      </span>
                    ) : null}
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
          onValueChange={(value) =>
            navigate({
              from: currentFrom,
              search: (prev) => ({ ...prev, tab: value as TabKey }),
            })
          }
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
              entries={combinedHistory}
              loading={historyLoading}
              error={(historyError as Error) ?? undefined}
              onLoadMore={loadMore}
              hasMore={hasMore}
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
