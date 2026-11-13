import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useAlerts } from '../contexts/AlertContext';
import { useUserDetail, UserDetail } from '../hooks/useUserDetail';
import {useIdentityHistory,useIdentityCurrent} from '../hooks/useIdentityHistory';
import {observationPosition,observationProgress} from '../lib/activityHistory';
import { useOverseerr } from '../hooks/useOverseerr';
import { useServers } from '../hooks/useServers';
import { useUserUuidBySlug } from '../hooks/useUserUuidBySlug';
import {useIdentitySummary} from '../hooks/useIdentitySummary';
import { requestJson } from '../util/apiClient';
import {
  OverseerrCard
} from '../components/users';
import {ProfileAccountLinks} from '../components/users/ProfileAccountLinks';
import {useProfileAccountSnapshot} from '../hooks/useProfileAccountSnapshot';
import {ProfileNotesCard} from '../components/users/ProfileNotesCard';
import {HumanActivationCard} from '../components/users/HumanActivationCard';
import {HumanCredentialsCard} from '../components/users/HumanCredentialsCard';
import {ServiceExpiryCard} from '../components/users/ServiceExpiryCard';
import {ServiceRemoteAccessCard} from '../components/users/ServiceRemoteAccessCard';
import {ProfileRemoteAccessCard} from '../components/users/ProfileRemoteAccessCard';
import {HumanExpiryCard} from '../components/users/HumanExpiryCard';
import {HumanUserRolesCard} from '../components/users/HumanUserRolesCard';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import { Badge, RoleBadge } from '@/components/common/Badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

