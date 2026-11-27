import { useEffect, useRef, useSyncExternalStore } from 'react';
import useSWR from 'swr';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleCheck, faCircleInfo, faCircleXmark, faTriangleExclamation, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '../ui/spinner';
import { useAuth } from '../../contexts/AuthContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { Link } from '@tanstack/react-router';
import { Poster } from '../library/LibraryOverview';
import { appLinks } from '../../router/appLinks';
import { useServerRoutes } from '@/lib/serverRoutes';
import { fetchRefreshRuns, type RefreshItemChange, type RefreshLogEntry, type RefreshLogLevel, type RefreshRun, type RefreshRunOutcome } from '../../lib/refreshRuns';

// A refresh task's recent runs under its details: the newest run open, older
// runs collapsed, each entry marked as a success, warning or error.

const levelStyle: Record<RefreshLogLevel, { icon: IconDefinition; className: string; label: string }> = {
  success: { icon: faCircleCheck, className: 'text-emerald-600', label: 'Success' },
  info: { icon: faCircleInfo, className: 'text-muted-foreground', label: 'Note' },
  warning: { icon: faTriangleExclamation, className: 'text-amber-500', label: 'Warning' },
  error: { icon: faCircleXmark, className: 'text-red-600', label: 'Error' },
};
const outcomeStyle: Record<RefreshRunOutcome, { label: string; className: string }> = {
  succeeded: { label: 'Succeeded', className: 'text-emerald-600' },
  warnings: { label: 'Succeeded with warnings', className: 'text-amber-500' },
  failed: { label: 'Failed', className: 'text-red-600' },
  cancelled: { label: 'Cancelled', className: 'text-muted-foreground' },
};

const changeLabel: Record<RefreshItemChange, string> = { added: 'Added', updated: 'Updated', removed: 'Removed', skipped: 'Skipped' };

// An entry's titles or accounts, behind a dropdown: titles as the poster row
// used across the app (linked when still in the catalogue), accounts as a list.
function EntryItems({ entry, serverSlug }: { entry: RefreshLogEntry; serverSlug: string | undefined }) {
  if (entry.items.length === 0) return entry.more_items > 0 ? <div className="text-xs text-muted-foreground">{entry.more_items.toLocaleString()} not listed</div> : null;
  const titles = entry.items.some(item => item.item_id !== null);
  const count = entry.items.length + entry.more_items;
  const noun = titles ? (count === 1 ? 'title' : 'titles') : (count === 1 ? 'account' : 'accounts');
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-primary hover:underline">Show {count.toLocaleString()} {noun}</summary>
      {titles ? <div className="account-recent-row mt-2">
        {entry.items.map((item, n) => {
          const body = <>
            <div className="account-recent-poster">
              <Poster url={item.poster_url} title={item.title} className="w-full h-full" />
              <div className="account-recent-when">{changeLabel[item.change]}</div>
            </div>
            <div className="mt-2 text-sm font-medium truncate">{item.title}</div>
            {item.note && <div className="text-xs text-muted-foreground truncate" title={item.note}>{item.note}</div>}
          </>;
          return item.item_id !== null && item.library_id !== null && serverSlug
            ? <Link key={n} {...appLinks.media(serverSlug, item.library_id, item.item_id)} className="account-recent-item" title={item.title}>{body}</Link>
            : <div key={n} className="account-recent-item" title={item.title}>{body}</div>;
        })}
      </div> : <ul className="mt-2 space-y-1">
        {entry.items.map((item, n) => <li key={n} className="flex items-center justify-between gap-2 text-xs">
          <span className="truncate">{item.title}</span><span className="shrink-0 text-muted-foreground">{changeLabel[item.change]}</span>
        </li>)}
      </ul>}
      {entry.more_items > 0 && <div className="mt-1 text-xs text-muted-foreground">and {entry.more_items.toLocaleString()} more not listed</div>}
    </details>
  );
}

export function runDuration(run: RefreshRun): string {
  const seconds = Math.max(0, Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 1000));
  if (seconds < 1) return 'under a second';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

export function RefreshRunLog({ server, scope, runningSince }: { server: number; scope: 'users' | 'libraries'; runningSince: string | null }) {
  const { user, isAdministrator } = useAuth();
  const { formatTimestamp } = useAccountDisplay();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const serverSlug = useServerRoutes().slugFor(server);
  // Cached per signed-in session, so one person's log never shows after another signs in.
  const key = isAdministrator && user?.uuid && session.accessToken ? ['refresh-runs', user.uuid, session.accessToken, server, scope] as const : null;
  const { data, error, isLoading, mutate } = useSWR(key, ([, , , id, s]) => fetchRefreshRuns(id, s), { refreshInterval: 10000 });
  // Read the log again as soon as the running refresh finishes.
  const wasRunning = useRef(runningSince);
  useEffect(() => {
    if (wasRunning.current && !runningSince) void mutate().catch(() => {});
    wasRunning.current = runningSince;
  }, [runningSince, mutate]);

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Run log</h3>
      {runningSince && <div className="flex items-center gap-2 rounded-lg border bg-card p-3 text-sm">
        <Spinner className="size-4 text-muted-foreground" />
        <span>In progress since {formatTimestamp(runningSince)}. Its log appears here when it finishes.</span>
      </div>}
      {error ? <p className="text-sm text-muted-foreground">The run log couldn’t be loaded.</p>
        : isLoading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4 text-muted-foreground" />Loading the run log…</div>
        : !data || data.length === 0 ? (runningSince ? null : <p className="text-sm text-muted-foreground">No runs recorded yet. The log fills in after the next run.</p>)
        : data.map((run, index) => {
          const outcome = outcomeStyle[run.outcome];
          return (
            <details key={run.id} open={index === 0} className="rounded-lg border bg-card p-3">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2">
                <span className={`text-sm font-medium ${outcome.className}`}>{outcome.label}</span>
                <span className="text-xs text-muted-foreground">{formatTimestamp(run.started_at)} · took {runDuration(run)}</span>
              </summary>
              <ul className="mt-3 space-y-2">
                {run.entries.map((entry, n) => {
                  const level = levelStyle[entry.level];
                  return (
                    <li key={n} className="flex items-start gap-2 text-sm">
                      <FontAwesomeIcon icon={level.icon} className={`mt-0.5 shrink-0 ${level.className}`} aria-hidden="true" />
                      <div className="min-w-0">
                        <span className="sr-only">{level.label}: </span>
                        <div className="wrap-break-word">{entry.message}</div>
                        {entry.detail && <div className="text-xs text-muted-foreground">{entry.detail}</div>}
                        <EntryItems entry={entry} serverSlug={serverSlug} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
    </div>
  );
}
