import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChartLine, faCircleNodes, faHeartPulse, faRotate } from '@fortawesome/free-solid-svg-icons';
import { IconDefinition } from '@fortawesome/fontawesome-svg-core';

import { PageHeader } from '../components';
import { useServers } from '../hooks/useServers';
import { useAdminApi } from '../hooks/useAdminApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { ServiceIcon } from '@/components/services/ServiceIcon';

type HourlyActivityItem = { hour: number; plays: number };
type WatchTimeActivityItem = { date: string; label: string; minutes: number };
type DevicePreferenceItem = { name: string; value: number };
type PlaybackHealthItem = { name: string; value: number; color?: string };
type SeparatedServer = { id: number; key: string; name: string; service_type: string };
type SeparatedHourlyItem = { hour: number; label: string; values: Record<string, number> };
type SeparatedWatchTimeItem = { date: string; label: string; values: Record<string, number> };
type SeparatedStackCategory = { key: string; label: string; color?: string };
type SeparatedStackRow = {
  server_id: number;
  server_key: string;
  server_name: string;
  service_type: string;
  total: number;
  values: Record<string, number>;
  counts: Record<string, number>;
};
type SeparatedStackDataset = {
  categories: SeparatedStackCategory[];
  rows: SeparatedStackRow[];
};
type SeparatedGraphsData = {
  enabled: boolean;
  servers: SeparatedServer[];
  hourly_activity: SeparatedHourlyItem[];
  watch_time_activity?: SeparatedWatchTimeItem[];
  device_preferences: SeparatedStackDataset;
  playback_health: SeparatedStackDataset;
  excluded_service_types?: string[];
  playback_health_meta?: Record<string, number>;
};

type GraphsAnalyticsResponse = {
  data: {
    hourly_activity: HourlyActivityItem[];
    watch_time_activity?: WatchTimeActivityItem[];
    device_preferences: DevicePreferenceItem[];
    playback_health: PlaybackHealthItem[];
    separated?: SeparatedGraphsData;
  };
  meta?: {
    generated_at?: string;
    notes?: string[];
    sources?: Record<string, string>;
    filters?: Record<string, unknown>;
  };
};

const STORAGE_KEY = 'mum_graphs_filters';
const DEVICE_COLORS = ['#06b6d4', '#3b82f6', '#8b5cf6', '#64748b', '#f59e0b', '#ec4899'];
const PLAYBACK_HEALTH_UNSUPPORTED_SERVICES = new Set(['kavita', 'komga', 'romm']);
const SERVICE_LINE_COLORS: Record<string, string> = {
  plex: 'var(--color-plex)',
  jellyfin: 'var(--color-jellyfin)',
  emby: 'var(--color-emby)',
  kavita: 'var(--color-kavita)',
  audiobookshelf: 'var(--color-audiobookshelf)',
  komga: 'var(--color-komga)',
  romm: 'var(--color-romm)',
};

