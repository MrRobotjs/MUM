import { useState, useEffect, useMemo } from 'react';
import { useAdvancedSettings, type AdvancedSettings } from '../hooks/useSettings';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
import { useSystemConfig } from '../hooks/useSystemConfig';
import { PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
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
import {
  faCircle,
  faServer,
  faDesktop,
  faTriangleExclamation,
  faShieldHalved,
  faShield,
  faClock,
  faCircleInfo,
} from '@fortawesome/free-solid-svg-icons';

// Helper function to calculate countdown from next_run_time
const useCountdown = (nextRunTime: string | null) => {
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
        return 'Running now...';
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
  }, [nextRunTime]);

  return countdown;
};

// Function to get detailed task information
const getTaskDetails = (task: any) => {
  const details: { label: string; value: string; description?: string }[] = [];

  // Basic info
  details.push({ label: 'Task ID', value: task.id });
  details.push({ label: 'Task Name', value: task.name });
  details.push({ label: 'Type', value: task.type });
  details.push({ label: 'State', value: task.state });
  details.push({ label: 'Side', value: task.side });

  // Execution details
  if (task.next_run_time) {
    const nextRun = new Date(task.next_run_time);
    details.push({
      label: 'Next Execution',
      value: nextRun.toLocaleString(),
      description: 'The scheduled time for the next task execution'
    });
  }

  if (task.interval_seconds) {
    const hours = Math.floor(task.interval_seconds / 3600);
    const minutes = Math.floor((task.interval_seconds % 3600) / 60);
    const seconds = task.interval_seconds % 60;
    let intervalStr = '';
    if (hours > 0) intervalStr += `${hours}h `;
    if (minutes > 0) intervalStr += `${minutes}m `;
    if (seconds > 0) intervalStr += `${seconds}s`;
    details.push({
      label: 'Interval',
      value: intervalStr.trim(),
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
}

const ScheduledTaskRow = ({ task, onClick }: ScheduledTaskRowProps) => {
  const countdown = useCountdown(task.next_run_time);
  const displayName = useMemo(() => {
    // Strip any suffix like " (...)" that we used to append for channels
    const name: string = task.name || '';
    return name.replace(/\s*\(.*\)$/, '');
  }, [task.name]);

  // Determine badge color based on state
  const getStateBadge = () => {
    if (task.type === 'WebSocket') {
      if (task.state === 'Connected') {
        return (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
            <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Connected
          </span>
        );
      } else {
        return (
          <span className="inline-flex items-center gap-1 text-xs text-red-600">
            <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Disconnected
          </span>
        );
      }
    } else {
      return (
        <span className="inline-flex items-center gap-1 text-xs text-blue-600">
          <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Active
        </span>
      );
    }
  };

  const getSideBadge = () => {
    if (task.side === 'Server') {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
          <FontAwesomeIcon icon={faServer} className="text-[10px]" /> Server
        </span>
      );
    } else {
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-400">
          <FontAwesomeIcon icon={faDesktop} className="text-[10px]" /> Client
        </span>
      );
    }
  };

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => onClick(task)}
    >
      <TableCell className="font-medium">{displayName}</TableCell>
      <TableCell>{getStateBadge()}</TableCell>
      <TableCell>{getSideBadge()}</TableCell>
      <TableCell>{task.type}</TableCell>
      <TableCell>
        {Array.isArray(task.channels) && task.channels.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {task.channels.map((channel: string) => (
              <span
                key={channel}
                className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
              >
                {channel}
              </span>
            ))}
          </div>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="font-mono text-sm">
        {task.type === 'WebSocket' ? 'N/A' : countdown}
      </TableCell>
    </TableRow>
  );
};

const buildAdvancedFormValues = (values: AdvancedSettings | null): AdvancedSettings => ({
  api_timeout_seconds: 3,
  ...(values ?? {}),
});

type AdvancedSettingsFormProps = {
  initialValues: AdvancedSettings;
  refresh: () => Promise<unknown>;
};

