import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useLocation, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useAlerts } from '../contexts/AlertContext';
import { useUserDetail, UserDetail } from '../hooks/useUserDetail';
import {useIdentityCurrent} from '../hooks/useIdentityHistory';
import {useIdentityTimeline} from '../hooks/useIdentityTimeline';
import {deleteTimelinePlays,historyServiceName,offeredSource,timelineMethods,type HistoryService,type TimelineCategory,type TimelineItem,type TimelineMethod,type TimelineRecords,type TimelineServer,type TimelineSource} from '../lib/identityTimeline';
import {fetchPersonHistoryImport,historyImportSupport,personImportSummary,startPersonHistoryImport} from '../lib/personHistoryImport';
import {startPlayHistoryImport} from '../lib/playHistory';
import {useAuth} from '../contexts/AuthContext';
import {DropdownMenu,DropdownMenuCheckboxItem,DropdownMenuContent,DropdownMenuTrigger} from '@/components/ui/dropdown-menu';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {observationProgress} from '../lib/activityHistory';
import { useOverseerr } from '../hooks/useOverseerr';
import { useServers } from '../hooks/useServers';
import { useUserUuidBySlug } from '../hooks/useUserUuidBySlug';
import {useIdentityPlayTotals} from '../hooks/useIdentityPlayTotals';
import {nowPlaying,recentPlayText,watchTime,type PlayPeriod} from '../lib/identityPlayTotals';
import {playerLogo} from '../lib/playerPlatforms';
import {Progress} from '@/components/ui/progress';
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
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
  faChevronLeft,
  faChevronRight,
  faUserClock,
  faLock,
  faUnlock,
  faKey,
  faFingerprint,
  faUser,
  faMusic,
  faPause,
  faSpinner,
  faWaveSquare,
  faSliders,
  faFilm,
  faVideo,
  faBook,
  faPodcast,
  faTrashCan,
  faFileImport,
  faTableColumns,
  faCirclePlay,
  faBars,
  faGears,
} from '@fortawesome/free-solid-svg-icons';
import { ConfirmAction, SettingInfo, TabHeading } from '../components/users/AccountSettings';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
import { Spinner } from '@/components/ui/spinner'

type TabKey = 'profile' | 'history' | 'settings' | 'linked-accounts' | 'overseerr' | 'security';

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

// A Profile tab card's header, in the settings tabs' heading style, with
// anything that acts on the card (an (i) button, a picker) on the right.
const CardHeading=({icon,title,description,children}:{icon:IconDefinition;title:string;description:string;children?:ReactNode})=>(
  <CardHeader>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <TabHeading icon={icon} title={title} description={description}/>
      {children}
    </div>
  </CardHeader>
);

// The Profile tab's period tiles, like Tautulli's user stats.
const periodTiles:Record<PlayPeriod['period'],{title:string;icon:IconDefinition;iconColor:string;gradient:string}>={
  day:{title:'Last 24 hours',icon:faClock,iconColor:'text-blue-600 dark:text-blue-300',gradient:'from-blue-50 to-blue-100 dark:from-blue-900/20 dark:to-blue-800/20'},
  week:{title:'Last 7 days',icon:faCalendarWeek,iconColor:'text-green-600 dark:text-green-300',gradient:'from-green-50 to-green-100 dark:from-green-900/20 dark:to-green-800/20'},
  month:{title:'Last 30 days',icon:faCalendarDays,iconColor:'text-purple-600 dark:text-purple-300',gradient:'from-purple-50 to-purple-100 dark:from-purple-900/20 dark:to-purple-800/20'},
  all:{title:'All time',icon:faInfinity,iconColor:'text-orange-600 dark:text-orange-300',gradient:'from-orange-50 to-orange-100 dark:from-orange-900/20 dark:to-orange-800/20'},
};

// Only MUM's plays have time; say so when a period also holds imported plays.
const timeCaption=(p:PlayPeriod)=>p.plays==='0'||p.timed_plays===p.plays?'':p.timed_plays==='0'?'Imported plays don’t record watch time':`Time from ${BigInt(p.timed_plays).toLocaleString()} of ${BigInt(p.plays).toLocaleString()} plays`;

const activityDescription=(source:TimelineSource,imported?:string)=>
  source==='mum'?'Plays MUM recorded while they were playing.':
  source!=='all'?`Plays imported from the ${historyServiceName[source]} server’s own history.`:
  imported&&imported!=='0'?`Plays MUM recorded, plus ${BigInt(imported).toLocaleString()} imported from the servers’ own history.`:'Plays MUM recorded, plus any imported from the servers’ own history.';

