import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { faMemory, faMicrochip, faNetworkWired } from '@fortawesome/free-solid-svg-icons';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { ChartCard, renderGraphsTooltipCard } from '../../pages/GraphsPage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  BANDWIDTH_RANGES,
  bandwidthBars,
  bandwidthSeries,
  rangeSince,
  type BandwidthNetwork,
  fetchBandwidth,
  fetchResources,
  formatBytes,
  formatRate,
  resourceSeries,
  type BandwidthStatistics,
  type ResourceSample,
} from '../../lib/plexResources';

// Real-time graphs refresh every few seconds while the page is open, as in
// Plex Web's dashboard; longer bins are read once per change.
const REFRESH_MS = 5000;
const REMOTE_COLOR = '#3b82f6';
const LOCAL_COLOR = '#f59e0b';
// Plex Web's own CPU and RAM colours (taken from its dashboard).
const CPU_COLORS = { system: '#f1335e', plex: '#9ad186' };
const MEMORY_COLORS = { system: '#bd86d1', plex: '#33f1c5' };

// Real-time points are labelled by how long ago they were, like Plex Web.
const secondsAgo = (at: string, latest: number) => {
  const seconds = Math.max(0, Math.round((latest - Date.parse(at)) / 1000));
  if (seconds === 0) return 'Now';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${rest ? ` ${rest}s` : ''} ago` : `${seconds}s ago`;
};

function useStatistics<T>(read: (signal: AbortSignal) => Promise<T>, key: string, live: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    setLoading(true);
    setData(null);
    const tick = async () => {
      controller = new AbortController();
      try {
        const value = await read(controller.signal);
        if (stopped) return;
        setData(value);
        setError(null);
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error && err.message ? err.message : 'Statistics could not be read');
      } finally {
        if (!stopped) setLoading(false);
      }
      if (!stopped && live) timer = setTimeout(tick, REFRESH_MS);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [key, live]);
  return { data, error, loading };
}

const ChartMessage = ({ text, error }: { text: string; error?: boolean }) => (
  <div className={`absolute inset-0 flex items-center justify-center px-6 text-center text-sm ${error ? 'text-destructive' : 'text-muted-foreground'}`}>{text}</div>
);

/** A Plex server's dashboard graphs: bandwidth, CPU and memory. */
export const PlexResources = ({ serverId }: { serverId: number }) => {
  const { formatTimestamp } = useAccountDisplay();
  const [rangeValue, setRangeValue] = useState('realtime');
  const [account, setAccount] = useState<string>('all');
  const [network, setNetwork] = useState<BandwidthNetwork>('all');
  const range = BANDWIDTH_RANGES.find((r) => r.value === rangeValue) ?? BANDWIDTH_RANGES[0];
  const realTime = range.timespan === 'seconds';
  // A period's start is fixed when it is chosen, so refreshes ask for the same bins.
  const [rangeStart, setRangeStart] = useState(() => Date.now());
  useEffect(() => { setRangeStart(Date.now()); }, [rangeValue]);
  const bandwidth = useStatistics<BandwidthStatistics>(
    (signal) => fetchBandwidth(serverId, range.timespan, signal, rangeSince(range, rangeStart)),
    `bandwidth:${serverId}:${range.value}:${rangeStart}`,
    realTime
  );
  const resources = useStatistics<ResourceSample[]>((signal) => fetchResources(serverId, signal), `resources:${serverId}`, true);

  const bandwidthPoints = useMemo(
    () => realTime
      ? bandwidthSeries(bandwidth.data?.samples ?? [], 'seconds', account === 'all' ? null : account)
      : bandwidthBars(bandwidth.data?.samples ?? [], range, account === 'all' ? null : account, rangeStart),
    [bandwidth.data, realTime, range, account, rangeStart]
  );
  const showRemote = network !== 'local';
  const showLocal = network !== 'remote';
  // Hovering one series' bar dims the other in every bar and in the legend, as in Plex.
  const [hoveredSeries, setHoveredSeries] = useState<'remote' | 'local' | null>(null);
  const barColor = (series: 'remote' | 'local', color: string) => (hoveredSeries && hoveredSeries !== series ? `${color}59` : color);
  const bandwidthLatest = bandwidthPoints.length ? Date.parse(bandwidthPoints[bandwidthPoints.length - 1].at) : 0;
  // Month bins are labelled by their month; the mid-month point keeps a
  // server's local month start from reading as the month before.
  const monthLabel = (at: string, style: 'short' | 'long') =>
    new Date(Date.parse(at) + 15 * 86400 * 1000).toLocaleDateString(undefined, style === 'short' ? { month: 'short', year: '2-digit' } : { month: 'long', year: 'numeric' });
  const bandwidthLabel = (at: string) => {
    if (realTime) return secondsAgo(at, bandwidthLatest);
    if (range.timespan === 'months') return monthLabel(at, 'short');
    // Hours drop their seconds ("3:00 AM", "15:00"), keeping the account's clock style.
    if (range.timespan === 'hours') return formatTimestamp(at, 'time').replace(/(\d{1,2}:\d{2}):\d{2}/, '$1');
    return formatTimestamp(at, 'date');
  };
  const bandwidthTitle = (at: string) => {
    if (realTime) return secondsAgo(at, bandwidthLatest);
    if (range.timespan === 'months') return monthLabel(at, 'long');
    if (range.timespan === 'weeks') return `Week of ${formatTimestamp(at, 'date')}`;
    return formatTimestamp(at, range.timespan === 'hours' ? 'datetime' : 'date');
  };
  const formatBandwidth = (value: number) => (realTime ? formatRate(value) : formatBytes(value));
  const sum = (key: 'remote' | 'local') => bandwidthPoints.reduce((total, p) => total + p[key], 0);
  const average = (key: 'remote' | 'local') => bandwidthPoints.length ? sum(key) / bandwidthPoints.length : 0;
  const summary = [
    showRemote ? `remote ${realTime ? formatRate(average('remote')) : formatBytes(sum('remote'))}` : null,
    showLocal ? `local ${realTime ? formatRate(average('local')) : formatBytes(sum('local'))}` : null,
  ].filter(Boolean).join(', ');

  const cpu = useMemo(() => resourceSeries(resources.data ?? [], 'cpu'), [resources.data]);
  const memory = useMemo(() => resourceSeries(resources.data ?? [], 'memory'), [resources.data]);
  const resourcesLatest = cpu.length ? Date.parse(cpu[cpu.length - 1].at) : 0;

  const accounts = bandwidth.data?.accounts ?? [];
  useEffect(() => {
    if (account !== 'all' && bandwidth.data && !accounts.some((a) => a.id === account)) setAccount('all');
  }, [account, accounts, bandwidth.data]);

  const bandwidthTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<any>; label?: string | number }) => {
    if (!active || !payload?.length) return null;
    // The dots keep their full colours while a hovered bar dims the other series.
    const seriesColor: Record<string, string> = { remote: REMOTE_COLOR, local: LOCAL_COLOR };
    const rows = payload.map((entry) => ({
      key: String(entry.dataKey), label: String(entry.name), value: formatBandwidth(Number(entry.value || 0)), dotColor: seriesColor[String(entry.dataKey)] ?? String(entry.color),
    }));
    // A period's bar also shows its total, as in Plex.
    if (!realTime && payload.length > 1) {
      rows.push({ key: 'total', label: 'Total', value: formatBytes(payload.reduce((total, entry) => total + Number(entry.value || 0), 0)), dotColor: 'var(--muted-foreground)' });
    }
    return renderGraphsTooltipCard(bandwidthTitle(String(label ?? '')), rows);
  };
  const percentTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<any>; label?: string | number }) => {
    if (!active || !payload?.length) return null;
    return renderGraphsTooltipCard(secondsAgo(String(label ?? ''), resourcesLatest), payload.map((entry) => ({
      key: String(entry.dataKey), label: String(entry.name), value: entry.value == null ? '—' : `${Number(entry.value).toFixed(1)}%`, dotColor: String(entry.color),
    })));
  };
  const legendProps = { itemSorter: null, iconType: 'circle' as const, iconSize: 10, wrapperStyle: { fontSize: '12px' } };

  const percentChart = (points: typeof cpu, kind: string, colors: { system: string; plex: string }) => (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={points} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
        <XAxis dataKey="at" tickFormatter={(at) => secondsAgo(String(at), resourcesLatest)} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} minTickGap={24} />
        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={44} />
        <Tooltip content={percentTooltip} />
        <Legend {...legendProps} />
        <Line type="monotone" dataKey="system" name={`System ${kind}`} stroke={colors.system} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="plex" name={`Plex Media Server ${kind}`} stroke={colors.plex} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
  const resourceState = (points: typeof cpu) =>
    resources.error ? <ChartMessage error text={resources.error} />
      : !resources.loading && points.length === 0 ? <ChartMessage text="Plex reported no recent readings." /> : null;

  return (
    <div className="space-y-6">
      <ChartCard
        title="Bandwidth"
        description={realTime
          ? `Data Plex is sending right now. Averages: ${summary}.`
          : `Data Plex sent in each period. Totals: ${summary}.`}
        icon={faNetworkWired}
        loading={bandwidth.loading}
        actions={<>
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="w-[180px]" aria-label="Account"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All accounts</SelectItem>
              {accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name || `Account ${a.id}`}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={network} onValueChange={(value) => setNetwork(value as BandwidthNetwork)}>
            <SelectTrigger className="w-[180px]" aria-label="Network"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="remote">Remote</SelectItem>
              <SelectItem value="local">Local</SelectItem>
            </SelectContent>
          </Select>
          <Select value={rangeValue} onValueChange={setRangeValue}>
            <SelectTrigger className="w-[180px]" aria-label="Time range"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BANDWIDTH_RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </>}
      >
        {/* Real time is a rate over the last minutes; any period is stacked bars of data sent, as in Plex. */}
        {realTime ? <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={bandwidthPoints} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
            <XAxis dataKey="at" tickFormatter={(at) => bandwidthLabel(String(at))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} minTickGap={24} />
            <YAxis tickFormatter={(v) => formatBandwidth(Number(v))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={72} />
            <Tooltip content={bandwidthTooltip} />
            <Legend {...legendProps} />
            {showRemote && <Area type="monotone" dataKey="remote" name="Remote" stroke={REMOTE_COLOR} fill={REMOTE_COLOR} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />}
            {showLocal && <Area type="monotone" dataKey="local" name="Local" stroke={LOCAL_COLOR} fill={LOCAL_COLOR} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />}
          </AreaChart>
        </ResponsiveContainer> : <ResponsiveContainer width="100%" height={300}>
          <BarChart data={bandwidthPoints} margin={{ top: 10, right: 20, left: 0, bottom: 0 }} onMouseLeave={() => setHoveredSeries(null)}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
            <XAxis dataKey="at" tickFormatter={(at) => bandwidthLabel(String(at))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} minTickGap={24} />
            <YAxis tickFormatter={(v) => formatBytes(Number(v))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={72} />
            <Tooltip content={bandwidthTooltip} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
            <Legend {...legendProps} />
            {showRemote && <Bar dataKey="remote" name="Remote" stackId="bandwidth" fill={barColor('remote', REMOTE_COLOR)} isAnimationActive={false}
              onMouseEnter={() => setHoveredSeries('remote')} onMouseLeave={() => setHoveredSeries(null)} />}
            {showLocal && <Bar dataKey="local" name="Local" stackId="bandwidth" fill={barColor('local', LOCAL_COLOR)} radius={[3, 3, 0, 0]} isAnimationActive={false}
              onMouseEnter={() => setHoveredSeries('local')} onMouseLeave={() => setHoveredSeries(null)} />}
          </BarChart>
        </ResponsiveContainer>}
        {bandwidth.error ? <ChartMessage error text={bandwidth.error} />
          : !bandwidth.loading && bandwidthPoints.length === 0 ? <ChartMessage text="Plex reported no bandwidth for this period." /> : null}
      </ChartCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="CPU" description="Processor use of the whole machine and of Plex Media Server, over the last few minutes." icon={faMicrochip} loading={resources.loading}>
          {percentChart(cpu, 'CPU', CPU_COLORS)}
          {resourceState(cpu)}
        </ChartCard>
        <ChartCard title="Memory" description="Memory use of the whole machine and of Plex Media Server, over the last few minutes." icon={faMemory} loading={resources.loading}>
          {percentChart(memory, 'memory', MEMORY_COLORS)}
          {resourceState(memory)}
        </ChartCard>
      </div>
    </div>
  );
};
