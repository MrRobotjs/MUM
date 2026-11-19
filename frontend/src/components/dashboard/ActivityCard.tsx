import { useEffect, useState, type CSSProperties } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBookOpen, faChartLine, faCircleInfo, faClock, faFilm, faLayerGroup, faMusic, faPlay, faTv, faUsers, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { fetchActivityStats, useDashboardData, type ActivityKind, type ActivityServer, type ActivityStats, type ActivityTitle } from '../../lib/dashboard';
import { watchTime } from '../../lib/identityPlayTotals';
import { playerLogo } from '../../lib/playerPlatforms';
import { getServiceIcon, getServiceMeta } from '@/config/pluginMetadata';
import { TabHeading } from '../users/AccountSettings';
import { Poster, Tile } from '../library/LibraryOverview';
import './ServerHealth.css';

// The dashboard's Activity card (user decision 2026-11-18): what people used
// across every server type, for the chosen period. Each section appears only
// when it has plays; servers that can't report activity are named. With more
// than one reporting server, a picker narrows it to one server, and in the
// all-servers view each title shows a badge of the server it's from.

const sections: Record<ActivityKind, { title: string; icon: IconDefinition; verb: string }> = {
  movies: { title: 'Most watched movies', icon: faFilm, verb: 'watched' },
  shows: { title: 'Most watched shows', icon: faTv, verb: 'watched' },
  music: { title: 'Most played music', icon: faMusic, verb: 'played' },
  audiobooks: { title: 'Most listened audiobooks', icon: faBookOpen, verb: 'listened' },
};
const periods = [7, 30, 90] as const;

// "3 days 4 hrs" without zero parts.
const duration = (seconds: number) => {
  if (seconds < 60) return seconds === 0 ? '0 mins' : '1 min';
  const parts = watchTime(String(Math.round(seconds))).filter(([n]) => Number(n) !== 0);
  return parts.length ? parts.map(([n, unit]) => `${n} ${unit}`).join(' ') : '0 mins';
};
const list = (names: string[]) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// The server a title is from, styled like the hero's server badge.
const ServerBadge = ({ server }: { server: ActivityServer }) => (
  <span className="inline-flex items-center rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border gap-1" title={`On ${server.name}`}>
    {getServiceIcon(server.service_type, 'h-3 w-3')}{server.name}
  </span>
);

const TitleRow = ({ item, server }: { item: ActivityTitle; server?: ActivityServer }) => (
  <li className="flex items-center gap-3">
    <Poster url={item.poster_url} title={item.title} className="w-10 h-14 flex-shrink-0" />
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium truncate" title={item.title}>{item.title || 'Unknown'}</div>
      {item.subtitle && <div className="text-xs text-muted-foreground truncate">{item.subtitle}</div>}
      {server && <div className="mt-1"><ServerBadge server={server} /></div>}
    </div>
    <div className="text-right">
      <div className="text-sm font-semibold">{item.plays.toLocaleString()} {item.plays === 1 ? 'play' : 'plays'}</div>
      <div className="text-xs text-muted-foreground">{duration(item.seconds)}</div>
    </div>
  </li>
);

export const ActivityCard = () => {
  const [days, setDays] = useState<(typeof periods)[number]>(7);
  const [server, setServer] = useState<number | null>(null);
  const { data, loading, error } = useDashboardData<ActivityStats>(`dashboard:activity:${days}:${server ?? 'all'}`, () => fetchActivityStats(days, server), 60_000);
  const { formatRelative } = useAccountDisplay();
  // Re-render every minute so "imported … ago" moves on.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick(n => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const period = `Last ${days} days`;
  const nothingReports = data && data.sections.length === 0 && data.totals.plays === 0;
  // The picker and badges only matter with more than one server that reports.
  const reporting = data?.servers ?? [];
  const several = reporting.length > 1;
  const byID = new Map(reporting.map(s => [s.server_id, s]));
  const chosen = server !== null ? byID.get(server) : undefined;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faChartLine} title="Activity" description="What people watched, listened to and played across your servers." />
          <div className="flex flex-wrap items-center gap-2">
            {several && <Select value={server === null ? 'all' : String(server)} onValueChange={value => setServer(value === 'all' ? null : Number(value))}>
              <SelectTrigger className="w-56" aria-label="Server"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All servers</SelectItem>
                {reporting.map(s => <SelectItem key={s.server_id} value={String(s.server_id)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>}
            <Select value={String(days)} onValueChange={value => setDays(Number(value) as (typeof periods)[number])}>
              <SelectTrigger className="w-56" aria-label="Period"><SelectValue /></SelectTrigger>
              <SelectContent>{periods.map(p => <SelectItem key={p} value={String(p)}>Last {p} days</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4 text-primary" />Loading activity…</div>
          : error ? <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">Couldn’t load activity: {error}</div>
          : data ? <>
            <div className="dashboard-overview-grid">
              <Tile icon={faPlay} label="Plays" value={data.totals.plays.toLocaleString()} note={chosen ? `${period} on ${chosen.name}` : period} />
              <Tile icon={faClock} label="Time" value={duration(data.totals.seconds)} note="Watched and listened" />
              <Tile icon={faUsers} label="People" value={data.totals.people.toLocaleString()} note="Who played something" />
              <Tile icon={faLayerGroup} label="Titles" value={data.totals.titles.toLocaleString()} note="Different things played" />
            </div>

            {nothingReports ? <p className="text-sm text-muted-foreground">Nothing played in the last {days} days.</p> : (
              <div className="grid gap-6 grid-cols-1 lg:grid-cols-2">
                {data.sections.map(section => <section key={section.kind} className="space-y-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2"><FontAwesomeIcon icon={sections[section.kind].icon} className="text-muted-foreground" />{sections[section.kind].title}</h3>
                  <ul className="space-y-3">{section.items.map((item, i) => <TitleRow key={`${item.server_id}-${item.title}-${i}`} item={item} server={several && server === null ? byID.get(item.server_id) : undefined} />)}</ul>
                  {section.kind === 'audiobooks' && data.imported.length > 0 && <p className="text-xs text-muted-foreground">
                    From imported history: {data.imported.map(s => `${s.name} ${s.imported_at ? `imported ${formatRelative(s.imported_at).replace(/^Just now$/, 'just now')}` : 'not imported yet'}`).join(' · ')}
                  </p>}
                </section>)}
                {data.platforms.length > 0 && <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Top platforms</h3>
                  <ul className="space-y-3">{data.platforms.map(p => {
                    const logo = playerLogo(p.name, p.name);
                    return <li key={p.name} className="flex items-center gap-3">
                      <span className="account-player-logo" style={{ '--logo': logo.color } as CSSProperties} role="img" aria-label={logo.name} title={logo.name}><FontAwesomeIcon icon={logo.icon} /></span>
                      <span className="text-sm font-medium flex-1 truncate">{p.name}</span>
                      <span className="text-sm font-semibold">{p.plays.toLocaleString()} {p.plays === 1 ? 'play' : 'plays'}</span>
                    </li>;
                  })}</ul>
                </section>}
              </div>
            )}

            {server === null && data.unreported.length > 0 && <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <FontAwesomeIcon icon={faCircleInfo} className="mt-0.5" />
              <span>{list(data.unreported.map(s => `${s.name} (${getServiceMeta(s.service_type).label})`))} {data.unreported.length === 1 ? 'doesn’t' : 'don’t'} report activity to MUM yet.</span>
            </p>}
          </> : null}
      </CardContent>
    </Card>
  );
};
