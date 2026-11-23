import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartLine, faCircleInfo, faClock, faLayerGroup, faPlay, faTowerBroadcast, faUsers } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PeriodPicker, periodLabel } from '../common/PeriodPicker';
import { Spinner } from '@/components/ui/spinner';
import { getServiceMeta, getServicePalette } from '@/config/mediaServiceMetadata';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useServerRoutes } from '../../lib/serverRoutes';
import { fetchActivityStats, useDashboardData, type ActivityKind, type ActivityLink, type ConcurrentKind, type ActivityOrder, type ActivityServer, type ActivityStats, type ActivityTitle } from '../../lib/dashboard';
import { watchTime } from '../../lib/identityPlayTotals';
import { playerLogo } from '../../lib/playerPlatforms';
import { TabHeading } from '../users/AccountSettings';
import { Poster, Tile } from '../library/LibraryOverview';
import { libraryTypeIcon } from '../servers/ServerLibrariesCard';
import './ServerHealth.css';

// Activity statistics: tiles,
// then a card per statistic with the leader's picture and a ranked top five,
// by play count or play duration. On the dashboard it covers every server,
// with a server picker and server badges; on a server's Overview it's fixed
// to that server. Cards appear only when they have plays, and servers that
// report no activity are named.

const cardTitles: Record<ActivityKind, string> = {
  movies: 'Most watched movies', popular_movies: 'Most popular movies', shows: 'Most watched shows', popular_shows: 'Most popular shows',
  music: 'Most played albums', popular_music: 'Most popular albums', audiobooks: 'Most listened audiobooks', recent: 'Recently played',
  users: 'Most active users', libraries: 'Most active libraries',
};
const cardOrder: ActivityKind[] = ['movies', 'popular_movies', 'shows', 'popular_shows', 'music', 'popular_music', 'audiobooks', 'recent', 'users', 'libraries'];
// 0 is all time; any other number of days up to maxDays can be typed in.
const periods = [7, 30, 90, 0];
// Most concurrent streams' rows, in order.
const concurrentLabels: Record<ConcurrentKind, string> = { all: 'Streams', transcode: 'Transcodes', direct_stream: 'Direct streams', direct_play: 'Direct plays' };
const maxDays = 3650;

// "3 days 4 hrs" without zero parts.
const duration = (seconds: number) => {
  if (seconds < 60) return seconds === 0 ? '0 mins' : '1 min';
  const parts = watchTime(String(Math.round(seconds))).filter(([n]) => Number(n) !== 0);
  return parts.length ? parts.map(([n, unit]) => `${n} ${unit}`).join(' ') : '0 mins';
};
// "6:09": hours (as many as it takes) and minutes.
const clock = (seconds: number) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}`;
const list = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// "11m ago", "3hrs ago": short, so titles keep the room.
const shortAgo = (at: string | null, now = Date.now()) => {
  const when = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(when)) return '—';
  const minutes = Math.floor(Math.max(0, now - when) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${hours === 1 ? 'hr' : 'hrs'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`;
};

// The server a row is from: its icon in the server's colour and its name in
// grey, the name
// turning the server's colour on the highlighted row. Subtle, but every row
// shows its server. A person or platform used on several servers shows the
// most used one and how many more, all named on hover.
const ServerTag = ({ servers, lit }: { servers: ActivityServer[]; lit: boolean }) => {
  const [first] = servers;
  const more = servers.length - 1;
  const colour = { '--stat-server-color': `var(${getServicePalette(first.service_type).avatar.replace(/^bg-/, '--color-')})` } as CSSProperties;
  return <span className="dashboard-stat-badges" data-lit={lit || undefined} style={colour} title={`On ${list(servers.map(s => s.name))}`}>
    <span className="dashboard-stat-server"><ServiceIcon serviceType={first.service_type} className="dashboard-stat-server-icon" /><span className="dashboard-stat-server-name">{first.name}</span></span>
    {more > 0 && <span className="dashboard-stat-more">+{more}</span>}
  </span>;
};

