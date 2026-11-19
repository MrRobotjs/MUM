import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faClipboardList, faGear, faRotate, faServer, faShieldHalved, faTicket, faUserGear, faWandMagicSparkles, faFilm, faCircleInfo, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useDashboardData, fetchRecentEvents } from '../../lib/dashboard';
import { SettingIcon, TabHeading } from '../users/AccountSettings';

// The dashboard's Admin log (formerly "Recent Activity", renamed so it isn't
// mistaken for the Activity card): the latest changes made in MUM, newest
// first, each with an icon for what it touched and when.

type AdminEvent = { id: number; timestamp: string | null; event_type: string | null; message: string };

// What an event touched, from its recorded action.
export function adminEventIcon(action: string | null): IconDefinition {
  const a = action ?? '';
  if (a.startsWith('server.')) return faServer;
  if (a.startsWith('invitation.')) return faTicket;
  if (a.startsWith('settings.')) return faGear;
  if (a.startsWith('service.remote_access.')) return faShieldHalved;
  if (a.startsWith('service.') || a.startsWith('account.')) return faUserGear;
  if (a.startsWith('provisioning.')) return faWandMagicSparkles;
  if (a.startsWith('overseerr.')) return faFilm;
  return faCircleInfo;
}

export const AdminLogCard = () => {
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const { data, loading, error, mutate } = useDashboardData<{ data: AdminEvent[] }>('dashboard:recent-events', () => fetchRecentEvents(8));
  const events = data?.data ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faClipboardList} title="Admin log" description="Changes made in MUM, newest first." />
          <Button variant="ghost" size="icon" aria-label="Refresh the admin log" title="Refresh" onClick={() => void mutate()}><FontAwesomeIcon icon={faRotate} /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !data ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4 text-primary" />Loading the admin log…</div>
          : error ? <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">Couldn’t load the admin log.</div>
          : events.length === 0 ? <p className="text-sm text-muted-foreground">No changes recorded yet.</p>
          : <ul className="space-y-3">
            {events.map(event => (
              <li key={event.id} className="flex items-center gap-3">
                <SettingIcon className="bg-primary/20 text-primary"><FontAwesomeIcon icon={adminEventIcon(event.event_type)} className="w-4 h-4" /></SettingIcon>
                <p className="text-sm flex-1 min-w-0">{event.message}</p>
                {event.timestamp && <span className="text-xs text-muted-foreground whitespace-nowrap" title={formatTimestamp(event.timestamp)}>
                  {formatRelative(event.timestamp).replace(/^Just now$/, 'just now')}
                </span>}
              </li>
            ))}
          </ul>}
      </CardContent>
    </Card>
  );
};
