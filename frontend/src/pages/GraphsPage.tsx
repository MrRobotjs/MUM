import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
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
type DevicePreferenceItem = { name: string; value: number };
type PlaybackHealthItem = { name: string; value: number; color?: string };

type GraphsAnalyticsResponse = {
  data: {
    hourly_activity: HourlyActivityItem[];
    device_preferences: DevicePreferenceItem[];
    playback_health: PlaybackHealthItem[];
  };
  meta?: {
    generated_at?: string;
    notes?: string[];
    sources?: Record<string, string>;
  };
};

const STORAGE_KEY = 'mum_graphs_filters';
const DEVICE_COLORS = ['#06b6d4', '#3b82f6', '#8b5cf6', '#64748b', '#f59e0b', '#ec4899'];
const PLAYBACK_HEALTH_UNSUPPORTED_SERVICES = new Set(['kavita', 'komga', 'romm']);
const chartTooltipStyle = {
  borderRadius: '10px',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--popover)',
  color: 'var(--popover-foreground)',
};
const chartTooltipLabelStyle = {
  color: 'var(--popover-foreground)',
};
const chartTooltipItemStyle = {
  color: 'var(--popover-foreground)',
};

const formatGeneratedAt = (value?: string) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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

  const { servers } = useServers({ activeOnly: true });

  useEffect(() => {
    if (serverId === 'all') return;
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

  const analyticsPath = useMemo(
    () => `/graphs/analytics?days=${days}&server_id=${encodeURIComponent(serverId || 'all')}`,
    [days, serverId]
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
  const deviceChartData = data?.data.device_preferences ?? [];
  const playbackChartData = data?.data.playback_health ?? [];
  const generatedAtLabel = formatGeneratedAt(data?.meta?.generated_at);
  const playbackNote =
    data?.meta?.notes?.find((note) => note.toLowerCase().includes('playback health')) ?? null;

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
                  <SelectValue placeholder="All servers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Servers</SelectItem>
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
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourlyChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="graphs-hourly-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.35} />
                  <XAxis dataKey="hour" tickLine={false} axisLine={false} interval={3} />
                  <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    labelStyle={chartTooltipLabelStyle}
                    itemStyle={chartTooltipItemStyle}
                    formatter={(value) => [value, 'Plays']}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    fill="url(#graphs-hourly-gradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div>
          {renderChartCard(
            'Client Device Mix',
            'Distribution of playback sessions by detected client device category.',
            faCircleNodes,
            <div className="h-[300px] w-full">
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
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    labelStyle={chartTooltipLabelStyle}
                    itemStyle={chartTooltipItemStyle}
                    formatter={(value) => [`${value}%`, 'Share']}
                  />
                  <Legend verticalAlign="bottom" iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
              {!loading && deviceChartData.length === 0 ? (
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
            <div className="h-[300px] w-full">
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
                  <Tooltip
                    contentStyle={chartTooltipStyle}
                    labelStyle={chartTooltipLabelStyle}
                    itemStyle={chartTooltipItemStyle}
                    formatter={(value) => [value, 'Sessions']}
                  />
                  <Legend verticalAlign="bottom" iconType="circle" />
                </PieChart>
              </ResponsiveContainer>
              {!loading && totalPlaybackSessions === 0 ? (
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
