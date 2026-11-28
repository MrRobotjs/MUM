import {formatNextRunTime, formatTaskInterval} from '../lib/scheduledTaskDisplay';
import type {DisplayValues} from '../lib/accountDisplay';
import {useActivityMonitoring} from '../hooks/useActivityMonitoring';
import type {MonitorTask} from '../lib/activityMonitoring';
import {isSocketConnected, providerSocketSubscriptions, scheduledTaskState, socketMonitoringStatus} from '../lib/providerSocketDetails';
import {getServiceBadgeClass, getServiceIcon} from '../config/mediaServiceMetadata';
import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import { useSystemConfig } from '../hooks/useSystemConfig';
import { PageHeader } from '../components';
import { RefreshRunLog } from '../components/settings/RefreshRunLog';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Spinner } from '@/components/ui/spinner'
import {
  faServer,
  faDesktop,
  faShield,
  faClock,
  faCircleInfo,
  faCheck,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

function TaskState({state,label}:{state:'active'|'inactive'|'unavailable';label?:string}) {
  if (state==='unavailable') return <span className="text-xs text-muted-foreground">Unavailable</span>;
  return <span className={`inline-flex items-center gap-1 text-xs ${state==='active'?'text-emerald-600':'text-red-600'}`}><FontAwesomeIcon icon={state==='active'?faCheck:faXmark} aria-hidden="true" />{label && <span className="sr-only">{state==='active'?'Connected':'Disconnected'} </span>} {label??(state==='active'?'Active':'Inactive')}</span>;
}

// Helper function to calculate countdown from next_run_time
const useCountdown = (nextRunTime: string | null, dueLabel = 'Due') => {
  const [countdown, setCountdown] = useState<string>('');

  useEffect(() => {
    if (!nextRunTime) {
      setCountdown('Not scheduled');
      return;
    }

    const calculateCountdown = () => {
      const now = new Date().getTime();
      const target = new Date(nextRunTime).getTime();
      const diff = target - now;

      if (diff <= 0) {
        return dueLabel;
      }

      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    };

    // Initial calculation
    setCountdown(calculateCountdown());

    // Update every second
    const interval = setInterval(() => {
      setCountdown(calculateCountdown());
    }, 1000);

    return () => clearInterval(interval);
  }, [nextRunTime, dueLabel]);

  return countdown;
};

// A shared pair of cells keeps the countdown and the viewer-local calendar time consistent.
// status replaces the countdown while the task is running; dueLabel is shown
// once the time has passed and the task is waiting for its turn.
function NextRunCells({value, display, empty = 'N/A', dueLabel, status}:{value:string|null;display:DisplayValues|undefined;empty?:string;dueLabel?:string;status?:string}) {
  const countdown = useCountdown(value, dueLabel);
  return <><TableCell className={status ? 'text-sm' : 'font-mono text-sm'}>{status ?? (value ? countdown : empty)}</TableCell><TableCell className="text-sm">{value ? formatNextRunTime(value,new Date().toISOString(),display) : empty}</TableCell></>;
}

// Function to get detailed task information
const getTaskDetails = (task: any, formatTimestamp: (value: string) => string) => {
  const details: { label: string; value: string; description?: string }[] = [];

  // Basic info
  details.push({ label: 'Task ID', value: task.id });
  details.push({ label: 'Task Name', value: task.name });
  details.push({ label: 'Type', value: task.type });
  details.push({ label: 'State', value: ({active:'Active',inactive:'Inactive',unavailable:'Unavailable'} as const)[scheduledTaskState(task.state)] });
  details.push({ label: 'Side', value: task.side });
  if(String(task.id).startsWith('provider-sync-')){details.push({label:'Last outcome',value:({NEVER_RUN:'Never run',SUCCEEDED:'Succeeded',WARNINGS:'Succeeded with warnings',FAILED:'Failed',CANCELLED:'Cancelled',INTERRUPTED:'Interrupted'} as Record<string,string>)[task.last_code]??'Unknown'});details.push({label:'Attempts',value:String(task.attempts)});if(task.started_at)details.push({label:'Last started',value:formatTimestamp(task.started_at)});if(task.finished_at)details.push({label:'Last finished',value:formatTimestamp(task.finished_at)});}

  // Execution details
  if (task.next_run_time) {
    details.push({
      label: 'Next Execution',
      value: formatTimestamp(task.next_run_time),
      description: 'The scheduled time for the next task execution'
    });
  }

  if (task.interval_seconds) {
    details.push({
      label: 'Interval',
      value: formatTaskInterval(task.interval_seconds),
      description: 'How often this task runs'
    });
  }

  if (typeof task.misfire_grace_time === 'number') {
    details.push({
      label: 'Misfire Grace',
      value: `${task.misfire_grace_time}s`,
      description: 'How late a run can start before it is skipped'
    });
  }

  if (typeof task.coalesce === 'boolean') {
    details.push({
      label: 'Coalesce',
      value: task.coalesce ? 'Enabled' : 'Disabled',
      description: 'When enabled, missed runs merge into a single execution'
    });
  }

  if (Array.isArray(task.channels) && task.channels.length > 0) {
    details.push({
      label: 'Channels',
      value: task.channels.join(', '),
      description: 'Active real-time subscriptions (<service>.<server_id>.<topic>)'
    });
  }

  if (task.id && task.id.toLowerCase().includes('check_user_expirations')) {
    details.push({
      label: 'Notes',
      value: 'Expiration guardrails',
      description:
        'This task uses a 15s misfire grace window and coalescing to avoid skipping runs when the scheduler is slightly delayed.'
    });
  }

  return details;
};

// Function to get task description based on task type and name
const getTaskDescription = (task: any): string => {
 if(String(task.id).startsWith('provider-sync-'))return "Refreshes this server's list automatically. Configure the interval and startup behavior in that server's settings.";
  // WebSocket tasks
  if (task.type === 'WebSocket') {
    if (task.side === 'Server' && task.name.includes('Plex WebSocket')) {
      return 'Maintains a persistent WebSocket connection to the Plex server for real-time event monitoring. This connection receives instant notifications when users start, pause, resume, or stop streaming content.';
    } else if (task.side === 'Client') {
      const channels: string[] = task.channels || [];
      const hasChannels = channels.length > 0;
      const channelList = hasChannels ? channels.join(', ') : 'No channels';

      return [
        'Unified frontend -> backend WebSocket that multiplexes all real-time streams through a single connection using channel envelopes {channel, event, data}.',
        'Channels follow <service>.<server_id>.<topic> (e.g., plex.5.sessions).',
        hasChannels
          ? `Currently subscribed to ${channels.length} channel${channels.length === 1 ? '' : 's'}: ${channelList}.`
          : 'Currently connected but waiting for subscriptions.'
      ].join(' ');
    }
  }

  // Session Monitoring tasks
  if (task.type === 'Session Monitoring') {
    return 'Periodically polls media servers (Plex, Jellyfin, Emby) to retrieve active streaming sessions. Updates user activity, tracks watch history, and broadcasts streaming updates to connected WebSocket clients.';
  }

  // User Management tasks
  if (task.type === 'User Management') {
    if (task.name.toLowerCase().includes('expir')) {
      return 'Monitors user accounts for expiration dates and automatically deactivates users whose access has expired. This ensures that temporary access grants are properly enforced.';
    }
  }

  // Synchronization tasks
  if (task.type === 'Synchronization') {
    return 'Synchronizes data between MUM and external services. This includes syncing user libraries, media metadata, and server configurations.';
  }

  // Monitoring tasks (generic)
  if (task.type === 'Monitoring') {
    return 'Background monitoring task that checks system health, service connectivity, or performs periodic maintenance operations.';
  }

  // Default description
  return 'Scheduled background task that runs automatically at specified intervals to maintain system functionality and data integrity.';
};

interface ScheduledTaskRowProps {
  task: any;
  onClick: (task: any) => void;
  display: DisplayValues | undefined;
}

const ScheduledTaskRow = ({ task, onClick, display }: ScheduledTaskRowProps) => {
  const displayName = useMemo(() => {
    // Strip any suffix like " (...)" that we used to append for channels
    const name: string = task.name || '';
    return name.replace(/\s*\(.*\)$/, '');
  }, [task.name]);
  const running = task.state === 'running' || task.state === 'recovering';

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => onClick(task)}
    >
      <TableCell className="font-medium"><div className="flex flex-wrap items-center gap-2"><span>{displayName}</span><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${getServiceBadgeClass(task.provider)}`}>{getServiceIcon(task.provider, 'size-3')}<span className="sr-only">{task.provider}: </span>{task.server_name}</span></div></TableCell>
      <TableCell>{running ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><Spinner className="size-3" />{task.state === 'running' ? 'Running' : 'Recovering'}</span> : <TaskState state={scheduledTaskState(task.state)} />}</TableCell>
      <TableCell>{task.interval_seconds ? formatTaskInterval(task.interval_seconds) : '—'}</TableCell>
      {/* Server refreshes run one at a time, so a due task can wait for another server's refresh to finish. */}
      <NextRunCells value={task.type === 'WebSocket' ? null : task.next_run_time} display={display} empty={task.type === 'WebSocket' ? 'N/A' : 'Not scheduled'}
        dueLabel="Waiting to start" status={task.state === 'running' ? 'Running now' : task.state === 'recovering' ? 'Finishing an earlier run' : undefined} />
    </TableRow>
  );
};

export const AdminSettingsInfoPage = () => {
  const activity = useActivityMonitoring();
  const { formatTimestamp, current: displaySettings } = useAccountDisplay();
  const { actor:taskActor,tasks,loading:tasksLoading,error:tasksError,runtimeAvailable,checkpointError,refresh:refreshTasks } = useScheduledTasks();
  const maintenanceState = tasksError || tasksLoading ? 'unavailable' : runtimeAvailable ? 'active' : 'inactive';
  const { config, loading: configLoading, error: configError } = useSystemConfig();
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [socketSelection, setSocketSelection] = useState<{id:string;actor:string;token:string}|null>(null);
  const socketTask:MonitorTask|undefined = !activity.error && socketSelection && socketSelection.actor === activity.actor && socketSelection.token === activity.sessionToken ? activity.snapshot?.tasks.find(task=>task.server_id===socketSelection?.id) : undefined;
  const taskModalEpoch=useRef(0);
  const currentTask=selectedTask?.actor_uuid===taskActor?tasks.find(t=>t.server_id===selectedTask.server_id && t.scope===selectedTask.scope):undefined;
  const liveSelectedTask=currentTask ? {...currentTask, name:selectedTask.name, id:selectedTask.id} : undefined;

  useEffect(()=>{taskModalEpoch.current++;setSelectedTask(null);setIsModalOpen(false)},[taskActor]);
  useEffect(()=>{setSocketSelection(null)},[activity.actor,activity.sessionToken]);
  const handleTaskClick = (task: any) => {
    taskModalEpoch.current++;
    setSelectedTask(task);
    setIsModalOpen(true);
  };
  // The Activity menu links here with ?task=…: open that task once it loads.
  const { task: linkedTask } = useSearch({ from: '/admin/settings/info' });
  const navigate = useNavigate();
  useEffect(() => {
    if (!linkedTask || tasksLoading) return;
    const task = tasks.find(t => t.id === linkedTask);
    if (task) handleTaskClick(task);
    void navigate({ to: '/admin/settings/info', search: {}, replace: true });
  }, [linkedTask, tasksLoading]);

  const handleCloseModal = () => {
    setIsModalOpen(false);
    const epoch=taskModalEpoch.current;
    setTimeout(() => {if(taskModalEpoch.current===epoch)setSelectedTask(null)}, 200); // Clear after animation
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Info"
        description="Runtime information and background tasks"
      />

      {/* MUM Configuration Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faShield} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">MUM Configuration</CardTitle>
              <CardDescription>System information and configuration details</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {configLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4 text-muted-foreground" />
              Loading configuration...
            </div>
          ) : !config ? (
            <div className="text-sm text-muted-foreground">{configError ? 'Could not load runtime information. Refresh the page.' : 'Configuration not available'}</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Build Status</span>
                <span className="font-mono">{config.build_modified === null ? 'Not recorded' : config.build_modified ? 'Modified workspace build' : 'Clean workspace build'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Build Revision</span>
                <span className="font-mono">{config.build_revision ?? 'Not recorded'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Database Location</span>
                <span className="font-mono break-all">{config.database_file ?? 'Owner only'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Database Type</span>
                <span className="font-mono">{config.database_type ?? 'Unknown'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Log Storage</span>
                <span className="font-mono break-all">{config.log_storage}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Application Data Directory</span>
                <span className="font-mono break-all">{config.data_directory ?? 'Owner only'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Platform</span>
                <span className="font-mono">{config.platform}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">System Timezone</span>
                <span className="font-mono">{config.timezone} (UTC offset {config.timezone_offset_seconds / 3600}h)</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Go Version</span>
                <span className="font-mono">{config.go_version}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Database Version</span>
                <span className="font-mono">{config.database_version}</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scheduled Tasks Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faClock} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Scheduled Tasks</CardTitle>
              <CardDescription>{checkpointError?'A scheduler checkpoint failed. Refresh and inspect task status.':runtimeAvailable?'Synchronization and maintenance tasks. Some on-demand jobs are not shown.':'Scheduler is stopped; saved configuration applies when it starts.'}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tasksError && <div className="mb-4 text-sm text-muted-foreground">Synchronization tasks are unavailable. <Button variant="outline" onClick={()=>void refreshTasks().catch(()=>{})}>Refresh tasks</Button></div>}
          {tasksLoading && <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4 text-muted-foreground" />Loading synchronization tasks...</div>}
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Interval</TableHead>
                  <TableHead>Next Run In</TableHead>
                  <TableHead>Next Run Time</TableHead>
                </TableRow>
              </TableHeader>
                <TableBody>
                  {activity.error ? <TableRow><TableCell colSpan={5}>Activity monitoring status is unavailable. <Button variant="outline" onClick={() => void activity.refresh().catch(() => {})}>Refresh monitoring</Button></TableCell></TableRow> : activity.loading ? <TableRow><TableCell colSpan={5}>Loading activity monitoring...</TableCell></TableRow> : activity.snapshot?.tasks.slice().sort((a, b) => a.provider.localeCompare(b.provider) || a.server_name.localeCompare(b.server_name)).map(task => <TableRow key={`activity-${task.server_id}`} className="cursor-pointer hover:bg-muted/50" onClick={()=>{if(activity.actor&&activity.sessionToken)setSocketSelection({id:task.server_id,actor:activity.actor,token:activity.sessionToken})}}>
                    <TableCell><div className="flex flex-wrap items-center gap-2"><button type="button" className="text-left hover:underline focus-visible:ring-2 ring-sidebar-ring" onClick={event=>{event.stopPropagation();if(activity.actor&&activity.sessionToken)setSocketSelection({id:task.server_id,actor:activity.actor,token:activity.sessionToken})}}>Check for active sessions</button><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${getServiceBadgeClass(task.provider)}`}>{getServiceIcon(task.provider, 'size-3')}<span className="sr-only">{task.provider}: </span>{task.server_name}</span></div></TableCell>
                    <TableCell><TaskState state={isSocketConnected(task)?'active':'inactive'} label="WebSocket" />{socketMonitoringStatus(task)==='HTTP fallback' && <div className="text-xs text-muted-foreground">HTTP fallback</div>}</TableCell>
                    <TableCell>{task.socket_enabled ? 'N/A' : task.state==='scheduled'||task.state==='running' ? `${formatTaskInterval(task.interval_seconds)} (HTTP)` : 'N/A'}</TableCell><NextRunCells value={!task.socket_enabled && (task.state==='scheduled'||task.state==='running') ? task.next_run_at : null} display={displaySettings?.display} />
                  </TableRow>)}
                  <TableRow><TableCell>Check local account expiry</TableCell><TableCell><TaskState state={maintenanceState}/></TableCell><TableCell>Every second</TableCell><TableCell>Within a second</TableCell><TableCell>Within a second</TableCell></TableRow>
                  <TableRow><TableCell>Check service account expiry</TableCell><TableCell><TaskState state={maintenanceState}/></TableCell><TableCell>Every second</TableCell><TableCell>Within a second</TableCell><TableCell>Within a second</TableCell></TableRow>
                  <TableRow><TableCell>Check server health</TableCell><TableCell><TaskState state={maintenanceState}/></TableCell><TableCell>15s sweep</TableCell><TableCell>Not recorded</TableCell><TableCell>Not recorded</TableCell></TableRow>
                  {tasks.map(task => <ScheduledTaskRow key={task.id} task={task} onClick={handleTaskClick} display={displaySettings?.display} />)}
                </TableBody>
              </Table>
            </div>
        </CardContent>
      </Card>

      <ResponsiveDialog open={socketSelection!==null} onOpenChange={open=>{if(!open)setSocketSelection(null)}} title="WebSocket details" description="Provider connection and session notifications" footer={<Button variant="outline" onClick={()=>setSocketSelection(null)}>Close</Button>}>
        {socketTask ? <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
            <p className="font-semibold">{socketTask.server_name} ({socketTask.provider})</p>
            <div className="text-sm">Status: <TaskState state={isSocketConnected(socketTask)?'active':'inactive'} label="WebSocket" />{socketMonitoringStatus(socketTask)==='HTTP fallback' && <span className="text-muted-foreground"> · HTTP fallback</span>}</div>
            <p className="text-sm text-muted-foreground">Socket: {socketTask.socket_state}{socketTask.socket_error ? ` (${socketTask.socket_error})` : ''}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
            <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Provider subscription</h3>
            <p className="text-sm">{providerSocketSubscriptions(socketTask).subscription}</p>
            <p className="text-xs text-muted-foreground">MUM accepts these notification types; this is not a list of messages currently being received.</p>
            <div className="flex flex-wrap gap-2">{providerSocketSubscriptions(socketTask).events.map(event=><span key={event} className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs text-primary">{event}</span>)}</div>
          </div>
        </div> : <p className="text-sm text-muted-foreground">Current socket status is unavailable. Refresh monitoring to try again.</p>}
      </ResponsiveDialog>

      {/* Task Details Modal */}
      <ResponsiveDialog size="md"
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        title={
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faCircleInfo} className="size-5 text-primary" />
            Task Details
          </div>
        }
        description="Detailed information about this scheduled task"
        footer={
          <Button variant="outline" onClick={handleCloseModal}>
            Close
          </Button>
        }
      >
        {selectedTask && selectedTask.actor_uuid===taskActor && (
          <div className="space-y-6">
            {/* Task Description */}
            <div className="rounded-lg border bg-muted/30 p-4">
              <h3 className="mb-2 font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                Description
              </h3>
              <p className="text-sm leading-relaxed">
                {getTaskDescription(selectedTask)}
              </p>
            </div>

            {/* Task Details Grid */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                Task Information
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {getTaskDetails(liveSelectedTask??selectedTask, formatTimestamp).map((detail, index) => (
                  <div
                    key={index}
                    className="rounded-lg border bg-card p-3 space-y-1"
                  >
                    <div className="text-xs font-medium text-muted-foreground">
                      {detail.label}
                    </div>
                    <div className="font-mono text-sm break-all">
                      {detail.value}
                    </div>
                    {detail.description && (
                      <div className="text-xs text-muted-foreground italic">
                        {detail.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Status Indicator */}
            <div className="rounded-lg border bg-muted/30 p-4">
              <h3 className="mb-3 font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                Current Status
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">State:</span>
                  <TaskState state={tasksError || !liveSelectedTask ? 'unavailable' : scheduledTaskState(liveSelectedTask.state)} />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Side:</span>
                  {selectedTask.side === 'Server' ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-100 px-2.5 py-1 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
                      <FontAwesomeIcon icon={faServer} className="text-[10px]" /> Server
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
                      <FontAwesomeIcon icon={faDesktop} className="text-[10px]" /> Client
                    </span>
                  )}
                </div>
              </div>
            </div>

            {String(selectedTask.id).startsWith('provider-sync-') && <RefreshRunLog server={selectedTask.server_id} scope={selectedTask.scope} runningSince={(liveSelectedTask??selectedTask).state === 'running' ? (liveSelectedTask??selectedTask).started_at : null} progress={(liveSelectedTask??selectedTask).progress} />}
          </div>
        )}
      </ResponsiveDialog>
    </div>
  );
};

export default AdminSettingsInfoPage;