// A title opens its page in the library catalogue once a sync has catalogued it.
const TitleLink = ({ server, link, children }: { server: number; link: ActivityLink | null; children: ReactNode }) => {
  const {slugFor} = useServerRoutes();
  const slug = slugFor(server);
  return !link || !slug ? <>{children}</>
  : link.episode_id === null
    ? <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId" params={{ serverId: slug, libraryId: String(link.library_id), mediaId: String(link.media_id) }} className="dashboard-stat-link">{children}</Link>
    : <Link to="/admin/servers/$serverId/libraries/$libraryId/$mediaId/episodes/$episodeId" params={{ serverId: slug, libraryId: String(link.library_id), mediaId: String(link.media_id), episodeId: String(link.episode_id) }} className="dashboard-stat-link">{children}</Link>;
};

// A person's picture in a circle, or their first letter.
const Avatar = ({ url, name }: { url: string | null; name: string }) => {
  const [failed, setFailed] = useState(false);
  return url && !failed ? <img src={url} alt="" className="dashboard-stat-avatar" onError={() => setFailed(true)} />
    : <span className="dashboard-stat-initial">{(name[0] ?? '?').toUpperCase()}</span>;
};

// One statistic: the highlighted row's picture beside a
// ranked list of up to ten that scrolls (its scrollbar on the left, shown on
// hover). Hovering or focusing a row shows that row's picture, and in
// Recently played who played it beside the card's title. A row's own heading
// figure (Most concurrent streams: the peak's date) replaces the card's while
// the row is hovered or focused, and goes back when the card is left. A title
// and its subtitle share the room evenly, each cut short when long, then the
// server.
type Row = { key: string; title: ReactNode; subtitle?: ReactNode; who?: string | null; metric?: string; value: string; badges?: ActivityServer[]; visual: ReactNode };
const StatCard = ({ title, metric, rows, round }: { title: string; metric: string; rows: Row[]; round?: boolean }) => {
  const [active, setActive] = useState(0);
  // Whether a row is being pointed at or focused, rather than just leading.
  const [engaged, setEngaged] = useState(false);
  const current = Math.min(active, rows.length - 1);
  const shown = rows[current];
  const leave = () => { setActive(0); setEngaged(false); };
  return <div className="dashboard-stat-card" onMouseLeave={leave}
    onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) leave(); }}>
    <div className="dashboard-stat-head">
      <span className="dashboard-stat-heading"><strong>{title}</strong>{shown?.who && <span className="dashboard-stat-who">· {shown.who}</span>}</span>
      <span className="dashboard-stat-metric">{engaged && shown?.metric ? shown.metric : metric}</span>
    </div>
    <div className={round ? 'dashboard-stat-visual dashboard-stat-round' : 'dashboard-stat-visual'}>{shown?.visual}</div>
    <ol className="dashboard-stat-list">
      {rows.map((row, i) => <li key={row.key} className="dashboard-stat-row" data-active={i === active || undefined} tabIndex={0}
        onMouseEnter={() => { setActive(i); setEngaged(true); }} onFocus={() => { setActive(i); setEngaged(true); }}>
        <span className="dashboard-stat-rank">{i + 1}</span>
        <span className="dashboard-stat-title">
          <span className="dashboard-stat-name">{row.title}</span>
          {row.subtitle && <span className="dashboard-stat-sub">· {row.subtitle}</span>}
          {row.badges && row.badges.length > 0 && <ServerTag servers={row.badges} lit={i === current} />}
        </span>
        <span className="dashboard-stat-value">{row.value}</span>
      </li>)}
    </ol>
  </div>;
};

