import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { faChartColumn } from '@fortawesome/free-solid-svg-icons';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdminApi } from '../../hooks/useAdminApi';
import { ChartCard, renderGraphsTooltipCard } from '../../pages/GraphsPage';
import {
  playHistoryAxisLabel, playHistoryColors, playHistoryDuration, playHistoryLabels, playHistoryMedia, playHistoryTitle, readPlayHistory,
  type PlayHistory, type PlayHistoryMedia,
} from '../../lib/playHistoryGraph';

// Play history: watched time per period, stacked by media type, with media
// and person filters and the page's period and server. Hovering a
// type's part of a bar dims the other types in every bar and in the legend;
// the tooltip gives the period's time per type and its total.

const mediaChoices: PlayHistoryMedia[] = ['movies', 'tv', 'music', 'photos'];

export function PlayHistoryChart({ days, serverId }: { days: number; serverId: string }) {
  const [media, setMedia] = useState<'all' | PlayHistoryMedia>('all');
  const [user, setUser] = useState('all');
  const [hovered, setHovered] = useState<PlayHistoryMedia | null>(null);
  const path = `/graphs/play-history?days=${days}&server_id=${encodeURIComponent(serverId || 'all')}&media=${media}&user=${encodeURIComponent(user)}`;
  const { data: raw, loading, error } = useAdminApi<unknown>(path);
  const { data, invalid } = useMemo(() => {
    if (!raw) return { data: null as PlayHistory | null, invalid: false };
    try {
      return { data: readPlayHistory(raw, days), invalid: false };
    } catch {
      return { data: null, invalid: true };
    }
  }, [raw, days]);

  // A person who no longer appears in the period goes back to everyone.
  useEffect(() => {
    if (user !== 'all' && data && !data.users.some(u => u.uuid === user)) setUser('all');
  }, [data, user]);

  // The types shown: the chosen one, or every type that has time (Movies, TV,
  // Music and Photos always, Other only when something else was played).
  const shown = useMemo(() => {
    if (media !== 'all') return [media];
    return playHistoryMedia.filter(m => m !== 'other' || (data?.totals.other ?? 0) > 0);
  }, [media, data]);
  const points = useMemo(() => (data?.buckets ?? []).map(b => ({ ...b.seconds, start: b.start, end: b.end })), [data]);
  const empty = data !== null && shown.every(m => data.totals[m] === 0);
  const fill = (m: PlayHistoryMedia) => (hovered && hovered !== m ? `${playHistoryColors[m]}59` : playHistoryColors[m]);

  const tooltip = ({ active, payload }: { active?: boolean; payload?: ReadonlyArray<any> }) => {
    if (!active || !payload?.length || !data) return null;
    const point = payload[0].payload as { start: string; end: string } & Record<PlayHistoryMedia, number>;
    const rows: { key: string; label: string; value: string; dotColor: string }[] = shown.filter(m => point[m] > 0).map(m => ({ key: m, label: playHistoryLabels[m], value: playHistoryDuration(point[m]), dotColor: playHistoryColors[m] }));
    const total = shown.reduce((sum, m) => sum + point[m], 0);
    if (rows.length !== 1) rows.push({ key: 'total', label: 'Total', value: playHistoryDuration(total), dotColor: 'var(--muted-foreground)' });
    return renderGraphsTooltipCard(playHistoryTitle(data.bucket, point), rows);
  };

  return (
    <ChartCard
      title="Play History"
      description="Watched time per period by media type, from MUM's recorded plays."
      icon={faChartColumn}
      loading={loading}
      actions={<>
        <Select value={media} onValueChange={value => setMedia(value as typeof media)}>
          <SelectTrigger className="w-auto" aria-label="Media"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Media</SelectItem>
            {mediaChoices.map(m => <SelectItem key={m} value={m}>{playHistoryLabels[m]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={user} onValueChange={setUser}>
          <SelectTrigger className="w-auto" aria-label="Users"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Users</SelectItem>
            {(data?.users ?? []).map(u => <SelectItem key={u.uuid} value={u.uuid}>{u.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </>}
    >
      <div className="relative h-[300px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 10, right: 6, left: 4, bottom: 0 }} onMouseLeave={() => setHovered(null)}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.35} />
            <XAxis dataKey="start" tickLine={false} axisLine={false} tickMargin={8} minTickGap={12} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickFormatter={(start: string) => { const b = data?.buckets.find(x => x.start === start); return b && data ? playHistoryAxisLabel(data.bucket, b) : start; }} />
            <YAxis tickLine={false} axisLine={false} tickMargin={6} width={48} tickCount={5} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
              tickFormatter={(v: number) => playHistoryDuration(Number(v))} />
            <Tooltip content={tooltip} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
            {shown.map(m => <Bar key={m} dataKey={m} name={playHistoryLabels[m]} stackId="play-history" fill={fill(m)} isAnimationActive={false}
              onMouseEnter={() => setHovered(m)} onMouseLeave={() => setHovered(null)} />)}
          </BarChart>
        </ResponsiveContainer>
        {error || invalid ? <div className="absolute inset-0 flex items-center justify-center text-sm text-destructive">{error ?? 'Play history could not be read.'}</div>
          : empty ? <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No recorded plays in this period.</div> : null}
      </div>
      {data && <div className="mt-3 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex flex-wrap items-center gap-4" onMouseLeave={() => setHovered(null)}>
          {shown.map(m => <span key={m} className="inline-flex cursor-default items-center gap-1.5 uppercase tracking-wide transition-opacity"
            style={{ opacity: hovered && hovered !== m ? 0.35 : 1 }} onMouseEnter={() => setHovered(m)}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: playHistoryColors[m] }} />{playHistoryLabels[m]}
          </span>)}
        </div>
        <span className="text-muted-foreground">
          Totals: {shown.map(m => `${playHistoryLabels[m]} — ${playHistoryDuration(data.totals[m])}`).join(' | ')}
        </span>
      </div>}
    </ChartCard>
  );
}