// Retain existing player theme utilities while telemetry is unavailable: w-11 dark:border-border/70 dark:bg-muted/20
const ProfileTab = ({ user,target }: { user: UserDetail;target:string }) => {
  const { formatTimestamp } = useAccountDisplay();
  const formatDateTime = (value?: string | null, withTime = true) => formatTimestamp(value, withTime ? 'datetime' : 'date');
  const theme = getServiceMeta(user.service_type ?? user.service_types?.[0]);
  const current=useIdentityCurrent(target);
  const summaryState=useIdentitySummary(target);
  const summary=summaryState.summary;
  const isServiceUser = user.user_type.toLowerCase() === 'service';
  const roleBadges = user.user_roles_detail;
  const adminRoleBadges = user.admin_roles_detail && user.admin_roles_detail.length > 0
    ? user.admin_roles_detail
    : user.roles.admin_roles.map((role): { name: string; color?: string | null; icon?: string | null; badge_style?: string | null; description?: string | null } => ({ name: role }));
  const nowPlaying = useMemo<UserNowPlaying | null>(()=>{
    const page=current.page,row=page?.items[0];if(!row||page?.target_uuid!==target)return null;
    const source=page.servers.find(s=>s.server_id===row.server_id);
    return {state:`Last observed ${row.paused?'paused':'playing'} · ${source?.freshness??'unknown'}`,mediaTitle:row.title,serviceType:source?.provider??null,serverName:`${source?.provider??'Unknown'} · Server ${row.server_id}`};
  },[current.page,target]);
  const playbackInfo=nowPlaying?getPlaybackInfo('unknown'):null;
  const PlaybackIcon = playbackInfo?.icon as IconDefinition | undefined;

  if(user.uuid!==target)return <p className="text-sm text-muted-foreground">Profile identity is unavailable. Refresh before inspecting activity.</p>;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        {nowPlaying && playbackInfo && PlaybackIcon ? (
          <Card>
            <CardHeader>
              <CardTitle>Retained Observation</CardTitle>
              <CardDescription>One retained row on this target page; present playback is unverified.</CardDescription>
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
              <p className="text-xs text-muted-foreground">Read at {formatTimestamp(current.page?.read_at)}. Last observed {formatTimestamp(current.page?.items[0]?.last_observed_at)}. Position {observationPosition(current.page?.items[0]?.position_ticks??null)} / Duration {observationPosition(current.page?.items[0]?.duration_ticks??null)}. No playback extrapolation.</p>
              <Button variant="outline" onClick={()=>void current.refresh().catch(()=>{})}>Refresh observation</Button>
            </CardContent>
          </Card>
        ) : <Card><CardHeader><CardTitle>Retained Observation</CardTitle><CardDescription>Current observation coverage is limited to supported sources.</CardDescription></CardHeader><CardContent><p className="text-sm text-muted-foreground">{current.error?'Current observations are unavailable.':current.loading?'Loading observations...':'No retained observation is available in this authorized page.'}</p><Button variant="outline" onClick={()=>void current.refresh().catch(()=>{})}>Refresh observation</Button></CardContent></Card>}

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

              {user.external_user_alt_id ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faFingerprint} className="mt-1 text-orange-600 dark:text-orange-400" />
                  <div>
                    <div className="text-muted-foreground">Alt External User ID</div>
                    <div className="font-mono text-sm">{user.external_user_alt_id}</div>
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
                        <Badge key={server} color={theme.palette?.avatar ?? 'bg-primary'} icon={faDatabase} hover={false}>
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
                    <Badge color="bg-green-600" icon={faCircleCheck} hover={false}>Active</Badge>
                  )}
                  {!user.is_active && (
                    <Badge color="bg-amber-600" icon={faCircleXmark} hover={false}>Inactive</Badge>
                  )}
                  {user.is_home_user && (
                    <Badge color="bg-blue-600" icon={faHouse} hover={false}>Home User</Badge>
                  )}
                  {user.shares_back && (
                    <Badge color="bg-purple-600" icon={faShareNodes} hover={false}>Shares Back</Badge>
                  )}
                  {user.is_purge_whitelisted && (
                    <Badge color="bg-amber-600" icon={faShieldHalved} hover={false}>Purge Protected</Badge>
                  )}
                  {user.is_discord_bot_whitelisted && (
                    <Badge color="bg-blue-600" icon={faDiscord} hover={false}>Discord Bot Allowed</Badge>
                  )}
                </div>
              </div>
            )}

            {user.libraries.length > 0 || isServiceUser ? (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-foreground">Library Access</div>
                {user.has_all_libraries ? (
                  <p className="mt-2 text-sm text-muted-foreground">This profile reports all-library access.</p>
                ) : user.libraries.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No specific library IDs are returned by this profile.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {user.libraries.map((library) => (
                      <Badge key={library} color={theme.palette?.avatar ?? 'bg-primary'} icon={faFolder} hover={false}>
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
                    <RoleBadge key={role.name} role={role} kind="admin" />
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
                    <RoleBadge key={role.name} role={role} kind="user" />
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
            <CardTitle>Recorded Observation Totals</CardTitle>
            <CardDescription>
              Complete target-bound counts across authorized recorded observations; these are not plays or watched duration.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!summary ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <FontAwesomeIcon icon={faChartSimple} className="text-3xl" />
                <p className="text-sm">{summaryState.error?'Observation totals are unavailable.':'Loading observation totals...'}</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {[
                  {title:'Recorded',count:summary.recorded_observations,gradient:'from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20',icon:<FontAwesomeIcon icon={faClock} className="text-blue-600 dark:text-blue-300"/>},
                  {title:'Ended observations',count:summary.ended_observations,gradient:'from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20',icon:<FontAwesomeIcon icon={faCalendarWeek} className="text-green-600 dark:text-green-300"/>},
                  {title:'Retained current',count:summary.retained_current_observations,gradient:'from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20',icon:<FontAwesomeIcon icon={faCalendarDays} className="text-purple-600 dark:text-purple-300"/>},
                  {title:'Fresh current observations',count:summary.fresh_current_observations,gradient:'from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20',icon:<FontAwesomeIcon icon={faInfinity} className="text-orange-600 dark:text-orange-300"/>}
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
                      <span className="text-3xl font-bold text-foreground">{stat.count}</span>
                      <span className="text-xs uppercase tracking-wide text-muted-foreground/60">observations</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      Watched duration unavailable
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card><CardHeader className="flex flex-row items-center justify-between space-y-0"><div><CardTitle>Preferred Players</CardTitle><CardDescription>Player and device telemetry is unavailable for these observations.</CardDescription></div></CardHeader><CardContent><div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60"><FontAwesomeIcon icon={faTv} className="text-3xl"/><p className="text-sm">Player rankings, daily plays and watched duration cannot be inferred.</p></div></CardContent></Card>
      </div>
    </div>
  );
};

// Poster cell: a signed history image when the play kept one, otherwise the
// play icon (also when the image fails to load).
const HistoryPoster = ({ url, title }: { url?: string; title: string }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className="w-12 h-18 rounded bg-muted/30 flex items-center justify-center overflow-hidden">
      {url && !failed ? (
        <img src={url} alt={title || 'Media poster'} className="w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <FontAwesomeIcon icon={faPlay} className="text-muted-foreground/40 text-sm" />
      )}
    </div>
  );
};

const playMethodLabels: Record<string, string> = { direct_play: 'Direct Play', direct_stream: 'Direct Stream', transcode: 'Transcode' };

// Provider positions are in 100 ns ticks; shown as Flask did ("12m 5s").
const formatTicks = (ticks: string | null) => {
  if (ticks === null) return '0m';
  const seconds = Number(BigInt(ticks) / 10000000n);
  const mins = Math.floor(seconds / 60), secs = seconds % 60;
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  return `${secs}s`;
};

const HistoryTab=({history,target}:{history:ReturnType<typeof useIdentityHistory>;target:string})=>{
  const {formatTimestamp}=useAccountDisplay();
  const {page,loading,error,refresh,hasPrevious,previous,next}=history;
  if(error)return <section className="space-y-4"><div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">Failed to load history: {error.message} <Button variant="outline" onClick={()=>void refresh().catch(()=>{})}>Refresh history</Button></div></section>;
  if(loading||!page||page.target_uuid!==target)return <section className="space-y-4"><div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><Spinner className="size-4"/>Fetching recent history…</div></section>;
  if(page.items.length===0&&!hasPrevious)return <section className="space-y-4"><div className="flex flex-col items-center gap-3 py-10 text-muted-foreground/60"><FontAwesomeIcon icon={faClockRotateLeft} className="text-3xl"/><p className="text-sm">No streaming history to display yet.</p></div></section>;
  return (
    <section className="space-y-4">
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
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground" title="When MUM first observed this playback">Started</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground" title="Last observed position of the total length">Duration</th>
                  <th className="text-center py-3 px-4 text-sm font-medium text-muted-foreground">Progress</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map(row=>{
                  const progress=observationProgress(row.position_ticks,row.duration_ticks)??0;
                  const percent=Math.min(Math.round(progress),100);
                  return (
                    <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-3 px-4"><HistoryPoster url={row.poster_url} title={row.title}/></td>
                      <td className="py-3 px-4">
                        <div className="font-medium">{row.title||'Unknown Title'}</div>
                        {row.parent_title&&<div className="text-xs text-muted-foreground">{row.parent_title}</div>}
                        {row.library_name&&<div className="text-xs text-muted-foreground/60"><FontAwesomeIcon icon={faFolder} className="mr-1 h-3 w-3"/>{row.library_name}</div>}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-sm">{row.client||'Unknown Player'}</div>
                        <div className="text-xs text-muted-foreground">{row.play_method?playMethodLabels[row.play_method]:'Unknown Platform'}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-sm">{formatTimestamp(row.first_observed_at,'date')}</div>
                        <div className="text-xs text-muted-foreground">{formatTimestamp(row.first_observed_at,'time')}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-sm font-medium">{formatTicks(row.position_ticks)}</div>
                        {row.duration_ticks!==null&&<div className="text-xs text-muted-foreground">of {formatTicks(row.duration_ticks)}</div>}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <div className="inline-flex items-center justify-center">
                          <div className="relative size-12">
                            <svg className="size-12 transform -rotate-90">
                              <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" className="text-muted/30"/>
                              <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray={`${2*Math.PI*20}`} strokeDashoffset={`${2*Math.PI*20*(1-percent/100)}`} className="text-primary transition-all"/>
                            </svg>
                            <div className="absolute inset-0 flex items-center justify-center"><span className="text-xs font-mono font-semibold">{percent}%</span></div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(hasPrevious||page.next_before)&&<div className="flex items-center justify-between gap-3 pt-4"><Button variant="outline" disabled={!hasPrevious} onClick={previous}>Newer</Button><Button variant="outline" disabled={!page.next_before} onClick={next}>Older</Button></div>}
        </CardContent>
      </Card>
    </section>
  );
};

const SettingsTab = ({user,refreshUser}:{user:UserDetail;refreshUser:()=>Promise<unknown>}) => (
  <div className="space-y-6">
    <ProfileNotesCard target={user.uuid} refreshUser={refreshUser}/>
    {user.user_type!=='service'&&<HumanActivationCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type==='service'&&<ServiceExpiryCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type==='service'&&<ServiceRemoteAccessCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanExpiryCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<ProfileRemoteAccessCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanCredentialsCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanUserRolesCard target={user.uuid} refreshUser={refreshUser}/>}
    <ProfileAccountLinks user={user} refreshUser={refreshUser}/>
  </div>
);

type SecurityTabProps = {
  user: UserDetail;
};

const SecurityTab = ({ user }: SecurityTabProps) => {
  const { formatTimestamp: formatDateTime } = useAccountDisplay();
  return (
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
              {user.access_expires_at ? formatDateTime(user.access_expires_at) : user.user_type==='service'?'Unknown':'No local expiry'}
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
          {user.has_password===null?<span className="text-sm text-muted-foreground">Password state unknown</span>:user.has_password ? (
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
                Forced-change sign-in is unavailable. Supported owner password replacement is in Settings.
              </p>
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-amber-300 bg-transparent text-amber-700 hover:bg-amber-50 h-9 px-4 py-2 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/20"
              disabled
            >
              <FontAwesomeIcon icon={faKey} className="mr-2" />
              Unavailable
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded border border-border bg-muted/30 p-4 text-sm">
            <div className="text-muted-foreground">Invite Usage</div>
            <div className="mt-1 text-base font-semibold text-foreground">
              {user.used_invite===null?'Unknown':user.used_invite?'Linked to invite code':'No invite usage recorded'}
            </div>
          </div>
          <div className="rounded border border-border bg-muted/30 p-4 text-sm">
            <div className="text-muted-foreground">Download Permissions</div>
            <div className="mt-1 text-base font-semibold text-foreground">
              {user.allow_downloads===null?'Download policy unknown':user.allow_downloads?'Downloads enabled':'Downloads disabled'}
            </div>
            <div className="text-xs text-muted-foreground/60">
              4K transcode {user.allow_4k_transcode===null?'policy unknown':user.allow_4k_transcode?'permitted':'blocked'}.
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
  );
};

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
  const [resyncing, setResyncing] = useState(false);

  const { success, error: showError } = useAlerts();
  const { user, loading, error, refresh: refreshUser } = useUserDetail(effectiveUuid);
  const links=useProfileAccountSnapshot(user?.user_type!=='service'?user?.uuid:undefined,Boolean(user)&&user?.user_type!=='service');
  const history=useIdentityHistory(effectiveUuid,activeTab==='history');
  const {
    overseerrLinks,
    loading: overseerrLoading,
    error: overseerrError
  } = useOverseerr(effectiveUuid,Boolean(user?.capabilities.overseerr));
  const { servers: plexServers } = useServers({ serviceType: 'plex', activeOnly: true });




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
  const showSecurityTab = !isServiceUser;

  const heroTheme = getServiceMeta(user.service_type ?? user.service_types?.[0]);
  const effectiveAvatar = user.avatar_url ?? user.discord_avatar_url;
  const initials = (user.display_name ?? user.username ?? 'U')[0]?.toUpperCase() ?? 'U';

  const tabs: Array<{ key: TabKey; label: string; hidden?: boolean }> = [
    { key: 'profile', label: 'Profile' },
    { key: 'history', label: 'History' },
    { key: 'settings', label: 'Settings' },
    { key: 'overseerr', label: 'Overseerr', hidden: !user.capabilities.overseerr||!showOverseerrTab },
    { key: 'security', label: 'Security', hidden: !showSecurityTab }
  ];

  const handleResync = async () => {
    if(!user.capabilities.resync)throw Error('This profile action is unavailable.');
    if (resyncing) return;
    setResyncing(true);
    try {
      await requestJson(`/api/users/${user.uuid}/sync`, {
        method: 'POST'
      });
      await refreshUser();
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
                    <Badge color="bg-primary" icon={faUser} size="md" hover={false}>Local Account</Badge>

                    {/* Show badges for linked service accounts */}
                    {links.page?.linked_accounts.map((serviceAccount) => {
                      const serviceTheme = getServiceMeta(serviceAccount.service_type);
                      return (
                        <Badge key={serviceAccount.uuid} color={serviceTheme.palette?.avatar ?? 'bg-primary'} icon={serviceTheme.icon} size="md" hover={false}>
                          {serviceAccount.external_username || 'Service Account'}
                        </Badge>
                      );
                    })}
                  </>
                ) : (
                  <>
                    <Badge color={heroTheme.palette?.avatar ?? 'bg-primary'} icon={faServer} size="md" hover={false}>
                      {user.server_nickname || `${heroTheme.label} User`}
                    </Badge>

                    {/* Show linked local user badge if this service user is linked to a local account */}
                    {user.linked_local_user && (
                      <Badge color="bg-primary" icon={faLink} size="md" hover={false}>
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
            <ProfileTab user={user} target={effectiveUuid}/>
          </TabsContent>

          <TabsContent value="history" className="pt-5">
            <HistoryTab history={history} target={effectiveUuid}/>
          </TabsContent>

          <TabsContent value="settings" className="pt-5">
            <SettingsTab user={user} refreshUser={refreshUser}/>
          </TabsContent>

          <TabsContent value="overseerr" className="pt-5">
            {user.capabilities.overseerr?<OverseerrCard
              links={overseerrLinks}
              loading={overseerrLoading}
              error={(overseerrError as Error) ?? undefined}
            />:<p className="text-sm text-muted-foreground">Overseerr is unavailable in this profile view.</p>}
          </TabsContent>

          <TabsContent value="security" className="pt-5">
            <SecurityTab user={user} />
          </TabsContent>
        </Tabs>
      </section>


    </div>
  );
};

export default UserDetailPage;