// Keeps these player theme utilities in the stylesheet: w-11 dark:border-border/70 dark:bg-muted/20
// The Profile tab: what the person is playing now, their account at a glance,
// roles, and how much they have played (MUM's plays and imported history,
// counted like the History tab).
const ProfileTab = ({ user,target }: { user: UserDetail;target:string }) => {
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const recentRow=useRef<HTMLDivElement>(null);
  const scrollRecent=(direction:number)=>{const row=recentRow.current;if(row)row.scrollBy({left:direction*row.clientWidth*0.8});};
  const theme = getServiceMeta(user.service_type ?? user.service_types?.[0]);
  const current=useIdentityCurrent(target);
  const [source,setSource]=useState<TimelineSource>('all');
  const {totals,error:totalsError}=useIdentityPlayTotals(target,source);
  // Back to Combined when the person has no account on the chosen service.
  useEffect(()=>{if(totals&&offeredSource(source,totals.sources)!==source)setSource('all');},[totals,source]);
  const {servers}=useServers();
  const serverNames=useMemo(()=>new Map(servers.map(s=>[String(s.id),s.server_nickname||s.server_name||''])),[servers]);
  const playing=useMemo(()=>nowPlaying(current.page,target,serverNames),[current.page,target,serverNames]);
  const isServiceUser = user.user_type.toLowerCase() === 'service';
  const roleBadges = user.user_roles_detail;
  const adminRoleBadges = user.admin_roles_detail && user.admin_roles_detail.length > 0
    ? user.admin_roles_detail
    : user.roles.admin_roles.map((role): { name: string; color?: string | null; icon?: string | null; badge_style?: string | null; description?: string | null } => ({ name: role }));
  const playbackInfo=getPlaybackInfo(playing?.state);
  const ids=([['User ID',user.external_user_id],['Alternate user ID',user.external_user_alt_id]] as [string,string|null|undefined][]).filter((id):id is [string,string]=>!!id[1]);
  const count=(value:string)=>BigInt(value).toLocaleString();

  if(user.uuid!==target)return <p className="text-sm text-muted-foreground">This profile changed while loading. Refresh the page.</p>;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-6">
        <Card>
          <CardHeading icon={faPlay} title="Now playing" description="What they’re playing right now." />
          <CardContent>
            {playing ? (
              <div className={cn("relative overflow-hidden rounded-md border p-2.5", playbackInfo.bg, playbackInfo.border)}>
                <div className="flex items-start gap-3">
                  <div className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background/50 shadow-sm", playbackInfo.color)}>
                    <FontAwesomeIcon icon={playbackInfo.icon as IconDefinition} spin={Boolean(playbackInfo.spin)} className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <span className="text-sm font-semibold leading-none truncate w-full" title={playing.title}>{playing.title}</span>
                    {playing.subtitle && <span className="mt-1 text-xs text-muted-foreground truncate" title={playing.subtitle}>{playing.subtitle}</span>}
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={cn("text-[10px] font-bold uppercase tracking-wider", playbackInfo.color)}>{playing.state}</span>
                      <span className="text-[10px] text-muted-foreground/60">·</span>
                      <span className="text-[10px] text-muted-foreground font-medium truncate max-w-[140px]" title={playing.serverName}>{playing.serverName}</span>
                    </div>
                  </div>
                  {playing.others > 0 && (
                    <div className="flex shrink-0 items-center justify-center h-5 px-1.5 rounded-full bg-background/50 border border-border/50 shadow-sm" title={`${playing.others} more playing`}>
                      <span className="text-[10px] font-medium text-muted-foreground">+{playing.others}</span>
                    </div>
                  )}
                </div>
                {playing.progress !== null && <Progress value={Math.min(playing.progress,100)} className="mt-2" aria-label="Progress" />}
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{playing.progress !== null ? `${playing.position} of ${playing.duration}` : ''}</span>
                  <span>Updated {formatTimestamp(playing.updatedAt,'time')}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{current.error?'Couldn’t check what’s playing right now.':current.loading?'Checking…':'Nothing playing right now.'}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeading icon={faUser} title="Account" description="Sign-in details and servers.">
            {ids.length > 0 && <SettingInfo title="Account IDs">
              <p>The account’s IDs on its media service. They help when troubleshooting.</p>
              <p>For Plex, the user ID is the plex.tv account ID and the alternate user ID is its UUID; other services have no alternate ID.</p>
            </SettingInfo>}
          </CardHeading>
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
                  <div className="font-medium">{user.local_username ?? user.external_username ?? user.username ?? 'Unknown'}</div>
                </div>
              </div>

              {user.service_join_date ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faCalendarPlus} className="mt-1 text-primary" />
                  <div>
                    <div className="text-muted-foreground">Joined</div>
                    <div className="font-medium">{formatTimestamp(user.service_join_date, 'date')}</div>
                  </div>
                </div>
              ) : null}

              {user.server_names.length > 0 ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faServer} className="mt-1 text-secondary" />
                  <div className="space-y-1">
                    <div className="text-muted-foreground">{user.server_names.length > 1 ? 'Servers' : 'Server'}</div>
                    <div className="flex flex-wrap gap-2">
                      {user.server_names.map((server) => (
                        <Badge key={server} color={theme.palette?.avatar ?? 'bg-primary'} icon={faDatabase} hover={false}>{server}</Badge>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {ids.map(([label,value]) => (
                <div key={label} className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faFingerprint} className="mt-1 text-amber-600 dark:text-amber-400" />
                  <div className="min-w-0">
                    <div className="text-muted-foreground">{label}</div>
                    <div className="font-mono font-medium break-all">{value}</div>
                  </div>
                </div>
              ))}

              {isServiceUser && user.linked_local_user ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faLink} className="mt-1 text-primary" />
                  <div>
                    <div className="text-muted-foreground">MUM profile</div>
                    <div className="font-medium">{user.linked_local_user.display_name ?? user.linked_local_user.username ?? 'Local account'}</div>
                    {user.linked_local_user.email ? <div className="text-xs text-muted-foreground">{user.linked_local_user.email}</div> : null}
                  </div>
                </div>
              ) : null}

              {user.discord_username || user.discord_user_id ? (
                <div className="flex items-start gap-3">
                  <FontAwesomeIcon icon={faDiscord} className="mt-1 text-indigo-500" />
                  <div>
                    <div className="text-muted-foreground">Discord</div>
                    <div className="font-medium">{user.discord_username ?? user.discord_user_id ?? 'Linked account'}</div>
                    {user.discord_email ? <div className="text-xs text-muted-foreground">{user.discord_email}</div> : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="border-t border-border pt-4">
              <div className="text-sm font-semibold text-foreground">Status</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {user.is_active
                  ? <Badge color="bg-green-600" icon={faCircleCheck} hover={false}>Active</Badge>
                  : <Badge color="bg-amber-600" icon={faCircleXmark} hover={false}>Inactive</Badge>}
                {user.is_home_user && <Badge color="bg-blue-600" icon={faHouse} hover={false}>Home User</Badge>}
                {user.shares_back && <Badge color="bg-purple-600" icon={faShareNodes} hover={false}>Shares Back</Badge>}
                {user.is_purge_whitelisted && <Badge color="bg-amber-600" icon={faShieldHalved} hover={false}>Purge Protected</Badge>}
                {user.is_discord_bot_whitelisted && <Badge color="bg-blue-600" icon={faDiscord} hover={false}>Discord Bot Allowed</Badge>}
              </div>
            </div>

            {user.libraries.length > 0 || isServiceUser ? (
              <div className="border-t border-border pt-4">
                <div className="text-sm font-semibold text-foreground">Libraries</div>
                {user.has_all_libraries ? (
                  <p className="mt-2 text-sm text-muted-foreground">Can see every library.</p>
                ) : user.libraries.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">No libraries shared.</p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {user.libraries.map((library) => (
                      <Badge key={library} color={theme.palette?.avatar ?? 'bg-primary'} icon={faFolder} hover={false}>{library}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeading icon={faShieldHalved} title="Roles" description="The admin and user roles they hold." />
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs uppercase text-muted-foreground/60">Admin roles</div>
              {adminRoleBadges.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">None</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {adminRoleBadges.map((role) => <RoleBadge key={role.name} role={role} kind="admin" />)}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground/60">User roles</div>
              {roleBadges.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">None</p>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {roleBadges.map((role) => <RoleBadge key={role.name} role={role} kind="user" />)}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6 lg:col-span-2">
        <Card>
          <CardHeading icon={faChartSimple} title="Activity" description={activityDescription(source,totals?.imported_plays)}>
            {totals && <HistorySourcePicker source={source} services={totals.sources} onChange={setSource} label="Activity source"/>}
          </CardHeading>
          <CardContent className="space-y-4">
            {!totals ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <FontAwesomeIcon icon={faChartSimple} className="text-3xl" />
                <p className="text-sm">{totalsError?'Couldn’t load activity.':'Loading activity…'}</p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {totals.periods.map(period => {
                  const tile=periodTiles[period.period];
                  return (
                    <div key={period.period} className={cn('rounded-xl border border-border p-4 shadow-sm transition-shadow hover:shadow-md', `bg-gradient-to-br ${tile.gradient}`)}>
                      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><FontAwesomeIcon icon={tile.icon} className={tile.iconColor}/>{tile.title}</div>
                      <div className="mt-3 flex items-baseline gap-1">
                        <span className="text-3xl font-bold text-foreground">{count(period.plays)}</span>
                        <span className="text-sm text-muted-foreground">{period.plays==='1'?'play':'plays'}</span>
                      </div>
                      {period.timed_plays!=='0' && <div className="mt-1 flex flex-wrap items-baseline gap-1">
                        {watchTime(period.seconds).map(([value,unit])=><span key={unit} className="flex items-baseline gap-1"><span className="text-xl font-semibold text-foreground">{value}</span><span className="text-xs text-muted-foreground">{unit}</span></span>)}
                      </div>}
                      {timeCaption(period) && <div className="account-time-caption mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                        {timeCaption(period)}
                        <SettingInfo title="Watch time"><p>Watch time only counts plays MUM recorded itself, because MUM saw how long they lasted.</p><p>Plays imported from a server’s own history say what was played and when, but not for how long, so they count as plays without adding any time.</p></SettingInfo>
                      </div>}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeading icon={faTv} title="Players" description="The apps they play on, most used first.">
            <SettingInfo title="Players"><p>The apps MUM saw this person play on, most used first. Imported plays don’t say which app was used, so only plays MUM recorded count here.</p><p>The logo shows the platform Plex reports, such as Android or Roku. Jellyfin and Emby don’t report one, so MUM goes by the app’s name.</p></SettingInfo>
          </CardHeading>
          <CardContent>
            {!totals ? (
              <p className="text-sm text-muted-foreground">{totalsError?'Couldn’t load players.':'Loading players…'}</p>
            ) : source !== 'all' && source !== 'mum' ? (
              <p className="text-sm text-muted-foreground">Imported plays don’t say which app was used. Choose Combined or MUM to see players.</p>
            ) : totals.players.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground/60">
                <FontAwesomeIcon icon={faTv} className="text-3xl"/>
                <p className="text-sm">No players recorded yet.</p>
              </div>
            ) : (
              <div className="account-player-grid">
                {[...totals.players].sort((a,b)=>BigInt(b.plays)>BigInt(a.plays)?1:BigInt(b.plays)<BigInt(a.plays)?-1:0).map(p => {
                  const logo=playerLogo(p.platform,p.client);
                  return <div key={p.client} className="flex items-center gap-3 min-w-0">
                    <span className="account-player-logo" style={{'--logo':logo.color} as CSSProperties} role="img" aria-label={logo.name} title={logo.name}><FontAwesomeIcon icon={logo.icon}/></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate" title={p.client}>{p.client}</div>
                      <div className="mt-1 flex items-baseline gap-1">
                        <span className="text-2xl font-bold leading-none text-foreground">{count(p.plays)}</span>
                        <span className="text-xs text-muted-foreground">{p.plays==='1'?'play':'plays'}</span>
                      </div>
                    </div>
                  </div>;
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeading icon={faClockRotateLeft} title="Recently Played" description="Their latest plays from the chosen source, newest first.">
            {totals && totals.recent_plays.length > 1 && <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon" aria-label="Show newer plays" onClick={()=>scrollRecent(-1)}><FontAwesomeIcon icon={faChevronLeft}/></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Show older plays" onClick={()=>scrollRecent(1)}><FontAwesomeIcon icon={faChevronRight}/></Button>
            </div>}
          </CardHeading>
          <CardContent>
            {!totals ? (
              <p className="text-sm text-muted-foreground">{totalsError?'Couldn’t load recent plays.':'Loading…'}</p>
            ) : totals.recent_plays.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing played yet.</p>
            ) : (
              <div ref={recentRow} className="account-recent-row">
                {totals.recent_plays.map((play,i) => {
                  const text=recentPlayText(play);
                  const when=formatRelative(play.played_at);
                  return <div key={`${play.source}-${play.played_at}-${i}`} className="account-recent-item" title={formatTimestamp(play.played_at,'datetime')}>
                    <div className="account-recent-poster">
                      <HistoryPoster url={play.poster_url} title={text.title} className="w-full h-full"/>
                      <div className="account-recent-when">{when==='—'?text.verb:`${text.verb} ${when==='Just now'?'just now':when}`}</div>
                    </div>
                    <div className="mt-2 text-sm font-medium truncate" title={text.title}>{text.title}</div>
                    {text.subtitle && <div className="text-xs text-muted-foreground truncate" title={text.subtitle}>{text.subtitle}</div>}
                    {play.source!=='mum' && <div className="text-xs text-muted-foreground truncate">{historyServiceName[play.source]} history</div>}
                  </div>;
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

// Poster cell: a signed history image when the play kept one, otherwise the
// play icon (also when the image fails to load).
const HistoryPoster = ({ url, title, className = 'w-12 h-18' }: { url?: string; title: string; className?: string }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn(className, 'rounded bg-muted/30 flex items-center justify-center overflow-hidden')}>
      {url && !failed ? (
        <img src={url} alt={title || 'Media poster'} className="w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <FontAwesomeIcon icon={faPlay} className="text-muted-foreground/40 text-sm" />
      )}
    </div>
  );
};

// Whole minutes, as Tautulli shows paused and watched time ("3 mins").
const minutes=(seconds:string)=>{const n=Math.round(Number(BigInt(seconds))/60);return `${n.toLocaleString()} ${n===1?'min':'mins'}`;};

const playMethodLabels: Record<string, string> = { direct_play: 'Direct Play', direct_stream: 'Direct Stream', transcode: 'Transcode' };

// Provider positions are in 100 ns ticks; shown as Flask did ("12m 5s").
const formatTicks = (ticks: string | null) => {
  if (ticks === null) return '0m';
  const seconds = Number(BigInt(ticks) / 10000000n);
  const mins = Math.floor(seconds / 60), secs = seconds % 60;
  if (mins > 0) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  return `${secs}s`;
};

// The History tab's source picker: everything, MUM's plays, or the plays
// imported from one service the person has an account on.
const HistorySourcePicker=({source,services,onChange,label='History source'}:{source:TimelineSource;services:readonly HistoryService[];onChange:(source:TimelineSource)=>void;label?:string})=>{
  const options:{value:TimelineSource;label:string}[]=[{value:'all',label:'Combined'},{value:'mum',label:'MUM'},...services.map(service=>({value:service,label:historyServiceName[service]}))];
  return (
    <Select value={source} onValueChange={(value:TimelineSource)=>onChange(value)}>
      <SelectTrigger className="w-40" aria-label={label}><SelectValue/></SelectTrigger>
      <SelectContent>{options.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
    </Select>
  );
};

// The History tab shows one server at a time (HISTORY_TOOLBAR_DESIGN.md):
// pickers for the server and the records, a Tautulli-style toolbar and the
// columns that server type reports.
type HistoryView = Readonly<{ server?: string; records: TimelineRecords; types: readonly TimelineCategory[]; methods: readonly TimelineMethod[] }>;
const initialHistoryView: HistoryView = { records: 'all', types: [], methods: [] };

type HistoryColumn = 'poster' | 'title' | 'platform' | 'product' | 'player' | 'decision' | 'date' | 'ip' | 'started' | 'paused' | 'stopped' | 'duration' | 'author' | 'listened' | 'progress';
const historyColumnLabels: Record<HistoryColumn, string> = { poster: 'Poster', title: 'Media Title', platform: 'Platform', product: 'Product', player: 'Player', decision: 'Transcode Decision', date: 'Date', ip: 'IP Address',
  started: 'Started', paused: 'Paused', stopped: 'Stopped', duration: 'Duration', author: 'Author', listened: 'Listened', progress: 'Progress' };
const historyColumnHints: Partial<Record<HistoryColumn, string>> = {
  product: 'The app they played on',
  player: 'The device’s name',
  decision: 'How the server sent the stream: Direct Play, Direct Stream or Transcode',
  started: 'When playback started: from Plex’s notification when MUM received one, otherwise MUM’s first check of the server, or the time the server recorded',
  stopped: 'When playback stopped: from Plex’s notification when MUM received one, otherwise MUM’s last check of the server',
  duration: 'Time watched: from start to stop, less paused time',
  listened: 'How long the session was listened to',
};
// Columns each server type reports; the title can't be hidden.
const historyColumns = (type: string): HistoryColumn[] => type === 'audiobookshelf' ? ['poster', 'title', 'author', 'date', 'listened', 'progress']
  : type === 'plex' ? ['poster', 'title', 'platform', 'product', 'player', 'decision', 'date', 'ip', 'started', 'paused', 'stopped', 'duration', 'progress']
  : ['poster', 'title', 'product', 'player', 'decision', 'date', 'started', 'paused', 'stopped', 'duration', 'progress'];
const historyColumnKey = 'mum.history.columns';
// Hidden columns per server type, remembered per browser.
const readHiddenColumns = (): Record<string, HistoryColumn[]> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(historyColumnKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((c): c is HistoryColumn => typeof c === 'string' && c in historyColumnLabels && c !== 'title')]));
  } catch { return {}; }
};
const saveHiddenColumns = (value: Record<string, HistoryColumn[]>) => { try { localStorage.setItem(historyColumnKey, JSON.stringify(value)); } catch { /* not remembered */ } };

const categoryButtons: Record<TimelineCategory, { label: string; icon: IconDefinition }> = {
  movies: { label: 'Movies', icon: faFilm }, tv: { label: 'TV Shows', icon: faTv }, music: { label: 'Music', icon: faMusic },
  videos: { label: 'Videos', icon: faVideo }, books: { label: 'Books', icon: faBook }, podcasts: { label: 'Podcasts', icon: faPodcast },
};
const methodButtons: Record<TimelineMethod, { label: string; icon: IconDefinition }> = {
  direct_play: { label: 'Direct Play', icon: faCirclePlay }, direct_stream: { label: 'Direct Stream', icon: faBars }, transcode: { label: 'Transcode', icon: faGears },
};
const serviceLabel = (type: string) => getServiceMeta(type).label;

const HistoryTab = ({ history, target, view, onViewChange, admin }: {
  history: ReturnType<typeof useIdentityTimeline>; target: string; view: HistoryView; onViewChange: (view: HistoryView) => void; admin: boolean;
}) => {
  const { formatTimestamp } = useAccountDisplay();
  const { success, error: showError } = useAlerts();
  const { page, pending, loading, error, refresh, hasPrevious, previous, next } = history;
  const [deleteMode, setDeleteMode] = useState(false);
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hidden, setHidden] = useState(readHiddenColumns);
  const [importNote, setImportNote] = useState<{ server: string; text: string; running: boolean } | null>(null);
  const [fullImport, setFullImport] = useState<TimelineServer | null>(null);
  const [importing, setImporting] = useState(false);
  const shown = page?.servers.find(s => s.server_id === page.server_id);
  const streams = Boolean(shown?.live) && view.records !== 'server';

  // Filters the shown server and records don't offer are dropped, judged on
  // the page that answers the current view.
  useEffect(() => {
    if (!page || pending || page.target_uuid !== target) return;
    const types = view.types.filter(t => page.categories.includes(t));
    const methods = streams ? view.methods : [];
    if (types.length !== view.types.length || methods.length !== view.methods.length) onViewChange({ ...view, types, methods });
  }, [page, pending, target, streams, view, onViewChange]);

  // A running import is checked every 2 seconds until it ends.
  useEffect(() => {
    if (!importNote?.running) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      fetchPersonHistoryImport(target, importNote.server).then(status => {
        if (stopped || status.state === 'running') return;
        setImportNote({ server: importNote.server, text: personImportSummary(status), running: false });
        void refresh();
      }).catch(() => { if (!stopped) setImportNote({ server: importNote.server, text: 'Couldn’t read the import’s progress.', running: false }); });
    }, 2000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [importNote, target, refresh]);

  const toggleDeleteMode = () => {
    if (!deleteMode) { setMarked(new Set()); setDeleteMode(true); return; }
    setDeleteMode(false);
    if (marked.size > 0) setConfirmDelete(true);
  };
  const toggleMark = (id: string) => setMarked(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const finishDelete = () => { setConfirmDelete(false); setMarked(new Set()); };
  const deleteMarked = async () => {
    setDeleting(true);
    try {
      const count = await deleteTimelinePlays(target, [...marked]);
      success(`Deleted ${count} history item${count === 1 ? '' : 's'}.`);
      void refresh();
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The history items couldn’t be deleted.');
    } finally {
      setDeleting(false);
      finishDelete();
    }
  };
  const startImport = async () => {
    if (!shown) return;
    // Jellyfin and Emby can only import the whole server: ask first.
    if (historyImportSupport(shown.service_type) === 'server') { setFullImport(shown); return; }
    setImporting(true);
    try {
      const result = await startPersonHistoryImport(target, shown.server_id);
      if (result === 'started') setImportNote({ server: shown.server_id, text: `Importing their history from ${shown.name}…`, running: true });
      else if (result === 'busy') setImportNote({ server: shown.server_id, text: `An import is already running on ${shown.name}. Try again when it finishes.`, running: false });
      else if (result === 'full_import_only') setFullImport(shown);
      else setImportNote({ server: shown.server_id, text: `${shown.name} can’t import history right now. Check that it’s active and has an API key.`, running: false });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The import couldn’t start.');
    } finally {
      setImporting(false);
    }
  };
  const runFullImport = async () => {
    const server = fullImport;
    if (!server) return;
    setImporting(true);
    try {
      await startPlayHistoryImport(Number(server.server_id));
      setImportNote({ server: server.server_id, text: `Importing every user’s history from ${server.name}…`, running: true });
    } catch (err) {
      showError(err instanceof Error ? err.message : 'The import couldn’t start.');
    } finally {
      setImporting(false);
      setFullImport(null);
    }
  };

  const pickers = page && page.target_uuid === target && <>
    {page.servers.length > 1 && <Select value={page.server_id ?? undefined} onValueChange={server => onViewChange({ ...initialHistoryView, server })}>
      <SelectTrigger className="w-56" aria-label="Server"><SelectValue /></SelectTrigger>
      <SelectContent>{page.servers.map(s => <SelectItem key={s.server_id} value={s.server_id}>{s.name} ({serviceLabel(s.service_type)})</SelectItem>)}</SelectContent>
    </Select>}
    {shown?.live && <Select value={view.records} onValueChange={(records: TimelineRecords) => onViewChange({ ...view, records })}>
      <SelectTrigger className="w-56" aria-label="Records"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All plays</SelectItem>
        <SelectItem value="mum">Recorded by MUM</SelectItem>
        <SelectItem value="server">From server history</SelectItem>
      </SelectContent>
    </Select>}
  </>;
  const heading = <CardHeading icon={faClockRotateLeft} title="History" description="What they’ve played, newest first."><div className="flex flex-wrap items-center gap-2">{pickers}</div></CardHeading>;
  if (error) return <section className="space-y-4"><div className="rounded border border-red-500/40 bg-red-50 dark:bg-red-400/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">Failed to load history: {error.message} <Button variant="outline" onClick={() => void refresh().catch(() => {})}>Refresh history</Button></div></section>;
  if (loading || !page || page.target_uuid !== target) return <section className="space-y-4"><div className="flex items-center gap-3 rounded border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"><Spinner className="size-4" />Fetching recent history…</div></section>;
  const empty = (text: string) => <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground/60"><FontAwesomeIcon icon={faClockRotateLeft} className="text-3xl" /><p className="text-sm">{text}</p></div>;
  if (!shown) return <section className="space-y-4"><Card>{heading}<CardContent>{empty('They have no media server accounts.')}</CardContent></Card></section>;
  if (!shown.history) return <section className="space-y-4"><Card>{heading}<CardContent>{empty(`${serviceLabel(shown.service_type)} doesn’t share users’ history, so MUM has none to show for ${shown.name}.`)}</CardContent></Card></section>;

  const columns = historyColumns(shown.service_type).filter(c => c === 'title' || !(hidden[shown.service_type] ?? []).includes(c));
  const toggleColumn = (column: HistoryColumn) => setHidden(current => {
    const list = current[shown.service_type] ?? [];
    const updated = { ...current, [shown.service_type]: list.includes(column) ? list.filter(c => c !== column) : [...list, column] };
    saveHiddenColumns(updated);
    return updated;
  });
  const toggleFilter = <T extends string>(list: readonly T[], value: T) => list.includes(value) ? list.filter(v => v !== value) : [...list, value];
  const canImport = admin && historyImportSupport(shown.service_type) !== 'none';
  const filtered = view.types.length > 0 || view.methods.length > 0;

  const cell = (column: HistoryColumn, row: TimelineItem) => {
    const service = row.source === 'mum' ? null : historyServiceName[row.source];
    const none = <span className="text-muted-foreground" title={service ? `Not recorded by ${service}` : 'Not recorded'}>—</span>;
    switch (column) {
      case 'poster': return <HistoryPoster url={row.poster_url} title={row.title} />;
      case 'title': return <>
        <div className="font-medium">{row.title || (service ? 'Removed item' : 'Unknown Title')}</div>
        {row.parent_title && shown.service_type !== 'audiobookshelf' && <div className="text-xs text-muted-foreground">{row.parent_title}</div>}
        {row.library_name && <div className="text-xs text-muted-foreground/60"><FontAwesomeIcon icon={faFolder} className="mr-1 h-3 w-3" />{row.library_name}</div>}
        {service && view.records === 'all' && shown.live && <span className="mt-1 inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold bg-muted text-muted-foreground" title={`Imported from the ${service} server's own play history`}>{service} history</span>}
      </>;
      case 'platform': return row.platform ?? none;
      case 'product': return row.client ?? none;
      case 'player': return row.player ?? none;
      case 'decision': return row.play_method ? playMethodLabels[row.play_method] ?? none : none;
      case 'date': return formatTimestamp(row.played_at, 'date');
      case 'ip': return <span className="font-mono">{row.ip_address ?? none}</span>;
      case 'started': return formatTimestamp(row.played_at, 'time');
      case 'paused': return row.paused_seconds !== null ? minutes(row.paused_seconds) : none;
      case 'stopped': return row.stopped_at !== null ? formatTimestamp(row.stopped_at, 'time') : none;
      case 'duration': return row.watched_seconds !== null ? minutes(row.watched_seconds) : none;
      case 'author': return row.parent_title ?? none;
      case 'listened': return row.listened_seconds !== null ? minutes(row.listened_seconds) : none;
      case 'progress': {
        if (row.position_ticks === null) return <span className="text-xs text-muted-foreground">{row.source === 'plex' ? 'Watched' : 'Played'}</span>;
        const percent = Math.min(Math.round(observationProgress(row.position_ticks, row.duration_ticks) ?? 0), 100);
        return <div className="inline-flex items-center justify-center" title={row.duration_ticks !== null ? `${formatTicks(row.position_ticks)} of ${formatTicks(row.duration_ticks)}` : formatTicks(row.position_ticks)}>
          <div className="relative size-12">
            <svg className="size-12 transform -rotate-90">
              <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" className="text-muted/30" />
              <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="4" fill="none" strokeDasharray={`${2 * Math.PI * 20}`} strokeDashoffset={`${2 * Math.PI * 20 * (1 - percent / 100)}`} className="text-primary transition-all" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center"><span className="text-xs font-mono font-semibold">{percent}%</span></div>
          </div>
        </div>;
      }
    }
  };
  const cellClass = (column: HistoryColumn) => column === 'progress' ? 'py-3 px-4 text-center' : column === 'title' ? 'account-history-title py-3 px-4' : column === 'poster' ? 'py-3 px-4' : 'py-3 px-4 text-sm whitespace-nowrap';

  return (
    <section className="space-y-4">
      <Card>
        {heading}
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="History tools">
            {admin && <Button variant={deleteMode ? 'destructive' : 'outline'} size="sm" aria-pressed={deleteMode} onClick={toggleDeleteMode}><FontAwesomeIcon icon={faTrashCan} />Delete mode</Button>}
            {page.categories.map(category => <Button key={category} variant={view.types.includes(category) ? 'default' : 'outline'} size="sm" aria-pressed={view.types.includes(category)}
              onClick={() => onViewChange({ ...view, types: toggleFilter(view.types, category) })}><FontAwesomeIcon icon={categoryButtons[category].icon} />{categoryButtons[category].label}</Button>)}
            {streams && timelineMethods.map(method => <Button key={method} variant={view.methods.includes(method) ? 'default' : 'outline'} size="sm" aria-pressed={view.methods.includes(method)}
              onClick={() => onViewChange({ ...view, methods: toggleFilter(view.methods, method) })}><FontAwesomeIcon icon={methodButtons[method].icon} />{methodButtons[method].label}</Button>)}
            {canImport && <Button variant="outline" size="sm" disabled={importing || Boolean(importNote?.running)} onClick={() => void startImport()}><FontAwesomeIcon icon={faFileImport} />Import history</Button>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="sm"><FontAwesomeIcon icon={faTableColumns} />Select columns</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {historyColumns(shown.service_type).map(column => <DropdownMenuCheckboxItem key={column} checked={columns.includes(column)} disabled={column === 'title'}
                  onCheckedChange={() => toggleColumn(column)} onSelect={e => e.preventDefault()}>{column === 'title' && shown.service_type === 'audiobookshelf' ? 'Title' : historyColumnLabels[column]}</DropdownMenuCheckboxItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
            {pending && <Spinner className="size-4 text-muted-foreground" role="status" aria-label="Loading history" />}
          </div>
          {deleteMode && <p className="text-sm text-muted-foreground" role="status">Select rows to delete. They’re deleted when you leave delete mode{marked.size > 0 ? ` (${marked.size} selected)` : ''}.</p>}
          {importNote && importNote.server === shown.server_id && <p className="text-sm text-muted-foreground" role="status">{importNote.text}</p>}
          {page.items.length === 0 && !hasPrevious ? empty(filtered ? 'No plays match these filters.' : 'No history to display yet.') : <div className="account-history-table overflow-x-auto" aria-busy={pending}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  {deleteMode && <th className="w-12 py-3 px-4"><span className="sr-only">Delete</span></th>}
                  {columns.map(column => <th key={column} className={column === 'poster' ? 'w-20 py-3 px-4 text-sm font-medium text-muted-foreground' : column === 'progress' ? 'text-center py-3 px-4 text-sm font-medium text-muted-foreground' : 'text-left py-3 px-4 text-sm font-medium text-muted-foreground'}
                    title={historyColumnHints[column]}>{column === 'title' && shown.service_type === 'audiobookshelf' ? 'Title' : historyColumnLabels[column]}</th>)}
                </tr>
              </thead>
              <tbody>
                {page.items.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    {deleteMode && <td className="py-3 px-4">
                      <Button variant={marked.has(row.id) ? 'destructive' : 'ghost'} size="icon-sm" disabled={row.in_progress} aria-pressed={marked.has(row.id)}
                        aria-label={`${marked.has(row.id) ? 'Keep' : 'Delete'} ${row.title || 'this play'}`} title={row.in_progress ? 'Still playing: it can be deleted once it ends' : undefined}
                        onClick={() => toggleMark(row.id)}><FontAwesomeIcon icon={faTrashCan} /></Button>
                    </td>}
                    {columns.map(column => <td key={column} className={cellClass(column)}>{cell(column, row)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>}
          {(hasPrevious || page.next_before) && <div className="flex items-center justify-between gap-3"><Button variant="outline" disabled={!hasPrevious} onClick={previous}>Newer</Button><Button variant="outline" disabled={!page.next_before} onClick={next}>Older</Button></div>}
        </CardContent>
      </Card>
      <ConfirmAction open={confirmDelete} onOpenChange={open => { if (!open) finishDelete(); }} title="Delete history" confirmLabel="Delete" destructive busy={deleting} onConfirm={() => void deleteMarked()}>
        <p>Are you sure you want to delete {marked.size} history item{marked.size === 1 ? '' : 's'}?</p>
        <p>This is permanent and cannot be undone.</p>
      </ConfirmAction>
      <ConfirmAction open={fullImport !== null} onOpenChange={open => { if (!open && !importing) setFullImport(null); }} title="Import the whole server?" confirmLabel="Run full import" busy={importing} onConfirm={() => void runFullImport()}>
        <p>{fullImport ? serviceLabel(fullImport.service_type) : 'This server'} can’t import a single user’s history.</p>
        <p>Run a full import of {fullImport?.name} instead? It imports every user’s plays on that server; plays MUM already has are skipped.</p>
      </ConfirmAction>
    </section>
  );
};

// Laid out like the account page (ACCOUNT_PAGE_DESIGN.md): one panel of sections.
const SettingsTab = ({user,refreshUser}:{user:UserDetail;refreshUser:()=>Promise<unknown>}) => (
  <div className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
  <TabHeading icon={faSliders} title="Settings" description={user.user_type==='service'?'Notes, expiry and access for this service account':'Notes, sign-in, access and roles for this person'} />
  <div className="account-settings-panels">
    <ProfileNotesCard target={user.uuid} refreshUser={refreshUser}/>
    {user.user_type!=='service'&&<HumanActivationCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type==='service'&&<ServiceExpiryCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type==='service'&&<ServiceRemoteAccessCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanExpiryCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<ProfileRemoteAccessCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanCredentialsCard target={user.uuid} refreshUser={refreshUser}/>}
    {user.user_type!=='service'&&<HumanUserRolesCard target={user.uuid} refreshUser={refreshUser}/>}
  </div>
  </div>
);

// Who owns which accounts, in the same panel layout as Settings.
const LinkedAccountsTab = ({user,refreshUser}:{user:UserDetail;refreshUser:()=>Promise<unknown>}) => (
  <div className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
    <TabHeading icon={faLink} title="Linked accounts" description={user.user_type==='service'?'The MUM profile that owns this account, and its other accounts':'The media server accounts this person owns'} />
    <div className="account-settings-panels">
      {user.user_type==='service'&&!user.linked_local_user?<p className="text-sm text-muted-foreground">This service account is not linked to a MUM profile.</p>:<ProfileAccountLinks user={user} refreshUser={refreshUser}/>}
    </div>
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
  const {isAdministrator}=useAuth();
  // The History tab's server, records and filters; another person starts afresh.
  const [historyView,setHistoryView]=useState<HistoryView>(initialHistoryView);
  useEffect(()=>{setHistoryView(initialHistoryView);},[effectiveUuid]);
  const history=useIdentityTimeline(effectiveUuid,historyView.server,historyView.records,historyView,activeTab==='history');
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
    { key: 'linked-accounts', label: 'Linked accounts' },
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
            <HistoryTab key={effectiveUuid} history={history} target={effectiveUuid} view={historyView} onViewChange={setHistoryView} admin={isAdministrator}/>
          </TabsContent>

          <TabsContent value="linked-accounts" className="pt-5">
            <LinkedAccountsTab user={user} refreshUser={refreshUser}/>
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
