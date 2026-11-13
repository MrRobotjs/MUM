import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { faMemory, faMicrochip, faNetworkWired } from '@fortawesome/free-solid-svg-icons';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { ChartCard, renderGraphsTooltipCard } from '../../pages/GraphsPage';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import {
  BANDWIDTH_TIMESPANS,
  bandwidthSeries,
  fetchBandwidth,
  fetchResources,
  formatBytes,
  formatRate,
  resourceSeries,
  type BandwidthStatistics,
  type BandwidthTimespan,
  type ResourceSample,
} from '../../lib/plexResources';

// Real-time graphs refresh every few seconds while the page is open, as in
// Plex Web's dashboard; longer bins are read once per change.
const REFRESH_MS = 5000;
const REMOTE_COLOR = '#3b82f6';
const LOCAL_COLOR = '#f59e0b';
const SYSTEM_COLOR = '#ec4899';
const PLEX_COLOR = '#22c55e';

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
  const [timespan, setTimespan] = useState<BandwidthTimespan>('seconds');
  const [account, setAccount] = useState<string>('all');
  const bandwidth = useStatistics<BandwidthStatistics>((signal) => fetchBandwidth(serverId, timespan, signal), `bandwidth:${serverId}:${timespan}`, timespan === 'seconds');
  const resources = useStatistics<ResourceSample[]>((signal) => fetchResources(serverId, signal), `resources:${serverId}`, true);

  const realTime = timespan === 'seconds';
  const bandwidthPoints = useMemo(
    () => bandwidthSeries(bandwidth.data?.samples ?? [], timespan, account === 'all' ? null : account),
    [bandwidth.data, timespan, account]
  );
  const bandwidthLatest = bandwidthPoints.length ? Date.parse(bandwidthPoints[bandwidthPoints.length - 1].at) : 0;
  const bandwidthLabel = (at: string) => realTime ? secondsAgo(at, bandwidthLatest) : formatTimestamp(at, timespan === 'hours' ? 'datetime' : 'date');
  const formatBandwidth = (value: number) => (realTime ? formatRate(value) : formatBytes(value));
  const average = (key: 'remote' | 'local') => bandwidthPoints.length ? bandwidthPoints.reduce((sum, p) => sum + p[key], 0) / bandwidthPoints.length : 0;

  const cpu = useMemo(() => resourceSeries(resources.data ?? [], 'cpu'), [resources.data]);
  const memory = useMemo(() => resourceSeries(resources.data ?? [], 'memory'), [resources.data]);
  const resourcesLatest = cpu.length ? Date.parse(cpu[cpu.length - 1].at) : 0;

  const accounts = bandwidth.data?.accounts ?? [];
  useEffect(() => {
    if (account !== 'all' && bandwidth.data && !accounts.some((a) => a.id === account)) setAccount('all');
  }, [account, accounts, bandwidth.data]);

  const bandwidthTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<any>; label?: string | number }) => {
    if (!active || !payload?.length) return null;
    const at = String(label ?? '');
    return renderGraphsTooltipCard(realTime ? secondsAgo(at, bandwidthLatest) : formatTimestamp(at, 'datetime'), payload.map((entry) => ({
      key: String(entry.dataKey), label: String(entry.name), value: formatBandwidth(Number(entry.value || 0)), dotColor: String(entry.color),
    })));
  };
  const percentTooltip = ({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<any>; label?: string | number }) => {
    if (!active || !payload?.length) return null;
    return renderGraphsTooltipCard(secondsAgo(String(label ?? ''), resourcesLatest), payload.map((entry) => ({
      key: String(entry.dataKey), label: String(entry.name), value: entry.value == null ? '—' : `${Number(entry.value).toFixed(1)}%`, dotColor: String(entry.color),
    })));
  };
  const legendProps = { itemSorter: null, iconType: 'circle' as const, iconSize: 10, wrapperStyle: { fontSize: '12px' } };

  const percentChart = (points: typeof cpu, kind: string) => (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={points} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
        <XAxis dataKey="at" tickFormatter={(at) => secondsAgo(String(at), resourcesLatest)} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} minTickGap={24} />
        <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={44} />
        <Tooltip content={percentTooltip} />
        <Legend {...legendProps} />
        <Line type="monotone" dataKey="system" name={`System ${kind}`} stroke={SYSTEM_COLOR} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="plex" name={`Plex Media Server ${kind}`} stroke={PLEX_COLOR} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
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
          ? `Data Plex is sending right now, remote and local. Averages: remote ${formatRate(average('remote'))}, local ${formatRate(average('local'))}.`
          : 'Data Plex sent in each period, remote and local.'}
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
          <Select value={timespan} onValueChange={(value) => setTimespan(value as BandwidthTimespan)}>
            <SelectTrigger className="w-[180px]" aria-label="Time span"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BANDWIDTH_TIMESPANS.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </>}
      >
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={bandwidthPoints} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
            <XAxis dataKey="at" tickFormatter={(at) => bandwidthLabel(String(at))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} minTickGap={24} />
            <YAxis tickFormatter={(v) => formatBandwidth(Number(v))} tickLine={false} axisLine={false} tickMargin={6} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={72} />
            <Tooltip content={bandwidthTooltip} />
            <Legend {...legendProps} />
            <Area type="monotone" dataKey="remote" name="Remote" stroke={REMOTE_COLOR} fill={REMOTE_COLOR} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
            <Area type="monotone" dataKey="local" name="Local" stroke={LOCAL_COLOR} fill={LOCAL_COLOR} fillOpacity={0.15} strokeWidth={2} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        {bandwidth.error ? <ChartMessage error text={bandwidth.error} />
          : !bandwidth.loading && bandwidthPoints.length === 0 ? <ChartMessage text="Plex reported no bandwidth for this period." /> : null}
      </ChartCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartCard title="CPU" description="Processor use of the whole machine and of Plex Media Server, over the last few minutes." icon={faMicrochip} loading={resources.loading}>
          {percentChart(cpu, 'CPU')}
          {resourceState(cpu)}
        </ChartCard>
        <ChartCard title="Memory" description="Memory use of the whole machine and of Plex Media Server, over the last few minutes." icon={faMemory} loading={resources.loading}>
          {percentChart(memory, 'memory')}
          {resourceState(memory)}
        </ChartCard>
      </div>
    </div>
  );
};
