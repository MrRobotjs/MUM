import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { faChartColumn } from '@fortawesome/free-solid-svg-icons';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useAdminApi } from '../../hooks/useAdminApi';
import { ChartCard, GRAPH_REFRESH_MS, renderGraphsTooltipCard } from '../../pages/GraphsPage';
import { playHistoryColors, playHistoryDuration, playHistoryLabels } from '../../lib/playHistoryGraph';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type Row = { label: string; plays: Record<string, number>; seconds: Record<string, number> };
type Datasets = { hourly_media: Row[]; daily_modes: Row[]; users_media: Row[]; users_modes: Row[]; platforms_media: Row[]; platforms_modes: Row[]; concurrent_modes: Row[]; source_resolution: Row[]; stream_resolution: Row[]; source_resolution_missing: number; stream_resolution_missing: number };
type Response = { data: Datasets; meta?: { unavailable?: boolean; note?: string } };
const media = Object.entries(playHistoryLabels).map(([key, label]) => ({ key, label, color: playHistoryColors[key as keyof typeof playHistoryColors] }));
const modes = [{key:'direct_play',label:'Direct Play',color:'#10b981'}, {key:'direct_stream',label:'Direct Stream',color:'#3b82f6'}, {key:'transcode',label:'Transcode',color:'#ef4444'}, {key:'unknown',label:'Unknown',color:'#9ca3af'}];

