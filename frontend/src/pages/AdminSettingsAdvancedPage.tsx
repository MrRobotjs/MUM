import { useState, useEffect } from 'react';
import {
  IconAlertTriangle,
  IconShieldLock,
  IconShieldCheck,
  IconClockHour4,
} from '@tabler/icons-react';

import { useAdvancedSettings, type AdvancedSettings } from '../hooks/useSettings';
import { useScheduledTasks } from '../hooks/useScheduledTasks';
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

const ScheduledTaskRow = ({ task }: { task: any }) => {
  const countdown = useCountdown(task.next_run_time);

  // Determine badge color based on state
  const getStateBadge = () => {
    if (task.type === 'WebSocket') {
      if (task.state === 'Connected') {
        return <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><i className="fa-solid fa-circle text-[6px]" /> Connected</span>;
      } else {
        return <span className="inline-flex items-center gap-1 text-xs text-red-600"><i className="fa-solid fa-circle text-[6px]" /> Disconnected</span>;
      }
    } else {
      return <span className="inline-flex items-center gap-1 text-xs text-blue-600"><i className="fa-solid fa-circle text-[6px]" /> Active</span>;
    }
  };

  const getSideBadge = () => {
    if (task.side === 'Server') {
      return <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"><i className="fa-solid fa-server text-[10px]" /> Server</span>;
    } else {
      return <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700 dark:bg-sky-900/30 dark:text-sky-400"><i className="fa-solid fa-desktop text-[10px]" /> Client</span>;
    }
  };

  return (
    <TableRow>
      <TableCell className="font-medium">{task.name}</TableCell>
      <TableCell>{getStateBadge()}</TableCell>
      <TableCell>{getSideBadge()}</TableCell>
      <TableCell>{task.type}</TableCell>
      <TableCell className="font-mono text-sm">
        {task.type === 'WebSocket' ? 'N/A' : countdown}
      </TableCell>
    </TableRow>
  );
};

export const AdminSettingsAdvancedPage = () => {
  const { settings, loading, error, refresh } = useAdvancedSettings();
  const { tasks, loading: tasksLoading } = useScheduledTasks();
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<AdvancedSettings>({
    api_timeout_seconds: 3,
  });
  const [submitting, setSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  }, [settings]);

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
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Advanced Settings"
        description="Configure security and session settings"
      />

      {error && (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertTitle>Failed to load advanced settings</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="default">
        <IconShieldLock />
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
          <form onSubmit={handleSubmit} className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <IconShieldCheck className="size-5 text-primary" />
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
        )
      )}

      {/* Scheduled Tasks Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <IconClockHour4 className="size-5 text-primary" />
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
                    <TableHead>Next Execution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((task) => (
                    <ScheduledTaskRow key={task.id} task={task} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AdminSettingsAdvancedPage;