const formatGeneratedAt = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const formatMinutesCompact = (rawMinutes: number) => {
  const minutes = Math.max(0, Math.round(rawMinutes || 0));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours}h ${remainingMinutes}m` : `${minutes}m`;
};

const parseIsoDateOnly = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatChartDateShort = (value: string) => {
  const parsed = parseIsoDateOnly(value);
  if (!parsed) return value;
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const formatChartDateFull = (value: string) => {
  const parsed = parseIsoDateOnly(value);
  if (!parsed) return value;
  return parsed.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

const renderGraphsTooltipCard = (
  title: string,
  rows: Array<{ key: string; label: string; value: string; dotClass?: string; dotColor?: string }>
) => (
  <div className="min-w-[220px] rounded-xl border border-border/60 bg-popover/95 px-4 py-3 text-popover-foreground shadow-2xl backdrop-blur">
    <div className="text-sm font-semibold">{title}</div>
    <div className="my-3 h-px bg-border/60" />
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span
              className={`h-2.5 w-2.5 rounded-full ${row.dotClass ?? ''}`}
              style={row.dotColor ? { backgroundColor: row.dotColor } : undefined}
            />
            <span>{row.label}</span>
          </div>
          <span className="font-semibold text-popover-foreground">{row.value}</span>
        </div>
      ))}
    </div>
  </div>
);

const renderHourlyActivityTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<any>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const value = Number(entry?.value || 0);
  return renderGraphsTooltipCard(String(label || 'Hour'), [
    {
      key: 'plays',
      label: 'Plays',
      value: String(Math.round(value)),
      dotColor: String(entry?.color || 'var(--chart-1)'),
    },
  ]);
};

const renderPieMetricTooltip = ({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<any>;
}) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const name = String(entry?.name || entry?.payload?.name || 'Value');
  const rawValue = Number(entry?.value || 0);
  const isPercent = name !== 'Direct Play' && name !== 'Direct Stream' && name !== 'Transcode';
  const metricLabel = isPercent ? 'Share' : 'Sessions';
  const formattedValue = isPercent ? `${Math.round(rawValue)}%` : String(Math.round(rawValue));
  const dotColor = String(entry?.color || entry?.payload?.color || DEVICE_COLORS[0]);

  return renderGraphsTooltipCard(name, [
    {
      key: `${name}-${metricLabel}`,
      label: metricLabel,
      value: formattedValue,
      dotColor,
    },
  ]);
};

const renderSeparatedHourlyTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<any>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const rows = [...payload]
    .map((entry) => ({
      key: String(entry?.dataKey || entry?.name || Math.random()),
      label: String(entry?.name || 'Server'),
      value: String(Math.round(Number(entry?.value || 0))),
      dotColor: String(entry?.color || 'var(--chart-1)'),
      sortValue: Number(entry?.value || 0),
    }))
    .sort((a, b) => b.sortValue - a.sortValue)
    .map(({ sortValue: _sortValue, ...rest }) => rest);
  return renderGraphsTooltipCard(String(label || 'Hour'), rows);
};

const renderSeparatedStackedTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<any>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const firstRow = payload[0]?.payload as Record<string, unknown> | undefined;
  const counts = (firstRow?._counts as Record<string, number> | undefined) ?? {};

  const rows = payload
    .filter((entry) => Number(entry?.value || 0) > 0)
    .map((entry) => {
      const seriesName = String(entry?.name || entry?.dataKey || 'Value');
      const pct = Math.round(Number(entry?.value || 0));
      const rawCount = Number(counts[seriesName] || 0);
      const value = rawCount > 0 ? `${pct}% (${rawCount})` : `${pct}%`;
      return {
        key: String(entry?.dataKey || seriesName),
        label: seriesName,
        value,
        dotColor: String(entry?.color || entry?.fill || DEVICE_COLORS[0]),
      };
    });

  if (!rows.length) {
    rows.push({
      key: 'no-data',
      label: 'No data',
      value: '0%',
      dotClass: 'bg-muted-foreground',
    });
  }

  return renderGraphsTooltipCard(String(label || firstRow?.server_name || 'Server'), rows);
};

const renderWatchTimeTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<any>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const minutes = Number(entry?.value || 0);
  return renderGraphsTooltipCard(formatChartDateFull(String(label || '')), [
    {
      key: 'watch-time',
      label: 'Watch Time',
      value: formatMinutesCompact(minutes),
      dotColor: String(entry?.color || '#22c55e'),
    },
  ]);
};

const renderSeparatedWatchTimeTooltip = ({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<any>;
  label?: string;
}) => {
  if (!active || !payload?.length) return null;
  const rows = [...payload]
    .map((entry) => ({
      key: String(entry?.dataKey || entry?.name || Math.random()),
      label: String(entry?.name || 'Server'),
      value: formatMinutesCompact(Number(entry?.value || 0)),
      dotColor: String(entry?.color || 'var(--chart-1)'),
      sortValue: Number(entry?.value || 0),
    }))
    .sort((a, b) => b.sortValue - a.sortValue)
    .map(({ sortValue: _sortValue, ...rest }) => rest);
  return renderGraphsTooltipCard(formatChartDateFull(String(label || '')), rows);
};

export const GraphsPage = () => {
  const [days, setDays] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return 30;
      const parsed = JSON.parse(raw) as { days?: number };
      return parsed.days && parsed.days >= 1 && parsed.days <= 365 ? parsed.days : 30;
    } catch {
      return 30;
    }
  });
  const [daysInput, setDaysInput] = useState(String(days));
  const [serverId, setServerId] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return 'all';
      const parsed = JSON.parse(raw) as { serverId?: string };
      return parsed.serverId || 'all';
    } catch {
      return 'all';
    }
  });
  const [isMobileViewport, setIsMobileViewport] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 640;
  });

  const { servers } = useServers({ activeOnly: true });
  const isAllServersSeparated = serverId === 'all-separated';
  const effectiveServerIdFilter = isAllServersSeparated ? 'all' : serverId;
  const serverMode = isAllServersSeparated ? 'separated' : 'combined';

  useEffect(() => {
    if (serverId === 'all' || serverId === 'all-separated') return;
    const selected = servers.find((server) => String(server.id) === serverId);
    if (!selected) return;
    if (PLAYBACK_HEALTH_UNSUPPORTED_SERVICES.has(String(selected.service_type || '').toLowerCase())) {
      setServerId('all');
    }
  }, [serverId, servers]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ days, serverId }));
  }, [days, serverId]);

  useEffect(() => {
    setDaysInput(String(days));
  }, [days]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => setIsMobileViewport(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const analyticsPath = useMemo(
    () =>
      `/graphs/analytics?days=${days}&server_id=${encodeURIComponent(effectiveServerIdFilter || 'all')}&server_mode=${serverMode}`,
    [days, effectiveServerIdFilter, serverMode]
  );
  const { data, loading, error, mutate } = useAdminApi<GraphsAnalyticsResponse>(analyticsPath);

  const hourlyChartData = useMemo(
    () =>
      (data?.data.hourly_activity ?? []).map((item) => ({
        hour: `${String(item.hour).padStart(2, '0')}:00`,
        value: item.plays ?? 0,
      })),
    [data]
  );
  const watchTimeActivityChartData = useMemo(
    () =>
      (data?.data.watch_time_activity ?? []).map((item) => ({
        date: item.date || item.label,
        value: Number(item.minutes || 0),
      })),
    [data]
  );
  const deviceChartData = data?.data.device_preferences ?? [];
  const playbackChartData = data?.data.playback_health ?? [];
  const separatedData = data?.data.separated;
  const generatedAtLabel = formatGeneratedAt(data?.meta?.generated_at);
  const playbackNote =
    data?.meta?.notes?.find((note) => note.toLowerCase().includes('playback health')) ?? null;
  const hourlyXAxisTicks = useMemo(
    () => (isMobileViewport ? ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'] : undefined),
    [isMobileViewport]
  );
  const isSeparatedModeActive = Boolean(isAllServersSeparated && separatedData?.enabled);

  const separatedServerColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    (separatedData?.servers ?? []).forEach((server) => {
      const serviceType = String(server.service_type || '').toLowerCase();
      map[server.key] = SERVICE_LINE_COLORS[serviceType] || 'var(--chart-1)';
    });
    return map;
  }, [separatedData?.servers]);

  const separatedHourlyChartData = useMemo(() => {
    if (!separatedData?.hourly_activity) return [];
    return separatedData.hourly_activity.map((point) => {
      const flattened: Record<string, number | string> = {
        hour: point.label || `${String(point.hour).padStart(2, '0')}:00`,
      };
      for (const [seriesKey, value] of Object.entries(point.values || {})) {
        flattened[seriesKey] = Number(value || 0);
      }
      return flattened;
    });
  }, [separatedData?.hourly_activity]);
  const separatedWatchTimeChartData = useMemo(() => {
    if (!separatedData?.watch_time_activity) return [];
    return separatedData.watch_time_activity.map((point) => {
      const flattened: Record<string, number | string> = {
        date: point.date || point.label,
      };
      for (const [seriesKey, value] of Object.entries(point.values || {})) {
        flattened[seriesKey] = Number(value || 0);
      }
      return flattened;
    });
  }, [separatedData?.watch_time_activity]);

  const separatedDeviceChartData = useMemo(() => {
    const categories = separatedData?.device_preferences?.categories ?? [];
    const rows = separatedData?.device_preferences?.rows ?? [];
    return rows.map((row) => {
      const flattened: Record<string, unknown> = {
        server_name: row.server_name,
        _counts: row.counts,
        _total: row.total,
      };
      categories.forEach((category) => {
        flattened[category.key] = Number(row.values?.[category.key] || 0);
      });
      return flattened;
    });
  }, [separatedData?.device_preferences]);

  const separatedPlaybackChartData = useMemo(() => {
    const categories = separatedData?.playback_health?.categories ?? [];
    const rows = separatedData?.playback_health?.rows ?? [];
    return rows.map((row) => {
      const flattened: Record<string, unknown> = {
        server_name: row.server_name,
        _counts: row.counts,
        _total: row.total,
      };
      categories.forEach((category) => {
        flattened[category.key] = Number(row.values?.[category.key] || 0);
      });
      return flattened;
    });
  }, [separatedData?.playback_health]);

  const [activeDeviceIndex, setActiveDeviceIndex] = useState(0);
  useEffect(() => {
    if (activeDeviceIndex >= deviceChartData.length) {
      setActiveDeviceIndex(0);
    }
  }, [activeDeviceIndex, deviceChartData.length]);

  const applyDaysFilter = () => {
    const parsed = Number(daysInput);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(1, Math.min(365, Math.floor(parsed)));
    setDays(clamped);
  };

  const totalPlaybackSessions = playbackChartData.reduce((sum, item) => sum + (item.value || 0), 0);
  const totalWatchTimeMinutes = watchTimeActivityChartData.reduce((sum, item) => sum + (item.value || 0), 0);
  const separatedPlaybackTotal = useMemo(
    () =>
      (separatedData?.playback_health?.rows ?? []).reduce(
        (sum, row) => sum + Number(row.total || 0),
        0
      ),
    [separatedData?.playback_health?.rows]
  );

  const renderActiveDeviceShape = (props: any) => {
    const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill, value } = props;
    return (
      <g>
        <text x={cx} y={cy} dy={6} textAnchor="middle" fill={fill} className="text-lg font-bold">
          {value}%
        </text>
        <Sector
          cx={cx}
          cy={cy}
          innerRadius={innerRadius}
          outerRadius={outerRadius + 8}
          startAngle={startAngle}
          endAngle={endAngle}
          fill={fill}
        />
        <Sector
          cx={cx}
          cy={cy}
          startAngle={startAngle}
          endAngle={endAngle}
          innerRadius={outerRadius + 10}
          outerRadius={outerRadius + 12}
          fill={fill}
        />
      </g>
    );
  };

  const legendProps = {
    iconType: 'circle' as const,
    iconSize: isMobileViewport ? 8 : 10,
    wrapperStyle: {
      fontSize: isMobileViewport ? '11px' : '12px',
      lineHeight: isMobileViewport ? '16px' : '18px',
    },
  };

  const renderChartCard = (
    title: string,
    description: string,
    icon: IconDefinition,
    children: React.ReactNode
  ) => (
    <Card className="pt-0 gap-0 overflow-hidden border border-border/60 shadow-md">
      <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
              <FontAwesomeIcon icon={icon} className="text-lg" />
            </div>
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-2xl text-foreground">{title}</CardTitle>
              <CardDescription className="text-sm text-muted-foreground space-y-1">
                <p>{description}</p>
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-5 pb-6">
        <div className="relative min-h-[300px]">
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />
                Loading graph...
              </div>
            </div>
          ) : null}
          {children}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Graphs"
        description="Streaming analytics visualizations across your connected media servers."
      />

      <Card className="border shadow-sm">
        <CardContent>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">Filters</div>
            <Button variant="outline" size="sm" onClick={() => void mutate()} disabled={loading}>
              <FontAwesomeIcon icon={faRotate} className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="graphs-days">Time Range (Days)</Label>
              <div className="flex gap-2">
                <Input
                  id="graphs-days"
                  type="number"
                  min={1}
                  max={365}
                  value={daysInput}
                  onChange={(e) => setDaysInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      applyDaysFilter();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={applyDaysFilter}>
                  Apply
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="graphs-server">Server</Label>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger id="graphs-server">
                  <SelectValue placeholder="All Servers (Combined)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Servers (Combined)</SelectItem>
                  <SelectItem value="all-separated">All Servers (Separated)</SelectItem>
                  {servers.map((server) => (
                    <SelectItem
                      key={server.id}
                      value={String(server.id)}
                      disabled={PLAYBACK_HEALTH_UNSUPPORTED_SERVICES.has(
                        String(server.service_type || '').toLowerCase()
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <ServiceIcon serviceType={server.service_type} className="h-4 w-4 shrink-0" />
                        <span>{server.server_nickname}</span>
                        {PLAYBACK_HEALTH_UNSUPPORTED_SERVICES.has(
                          String(server.service_type || '').toLowerCase()
                        ) ? (
                          <span className="text-xs text-muted-foreground">No stream history</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{generatedAtLabel ? `Generated ${generatedAtLabel}` : 'Waiting for analytics data...'}</span>
            {playbackNote ? <span>{playbackNote}</span> : null}
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              Failed to load analytics graphs: {error}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="md:col-span-2">
          {renderChartCard(
            'Activity by Hour',
            'Play counts grouped by hour across the selected stream history window.',
            faChartLine,
            <div className="h-[300px] w-full">
              {isSeparatedModeActive ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={separatedHourlyChartData}
                    margin={{ top: 10, right: isMobileViewport ? 8 : 16, left: isMobileViewport ? 8 : 4, bottom: 0 }}
                  >
                    <defs>
                      {(separatedData?.servers ?? []).map((server) => {
                        const color = separatedServerColorMap[server.key] || 'var(--chart-1)';
                        return (
                          <linearGradient key={`grad-${server.key}`} id={`graphs-hourly-${server.key}-gradient`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                          </linearGradient>
                        );
                      })}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
                    <XAxis
                      dataKey="hour"
                      ticks={hourlyXAxisTicks}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      minTickGap={isMobileViewport ? 14 : 12}
                      tickMargin={8}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) =>
                        isMobileViewport ? String(value ?? '').replace(':00', '') : String(value ?? '')
                      }
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={isMobileViewport ? 36 : 44}
                      tickMargin={6}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                    <Tooltip
                      content={renderSeparatedHourlyTooltip}
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    />
                    <Legend verticalAlign="bottom" {...legendProps} />
                    {(separatedData?.servers ?? []).map((server) => (
                      <Area
                        key={server.key}
                        type="monotone"
                        dataKey={server.key}
                        name={server.name}
                        stroke={separatedServerColorMap[server.key] || 'var(--chart-1)'}
                        strokeWidth={2}
                        fill={`url(#graphs-hourly-${server.key}-gradient)`}
                        dot={false}
                        activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
                        connectNulls
                        fillOpacity={1}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={hourlyChartData}
                    margin={{ top: 10, right: isMobileViewport ? 8 : 16, left: isMobileViewport ? 8 : 4, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="graphs-hourly-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--chart-1)" stopOpacity={0.8} />
                        <stop offset="95%" stopColor="var(--chart-1)" stopOpacity={0.05} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
                    <XAxis
                      dataKey="hour"
                      ticks={hourlyXAxisTicks}
                      tickLine={false}
                      axisLine={false}
                      interval={0}
                      minTickGap={isMobileViewport ? 14 : 12}
                      tickMargin={8}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) =>
                        isMobileViewport ? String(value ?? '').replace(':00', '') : String(value ?? '')
                      }
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      allowDecimals={false}
                      width={isMobileViewport ? 36 : 44}
                      tickMargin={6}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                    <Tooltip
                      content={renderHourlyActivityTooltip}
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="var(--chart-1)"
                      strokeWidth={2}
                      fill="url(#graphs-hourly-gradient)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              {!loading && isSeparatedModeActive && (separatedData?.servers?.length ?? 0) === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No supported servers available for separated analytics.
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="md:col-span-2">
          {renderChartCard(
            'Watch Time Activity',
            'Watch time trend across all libraries for the selected server scope.',
            faChartLine,
            <div className="h-[300px] w-full">
              {isSeparatedModeActive ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={separatedWatchTimeChartData}
                    margin={{ top: 10, right: isMobileViewport ? 8 : 16, left: isMobileViewport ? 8 : 4, bottom: 0 }}
                  >
                    <defs>
                      {(separatedData?.servers ?? []).map((server) => {
                        const color = separatedServerColorMap[server.key] || 'var(--chart-1)';
                        return (
                          <linearGradient
                            key={`watchtime-grad-${server.key}`}
                            id={`graphs-watchtime-${server.key}-gradient`}
                            x1="0"
                            y1="0"
                            x2="0"
                            y2="1"
                          >
                            <stop offset="5%" stopColor={color} stopOpacity={0.28} />
                            <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                          </linearGradient>
                        );
                      })}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={isMobileViewport ? 22 : 14}
                      tickMargin={8}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => formatChartDateShort(String(value || ''))}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={isMobileViewport ? 46 : 58}
                      tickMargin={6}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => formatMinutesCompact(Number(value || 0))}
                    />
                    <Tooltip
                      content={renderSeparatedWatchTimeTooltip}
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    />
                    <Legend verticalAlign="bottom" {...legendProps} />
                    {(separatedData?.servers ?? []).map((server) => (
                      <Area
                        key={`watchtime-${server.key}`}
                        type="monotone"
                        dataKey={server.key}
                        name={server.name}
                        stroke={separatedServerColorMap[server.key] || 'var(--chart-1)'}
                        strokeWidth={2}
                        fill={`url(#graphs-watchtime-${server.key}-gradient)`}
                        dot={false}
                        activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
                        connectNulls
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={watchTimeActivityChartData}
                    margin={{ top: 10, right: isMobileViewport ? 8 : 16, left: isMobileViewport ? 8 : 4, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="graphs-watchtime-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.45} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0.04} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      interval="preserveStartEnd"
                      minTickGap={isMobileViewport ? 22 : 14}
                      tickMargin={8}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => formatChartDateShort(String(value || ''))}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      width={isMobileViewport ? 46 : 58}
                      tickMargin={6}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => formatMinutesCompact(Number(value || 0))}
                    />
                    <Tooltip
                      content={renderWatchTimeTooltip}
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#22c55e"
                      strokeWidth={2}
                      fill="url(#graphs-watchtime-gradient)"
                      dot={false}
                      activeDot={{ r: 4, stroke: 'var(--background)', strokeWidth: 2 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              )}
              {!loading &&
              ((isSeparatedModeActive &&
                ((separatedData?.servers?.length ?? 0) === 0 || separatedWatchTimeChartData.length === 0)) ||
                (!isSeparatedModeActive && totalWatchTimeMinutes === 0)) ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No watch-time history found for this time range.
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div>
          {renderChartCard(
            'Client Device Mix',
            'Distribution of playback sessions by detected client device category.',
            faCircleNodes,
            <div
              className="w-full"
              style={{
                height: isSeparatedModeActive
                  ? Math.max(300, (separatedData?.device_preferences?.rows?.length ?? 0) * 44 + 90)
                  : 300,
              }}
            >
              {isSeparatedModeActive ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={separatedDeviceChartData}
                    layout="vertical"
                    margin={{ top: 8, right: 12, left: 0, bottom: 18 }}
                    barCategoryGap={8}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.25} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(value) => `${Math.round(Number(value || 0))}%`}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="server_name"
                      width={isMobileViewport ? 84 : 120}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => {
                        const text = String(value || '');
                        return text.length > (isMobileViewport ? 12 : 18)
                          ? `${text.slice(0, isMobileViewport ? 11 : 17)}…`
                          : text;
                      }}
                    />
                    <Tooltip content={renderSeparatedStackedTooltip} cursor={false} />
                    <Legend verticalAlign="bottom" {...legendProps} />
                    {(separatedData?.device_preferences?.categories ?? []).map((category) => (
                      <Bar
                        key={category.key}
                        dataKey={category.key}
                        name={category.label}
                        stackId="device-mix"
                        fill={category.color || DEVICE_COLORS[0]}
                        radius={[0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={deviceChartData}
                      dataKey="value"
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      activeIndex={activeDeviceIndex}
                      activeShape={renderActiveDeviceShape}
                      onMouseEnter={(_, index) => setActiveDeviceIndex(index)}
                      stroke="none"
                    >
                      {deviceChartData.map((_, index) => (
                        <Cell key={`device-cell-${index}`} fill={DEVICE_COLORS[index % DEVICE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={renderPieMetricTooltip} />
                    <Legend verticalAlign="bottom" {...legendProps} />
                  </PieChart>
                </ResponsiveContainer>
              )}
              {!loading &&
              ((isSeparatedModeActive &&
                (separatedData?.device_preferences?.rows ?? []).every((row) => Number(row.total || 0) === 0)) ||
                (!isSeparatedModeActive && deviceChartData.length === 0)) ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No stream history found for this time range.
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div>
          {renderChartCard(
            'Playback Delivery Modes',
            'Historical split of direct play, direct stream, and transcode sessions.',
            faHeartPulse,
            <div
              className="w-full"
              style={{
                height: isSeparatedModeActive
                  ? Math.max(300, (separatedData?.playback_health?.rows?.length ?? 0) * 44 + 90)
                  : 300,
              }}
            >
              {isSeparatedModeActive ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={separatedPlaybackChartData}
                    layout="vertical"
                    margin={{ top: 8, right: 12, left: 0, bottom: 18 }}
                    barCategoryGap={8}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border)" opacity={0.25} />
                    <XAxis
                      type="number"
                      domain={[0, 100]}
                      tickFormatter={(value) => `${Math.round(Number(value || 0))}%`}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                    <YAxis
                      type="category"
                      dataKey="server_name"
                      width={isMobileViewport ? 84 : 120}
                      tickLine={false}
                      axisLine={false}
                      tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                      tickFormatter={(value) => {
                        const text = String(value || '');
                        return text.length > (isMobileViewport ? 12 : 18)
                          ? `${text.slice(0, isMobileViewport ? 11 : 17)}…`
                          : text;
                      }}
                    />
                    <Tooltip content={renderSeparatedStackedTooltip} cursor={false} />
                    <Legend verticalAlign="bottom" {...legendProps} />
                    {(separatedData?.playback_health?.categories ?? []).map((category) => (
                      <Bar
                        key={category.key}
                        dataKey={category.key}
                        name={category.label}
                        stackId="playback-health"
                        fill={category.color || DEVICE_COLORS[0]}
                        radius={[0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={playbackChartData}
                      dataKey="value"
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={90}
                      paddingAngle={5}
                      stroke="none"
                    >
                      {playbackChartData.map((entry, index) => (
                        <Cell key={`playback-cell-${index}`} fill={entry.color || DEVICE_COLORS[index % DEVICE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip content={renderPieMetricTooltip} />
                    <Legend verticalAlign="bottom" {...legendProps} />
                  </PieChart>
                </ResponsiveContainer>
              )}
              {!loading &&
              ((isSeparatedModeActive && separatedPlaybackTotal === 0) ||
                (!isSeparatedModeActive && totalPlaybackSessions === 0)) ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No playback history found for this time range.
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default GraphsPage;