export function PlaybackBreakdowns({ days, serverId, tab, separated }: { days: number; serverId: string; tab: 'media' | 'stream'; separated: boolean }) {
  const { timeZone, formatHour } = useAccountDisplay();
  const [metric, setMetric] = useState<'plays' | 'seconds'>('plays');
  const [user, setUser] = useState('all');
  const [hovered, setHovered] = useState<{graph: string; series: string} | null>(null);
  const path = `/graphs/breakdowns?days=${days}&server_id=${encodeURIComponent(serverId || 'all')}&tz=${encodeURIComponent(timeZone ?? '')}&user=${encodeURIComponent(user)}&rank=${metric}`;
  const { data, loading, error } = useAdminApi<Response>(path, Boolean(timeZone), GRAPH_REFRESH_MS);
  const peoplePath = `/graphs/play-history?days=${days}&server_id=${encodeURIComponent(serverId || 'all')}&media=all&user=all&tz=${encodeURIComponent(timeZone ?? '')}`;
  const { data: people } = useAdminApi<{data:{users:{uuid:string;name:string}[]}}>(peoplePath, Boolean(timeZone), GRAPH_REFRESH_MS);
  useEffect(() => { if (user !== 'all' && people && !people.data.users.some(person => person.uuid === user)) setUser('all'); }, [people, user]);
  const graphs: {key: Exclude<keyof Datasets, 'source_resolution_missing' | 'stream_resolution_missing'>; title: string; concurrent?: boolean; resolution?: boolean}[] = tab === 'media'
    ? [{key:'hourly_media',title:'Plays by Hour and Media Type'}, {key:'platforms_media',title:'Top Platforms by Media Type'}, {key:'users_media',title:'Top Users by Media Type'}]
    : [{key:'daily_modes',title:'Daily Plays by Stream Type'}, {key:'concurrent_modes',title:'Daily Peak Concurrent Streams',concurrent:true}, {key:'source_resolution',title:'Plays by Source Resolution',resolution:true}, {key:'stream_resolution',title:'Plays by Stream Resolution',resolution:true}, {key:'platforms_modes',title:'Platforms by Stream Type'}, {key:'users_modes',title:'Users by Stream Type'}];
  const series = tab === 'media' ? media : modes;
  return <div className="space-y-6">
    <div className="flex flex-wrap items-center gap-3">
      <Select value={metric} onValueChange={v => setMetric(v as 'plays' | 'seconds')}><SelectTrigger className="w-auto" aria-label="Breakdown metric"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="plays">Play Count</SelectItem><SelectItem value="seconds">Watch Time</SelectItem></SelectContent></Select>
      <Select value={user} onValueChange={setUser}><SelectTrigger className="w-auto" aria-label="Breakdown user"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Users</SelectItem>{(people?.data?.users ?? []).map(person => <SelectItem key={person.uuid} value={person.uuid}>{person.name}</SelectItem>)}</SelectContent></Select>
      <span className="text-xs text-muted-foreground">Recorded MUM activity only; imported history is excluded.{separated ? ' These breakdowns combine all selected servers.' : ''}</span>
    </div>
    {graphs.map(graph => {
      const selectedMetric = graph.concurrent ? 'plays' : metric;
      const rows = data?.data?.[graph.key] ?? [];
      const chartSeries = graph.resolution ? [{key:'total',label:'Plays',color:'#3b82f6'}] : series;
      const displayedSeries = graph.concurrent ? [...chartSeries, {key:'total',label:'Total',color:'#a855f7'}] : chartSeries;
      const activeSeries = hovered?.graph === graph.key ? hovered.series : null;
      const points = rows.map(row => ({ ...row[selectedMetric], label: graph.key === 'hourly_media' ? formatHour(Number.parseInt(row.label, 10)) : row.label }));
      const empty = !points.some(row => chartSeries.some(s => Number(row[s.key as keyof typeof row] || 0) > 0));
      const missing = graph.key === 'source_resolution' ? data?.data?.source_resolution_missing : data?.data?.stream_resolution_missing;
      return <ChartCard key={graph.key} title={graph.title} description={graph.concurrent ? 'Highest observed simultaneous streams per day; partial observations can underestimate peaks.' : graph.resolution ? `Only plays with a recorded resolution are included; ${missing ?? 0} plays have no recorded value.` : 'Recorded playback in the selected period; watch time is estimated from observations.'} icon={faChartColumn} loading={loading}>
        <div className="relative h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%"><BarChart data={points} margin={{top:10,right:6,left:4,bottom:0}} onMouseLeave={() => setHovered(null)}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{fill:'var(--muted-foreground)',fontSize:11}} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{fill:'var(--muted-foreground)',fontSize:11}} tickFormatter={v => selectedMetric === 'seconds' ? playHistoryDuration(Number(v)) : String(v)} />
            <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={({active, payload, label}) => active && payload?.length ? renderGraphsTooltipCard(String(label ?? ''), payload.map(entry => ({ key: String(entry.dataKey), label: String(entry.name), value: selectedMetric === 'seconds' ? playHistoryDuration(Number(entry.value ?? 0)) : String(entry.value ?? 0), dotColor: String(entry.color ?? '') }))) : null} />
            {displayedSeries.map(s => <Bar key={s.key} dataKey={s.key} name={s.label} stackId={graph.concurrent ? undefined : 'plays'} fill={s.color} fillOpacity={activeSeries && activeSeries !== s.key ? 0.35 : 1} isAnimationActive={false} onMouseEnter={() => setHovered({graph: graph.key, series: s.key})} onMouseLeave={() => setHovered(null)} />)}
          </BarChart></ResponsiveContainer>
          {!loading && (error || data?.meta?.unavailable || empty) && <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{error || (data?.meta?.unavailable ? 'This data is unavailable.' : graph.resolution ? 'No resolution recorded for this period.' : 'No recorded activity for this period.')}</div>}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-4 text-xs" onMouseLeave={() => setHovered(null)}>
          {displayedSeries.map(s => <span key={s.key} className="inline-flex cursor-default items-center gap-1.5 uppercase tracking-wide transition-opacity" style={{opacity: activeSeries && activeSeries !== s.key ? 0.35 : 1}} onMouseEnter={() => setHovered({graph: graph.key, series: s.key})}>
            <span className="h-2.5 w-2.5 rounded-full" style={{backgroundColor: s.color}} />{s.label}
          </span>)}
        </div>
      </ChartCard>;
    })}
  </div>;
}
