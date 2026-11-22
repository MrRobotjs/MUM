import {useEffect, useRef, useState} from 'react';
import {useActivityMonitoring} from '../../hooks/useActivityMonitoring';
import {configureActivityMonitoringInterval, type MonitorSnapshot, type MonitorTask} from '../../lib/activityMonitoring';
import {getAccessToken} from '../../store/authStore';
import {useAccountDisplay} from '../../hooks/useAccountDisplay';
import {Button} from '../ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '../ui/card';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {ResponsiveDialog} from '../ui/responsive-dialog';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '../ui/table';

function MonitorControls({base, task, onSaved}: {base: MonitorSnapshot; task: MonitorTask; onSaved: () => Promise<void>}) {
  const [interval, setInterval] = useState(task.interval_seconds);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const active = useRef(true), admitted = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  const save = async () => {
    if (admitted.current) return;
    admitted.current = true; setPending(true); setError(null);
    const token = getAccessToken(); controller.current = new AbortController();
    try {
      await configureActivityMonitoringInterval(base, task, interval, controller.current.signal);
      if (active.current && token === getAccessToken()) await onSaved();
    } catch {
      if (active.current && token === getAccessToken()) setError('Change could not be confirmed. Close, refresh and inspect monitoring before another attempt.');
    } finally { admitted.current = false; if (active.current) setPending(false); }
  };
  return <div className="space-y-4">
    <Label htmlFor="activity-monitor-interval">HTTP refresh interval in seconds (15–3600)</Label>
    <Input id="activity-monitor-interval" type="number" min={15} max={3600} value={interval} disabled={pending} onChange={event => setInterval(Number(event.target.value))}/>
    <p className="text-sm text-muted-foreground">WebSocket notifications trigger session refreshes. This interval controls retries after failed reads and polling when a provider socket is disabled.</p>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <Button type="button" disabled={pending || Boolean(error) || !Number.isSafeInteger(interval) || interval < 15 || interval > 3600} onClick={() => void save()}>{pending ? 'Saving...' : 'Save monitoring'}</Button>
  </div>;
}

export function ActivityMonitoringSettings() {
  const {actor, snapshot, loading, error, refresh, sessionToken} = useActivityMonitoring();
  const {formatTimestamp} = useAccountDisplay();
  const [selected, setSelected] = useState<{base: MonitorSnapshot; task: MonitorTask} | null>(null);
  useEffect(() => { setSelected(null); }, [actor, sessionToken]);
  const visible = selected && snapshot && selected.base.actor_uuid === actor && snapshot.configuration_available;
  return <Card>
    <CardHeader><CardTitle className="mb-1 text-xl font-semibold">Activity monitoring</CardTitle><CardDescription>Configure Jellyfin, Emby and Plex observations and history.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {error ? <div className="text-sm text-muted-foreground">Monitoring settings are unavailable. <Button variant="outline" onClick={() => void refresh().catch(() => {})}>Refresh monitoring</Button></div> : loading ? <p className="text-sm text-muted-foreground">Loading monitoring settings...</p> : !snapshot ? <p className="text-sm text-muted-foreground">Administrator access is required.</p> : <>
        <p className="text-sm text-muted-foreground">{snapshot.checkpoint_error ? 'A scheduler checkpoint failed. Refresh and inspect monitoring status.' : snapshot.runtime_available ? 'WebSocket notifications trigger activity updates. Only the owner can change monitoring.' : 'Scheduler is stopped; saved settings apply when it starts.'}</p>
        {snapshot.tasks.length === 0 ? <p className="text-sm text-muted-foreground">No supported Jellyfin, Emby or Plex servers.</p> : <div className="rounded-md border"><Table><TableHeader><TableRow><TableHead>Server</TableHead><TableHead>State</TableHead><TableHead>Last result</TableHead><TableHead>Next observation</TableHead><TableHead>Actions</TableHead></TableRow></TableHeader><TableBody>
          {snapshot.tasks.map(task => <TableRow key={task.server_id}><TableCell>{task.server_name} ({task.provider})</TableCell><TableCell>{task.state} | Socket: {task.socket_state}{task.socket_error?` (${task.socket_error})`:""}</TableCell><TableCell>{task.last_code}</TableCell><TableCell>{task.next_run_at ? formatTimestamp(task.next_run_at) : 'Not scheduled'}</TableCell><TableCell>{snapshot.configuration_available ? <Button variant="outline" onClick={() => setSelected({base: snapshot, task})}>Configure</Button> : 'Owner only'}</TableCell></TableRow>)}
        </TableBody></Table></div>}
      </>}
      <ResponsiveDialog open={Boolean(visible)} onOpenChange={open => {if (!open) setSelected(null);}} title={selected ? `Monitor ${selected.task.server_name}` : 'Activity monitoring'} description="Settings use the server configuration captured when this dialog opened.">
        {visible && <MonitorControls key={`${selected.base.actor_uuid}-${selected.task.server_id}-${selected.task.revision}`} base={selected.base} task={selected.task} onSaved={async () => {setSelected(null); await refresh();}}/>}
      </ResponsiveDialog>
    </CardContent>
  </Card>;
}
