import { useNavigate } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClockRotateLeft, faWaveSquare } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isTaskRunning, useScheduledTasks } from '../../hooks/useScheduledTasks';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getServiceBadgeClass, getServiceIcon } from '../../config/mediaServiceMetadata';
import { cn } from '@/lib/utils';
import { RefreshProgress } from '../settings/RefreshProgress';

/** The top bar's Activity menu: the user and library refreshes running now. */
export const ActivityDropdown = () => {
  const navigate = useNavigate();
  const { formatRelative } = useAccountDisplay();
  const { actor, tasks, loading, error } = useScheduledTasks();
  if (!actor) return null;
  const running = tasks.filter(isTaskRunning);

  const openTask = (task?: string) => navigate({ to: '/admin/settings/info', search: task ? { task } : {} });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={running.length ? `Activity: ${running.length} running` : 'Activity'}>
          <FontAwesomeIcon icon={faWaveSquare} className={cn('h-5 w-5', running.length > 0 && 'text-primary')} />
          {running.length > 0 && (
            <Badge className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs">
              {running.length}
            </Badge>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Activity</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {loading || (error && !running.length) ? (
          <div className="p-4 text-center text-sm text-muted-foreground">{loading ? 'Loading activity…' : 'Activity unavailable right now.'}</div>
        ) : running.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">Nothing running right now</div>
        ) : (
          <div className="max-h-100 overflow-y-auto">
            {running.map(task => (
              <DropdownMenuItem key={task.id} className="flex cursor-pointer items-start gap-2 p-3" onClick={() => openTask(task.id)}>
                <Spinner className="mt-0.5 size-4 text-emerald-600" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium leading-none">
                    {task.scope === 'users' ? 'Refreshing users list' : 'Refreshing libraries list'}
                  </p>
                  <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${getServiceBadgeClass(task.provider)}`}>
                    {getServiceIcon(task.provider, 'size-3')}
                    <span className="sr-only">{task.provider}: </span>
                    {task.server_name}
                  </span>
                  {task.progress && <RefreshProgress scope={task.scope} progress={task.progress} />}
                  <p className="text-xs text-muted-foreground">
                    {task.state === 'recovering' ? 'Finishing an earlier run' : task.started_at ? `Started ${formatRelative(task.started_at).replace(/^Just now$/, 'just now')}` : 'Running now'}
                  </p>
                </div>
              </DropdownMenuItem>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openTask()}>
          <FontAwesomeIcon icon={faClockRotateLeft} className="mr-2" />
          Open Scheduled Tasks
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