export function ActivityStatistics({ fixedServer }: { fixedServer?: { id: number; name: string } }) {
  const routes = useServerRoutes();
  const [days, setDays] = useState(30);
  // Off by default: monitored servers' imported history from before MUM's recordings.
  const [withImported, setWithImported] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [order, setOrder] = useState<ActivityOrder>('plays');
  const server = fixedServer?.id ?? picked;
  const { data, loading, error } = useDashboardData<ActivityStats>(`activity:${days}:${server ?? 'all'}:${order}:${withImported ? 'imported' : 'recorded'}`,
    () => fetchActivityStats(days, server, order, withImported), 60_000);
  const { formatRelative, formatTimestamp } = useAccountDisplay();
  // Re-render every minute so the relative times move on.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(n => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const reporting = data?.servers ?? [];
  const several = !fixedServer && reporting.length > 1;
  const byID = new Map(reporting.map(s => [s.server_id, s]));
  const chosen = server !== null ? byID.get(server) : undefined;
  // Imported history only changes the servers MUM records itself.
  const recordsItself = (s: ActivityServer) => ['plex', 'jellyfin', 'emby'].includes(s.service_type.toLowerCase());
  const importToggle = server === null ? reporting.some(recordsItself) : chosen !== undefined && recordsItself(chosen);
  // Badges show which server something is from, when there's more than one to tell apart.
  const badgesFor = (ids: number[]) => several && server === null ? ids.flatMap(id => byID.get(id) ?? []) : undefined;
  const badgeFor = (item: ActivityTitle) => badgesFor(item.server_id ? [item.server_id] : []);
  const ago = (at: string | null) => at ? formatRelative(at).replace(/^Just now$/, 'just now') : '—';
  // Figures follow the order the data was ranked by, not the toggle mid-load.
  const ranked = data?.order ?? order;
  // Ranked by time, rows show H:MM and the heading says so.
  const figure = (item: ActivityTitle) => ranked === 'duration' ? clock(item.seconds) : item.plays.toLocaleString();
  const metric = ranked === 'duration' ? 'Time · HH:MM' : 'Plays';

  const cards: ReactNode[] = [];
  if (data) {
    const sections = new Map(data.sections.map(s => [s.kind, s.items]));
    for (const kind of cardOrder) {
      const items = sections.get(kind);
      if (!items?.length) continue;
      if (kind === 'users') {
        cards.push(<StatCard key={kind} title={cardTitles[kind]} metric={metric} round
          rows={items.map(item => ({ key: item.user_uuid ?? item.title, value: figure(item), visual: <Avatar url={item.avatar_url} name={item.title} />, badges: badgesFor(item.server_ids),
            title: item.user_uuid ? <Link to="/admin/users/$uuid" params={{ uuid: item.user_uuid }} className="dashboard-stat-link">{item.title}</Link> : item.title }))} />);
      } else if (kind === 'libraries') {
        cards.push(<StatCard key={kind} title={cardTitles[kind]} metric={metric}
          rows={items.map(item => ({ key: String(item.library_id), value: figure(item), badges: badgeFor(item),
            visual: <FontAwesomeIcon icon={libraryTypeIcon(item.library_type)} />,
            title: item.library_id && routes.slugFor(item.server_id) ? <Link to="/admin/servers/$serverId/libraries/$libraryId" params={{ serverId: routes.slugFor(item.server_id)!, libraryId: String(item.library_id) }} search={{ tab: 'overview' }} className="dashboard-stat-link">{item.title}</Link> : item.title }))} />);
      } else if (kind === 'recent') {
        cards.push(<StatCard key={kind} title={cardTitles[kind]} metric="When"
          rows={items.map((item, i) => ({ key: `${item.played_at}-${i}`, title: <TitleLink server={item.server_id} link={item.link}>{item.title}</TitleLink>, subtitle: item.subtitle, who: item.user_name,
            value: shortAgo(item.played_at), badges: badgeFor(item),
            visual: <Poster url={item.poster_url} title={item.title} className="w-full h-full" /> }))} />);
      } else {
        const popular = kind.startsWith('popular_');
        cards.push(<StatCard key={kind} title={cardTitles[kind]} metric={popular ? 'Users' : metric}
          rows={items.map((item, i) => ({ key: `${item.server_id}-${item.title}-${i}`, title: <TitleLink server={item.server_id} link={item.link}>{item.title}</TitleLink>, subtitle: item.subtitle,
            value: popular ? item.people.toLocaleString() : figure(item), badges: badgeFor(item),
            visual: <Poster url={item.poster_url} title={item.title} className="w-full h-full" /> }))} />);
      }
    }
    if (data.platforms.length > 0) {
      cards.push(<StatCard key="platforms" title="Most active platforms" metric={metric}
        rows={data.platforms.map(p => {
          const logo = playerLogo(p.name, p.name);
          return { key: p.name, title: p.name, value: ranked === 'duration' ? clock(p.seconds) : p.plays.toLocaleString(), badges: badgesFor(p.server_ids),
            visual: <FontAwesomeIcon icon={logo.icon} style={{ color: logo.color }} /> };
        })} />);
    }
    // The most streams playing at once; the heading shows the highlighted peak's day.
    if (data.concurrent.length > 0) {
      cards.push(<StatCard key="concurrent" title="Most concurrent streams" metric="Streams"
        rows={data.concurrent.map(peak => ({ key: peak.kind, title: concurrentLabels[peak.kind], metric: formatTimestamp(peak.started, 'date'),
          value: peak.count.toLocaleString(), visual: <FontAwesomeIcon icon={faTowerBroadcast} /> }))} />);
    }
  }
  // Labels follow the period the data covers, not the picker mid-load.
  const shownDays = data?.days ?? days;
  const period = periodLabel(shownDays);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faChartLine} title="Activity"
            description={fixedServer ? `What people watched, listened to and played on ${fixedServer.name}.` : 'What people watched, listened to and played across your servers.'} />
          <div className="flex flex-wrap items-center gap-2">
            {importToggle && <div className="flex items-center gap-2">
              {/* The same choice, in the same words, as the History table's records picker. */}
              <Select value={withImported ? 'all' : 'mum'} onValueChange={value => setWithImported(value === 'all')}>
                <SelectTrigger className="w-auto" aria-label="Records"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plays</SelectItem>
                  <SelectItem value="mum">Recorded by MUM</SelectItem>
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="About imported history"><FontAwesomeIcon icon={faCircleInfo} /></button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs space-y-2">
                  <p>All plays adds the plays imported from each Plex, Jellyfin and Emby server’s own history, from before MUM started recording that server, so older activity shows up. From MUM’s first recorded play on a server, only MUM’s recordings count, so nothing is counted twice.</p>
                  <p>Imported plays don’t say how long they lasted or what played them, so they count as plays but add no time (Time and Play duration leave them out), and Most active platforms only covers MUM’s recordings. With All plays, shows and albums are grouped by name.</p>
                  <p>Audiobookshelf always uses its imported history.</p>
                </TooltipContent>
              </Tooltip>
            </div>}
            <div className="flex items-center gap-1" role="group" aria-label="Rank by">
              <Button size="sm" variant={order === 'plays' ? 'default' : 'outline'} aria-pressed={order === 'plays'} onClick={() => setOrder('plays')}>Play count</Button>
              <Button size="sm" variant={order === 'duration' ? 'default' : 'outline'} aria-pressed={order === 'duration'} onClick={() => setOrder('duration')}>Play duration</Button>
            </div>
            {several && <Select value={picked === null ? 'all' : String(picked)} onValueChange={value => setPicked(value === 'all' ? null : Number(value))}>
              <SelectTrigger className="w-auto" aria-label="Server"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All servers</SelectItem>
                {reporting.map(s => <SelectItem key={s.server_id} value={String(s.server_id)}>
                  <span className="inline-flex items-center gap-2"><ServiceIcon serviceType={s.service_type} />{s.name}</span>
                </SelectItem>)}
              </SelectContent>
            </Select>}
            <PeriodPicker value={days} onChange={setDays} presets={periods} max={maxDays} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4 text-primary" />Loading activity…</div>
          : error ? <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">Couldn’t load activity: {error}</div>
          : data ? <>
            <div className="dashboard-overview-grid">
              <Tile icon={faPlay} label="Plays" value={data.totals.plays.toLocaleString()} note={chosen && !fixedServer ? `${period} on ${chosen.name}` : period} />
              <Tile icon={faClock} label="Time" value={duration(data.totals.seconds)} note="Watched and listened" />
              <Tile icon={faUsers} label="People" value={data.totals.people.toLocaleString()} note="Who played something" />
              <Tile icon={faLayerGroup} label="Titles" value={data.totals.titles.toLocaleString()} note="Different things played" />
            </div>
            {cards.length === 0 ? <p className="text-sm text-muted-foreground">{shownDays === 0 ? 'Nothing played yet.' : `Nothing played in the last ${shownDays} days.`}</p>
              : <div className="dashboard-stat-grid">{cards}</div>}
            {data.imported.length > 0 && data.sections.some(s => s.kind === 'audiobooks') && <p className="text-xs text-muted-foreground">
              Audiobooks come from imported history: {data.imported.map(s => `${s.name} ${s.imported_at ? `imported ${ago(s.imported_at)}` : 'not imported yet'}`).join(' · ')}
            </p>}
            {!fixedServer && server === null && data.unreported.length > 0 && <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5" />
              <span>{list(data.unreported.map(s => `${s.name} (${getServiceMeta(s.service_type).label})`))} {data.unreported.length === 1 ? 'doesn’t' : 'don’t'} report activity to MUM yet.</span>
            </p>}
          </> : null}
      </CardContent>
    </Card>
  );
}

/** The dashboard's Activity card: every server, with a server picker. */
export const ActivityCard = () => <ActivityStatistics />;