const AdvancedSettingsForm = ({ initialValues, refresh }: AdvancedSettingsFormProps) => {
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<AdvancedSettings>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const handleChange = (field: keyof AdvancedSettings, value: number) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await requestJson('/admin/api/v2/settings/advanced', {
        method: 'PATCH',
        body: JSON.stringify(formValues),
      });
      success('Advanced settings saved successfully');
      setHasChanges(false);
      await refresh();
    } catch (err) {
      showError(`Failed to save settings: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setFormValues(initialValues);
    setHasChanges(false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faShield} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">API Requests</CardTitle>
              <CardDescription>Configure timeout for external service connections</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="api_timeout_seconds">
            API Timeout (seconds) <span className="text-destructive">*</span>
          </Label>
          <Input
            id="api_timeout_seconds"
            type="number"
            value={formValues.api_timeout_seconds}
            onChange={(e) => handleChange('api_timeout_seconds', Number(e.target.value))}
            required
            min="3"
            max="30"
          />
          <p className="text-xs text-muted-foreground">
            Timeout for API requests to external services like Plex, Jellyfin, etc. (3-30 seconds, default: 3)
          </p>
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={handleReset}
          disabled={!hasChanges || submitting}
        >
          Reset
        </Button>
        <Button type="submit" variant="default" disabled={!hasChanges || submitting}>
          {submitting ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </form>
  );
};

export const AdminSettingsAdvancedPage = () => {
  const { settings, loading, error, refresh } = useAdvancedSettings();
  const { tasks, loading: tasksLoading } = useScheduledTasks();
  const { config, loading: configLoading } = useSystemConfig();
  const [selectedTask, setSelectedTask] = useState<any | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleTaskClick = (task: any) => {
    setSelectedTask(task);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setTimeout(() => setSelectedTask(null), 200); // Clear after animation
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Advanced Settings"
        description="Configure security and session settings"
      />

      {error && (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faTriangleExclamation} className="h-4 w-4" />
          <AlertTitle>Failed to load advanced settings</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="default">
        <FontAwesomeIcon icon={faShieldHalved} className="h-4 w-4" />
        <AlertTitle>Performance & Monitoring</AlertTitle>
        <AlertDescription>
          Configure timeouts and monitoring intervals for optimal performance. Changes take effect immediately.
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading advanced settings...
        </div>
      ) : (
        !error && (
          <AdvancedSettingsForm
            key={settings ? JSON.stringify(settings) : 'empty'}
            initialValues={buildAdvancedFormValues(settings)}
            refresh={refresh}
          />
        )
      )}

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
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              Loading configuration...
            </div>
          ) : !config ? (
            <div className="text-sm text-muted-foreground">Configuration not available</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Git Branch</span>
                <span className="font-mono">{config.git_branch}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Git Commit Hash</span>
                <span className="font-mono">{config.git_commit}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Database File</span>
                <span className="font-mono break-all">{config.database_file}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Log Directory</span>
                <span className="font-mono break-all">{config.log_directory}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Instance Directory</span>
                <span className="font-mono break-all">{config.instance_directory}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Platform</span>
                <span className="font-mono">{config.platform}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">System Timezone</span>
                <span className="font-mono">{config.system_timezone}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">Python Version</span>
                <span className="font-mono">{config.python_version}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-medium text-muted-foreground">SQLite Version</span>
                <span className="font-mono">{config.sqlite_version}</span>
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
              <CardDescription>Background tasks running on the server</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {tasksLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              Loading scheduled tasks...
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-sm text-muted-foreground">No scheduled tasks found</div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Task Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Next Execution</TableHead>
                </TableRow>
              </TableHeader>
                <TableBody>
                  {tasks.map((task) => (
                    <ScheduledTaskRow key={task.id} task={task} onClick={handleTaskClick} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task Details Modal */}
      <ResponsiveDialog
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        title={
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faCircleInfo} className="size-5 text-primary" />
            Task Details
          </div>
        }
        description="Detailed information about this scheduled task"
        contentClassName="max-w-2xl"
        footer={
          <Button variant="outline" onClick={handleCloseModal}>
            Close
          </Button>
        }
      >
        {selectedTask && (
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

            {selectedTask.type === 'WebSocket' && (
              <div className="rounded-lg border bg-muted/30 p-4">
                <h3 className="mb-2 font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                  Channels
                </h3>
                {Array.isArray(selectedTask.channels) && selectedTask.channels.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedTask.channels.map((channel: string) => (
                      <span
                        key={channel}
                        className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
                      >
                        {channel}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No channels subscribed.</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  Channels follow the <code className="bg-muted px-1 py-0.5 rounded">service.server_id.topic</code> pattern.
                </p>
                <div className="mt-3 space-y-2">
                  <div className="text-xs font-semibold text-muted-foreground uppercase">Common channels</div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      'plex.<server_id>.sessions',
                      'emby.<server_id>.sessions',
                      'jellyfin.<server_id>.sessions',
                      'kavita.<server_id>.reading_progress',
                      'system.sync_status',
                    ].map((channel) => (
                      <span
                        key={channel}
                        className="inline-flex items-center rounded-full bg-muted px-2 py-1 text-[11px] font-medium text-muted-foreground"
                      >
                        {channel}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Task Details Grid */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                Task Information
              </h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {getTaskDetails(selectedTask).map((detail, index) => (
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
                  {selectedTask.type === 'WebSocket' ? (
                    selectedTask.state === 'Connected' ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                        <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Disconnected
                      </span>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                      <FontAwesomeIcon icon={faCircle} className="text-[6px]" /> Active
                    </span>
                  )}
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
          </div>
        )}
      </ResponsiveDialog>
    </div>
  );
};

export default AdminSettingsAdvancedPage;
