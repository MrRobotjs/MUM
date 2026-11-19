import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRight, faBan, faCircleCheck, faClock, faTicket, faUserCheck } from '@fortawesome/free-solid-svg-icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useInviteSummary } from '../../hooks/useInviteSummary';
import { TabHeading } from '../users/AccountSettings';
import { Tile } from '../library/LibraryOverview';
import './ServerHealth.css';

// The dashboard's Invites card: how many invites can still be used, and the
// newest invites with their uses and status. Each opens the Invites page.
export const InvitesSummaryCard = () => {
  const { formatRelative, formatTimestamp } = useAccountDisplay();
  const { summary, loading, error } = useInviteSummary();
  const counts = summary?.counts;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <TabHeading icon={faTicket} title="Invites" description="Invites that can still be used, and the newest ones." />
          <Button variant="outline" size="sm" asChild><Link to="/admin/invites">Manage invites<FontAwesomeIcon icon={faArrowRight} /></Link></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {loading && !summary ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4 text-primary" />Loading invites…</div>
          : error ? <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">Couldn’t load invites.</div>
          : summary && counts ? <>
            <div className="dashboard-overview-grid">
              <Tile icon={faCircleCheck} label="Usable" value={counts.usable.toLocaleString()} note="Can still be redeemed" />
              <Tile icon={faClock} label="Paused" value={(counts.paused ?? 0).toLocaleString()} note="Stopped for now" />
              <Tile icon={faBan} label="Expired" value={counts.expired.toLocaleString()} note="Past their end date" />
              <Tile icon={faUserCheck} label="Used up" value={counts.maxed.toLocaleString()} note="Reached their limit" />
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Recent invites</h3>
              {summary.recent_invites.length === 0 ? <p className="text-sm text-muted-foreground">No invites yet.</p> : (
                <ul className="space-y-2">
                  {summary.recent_invites.map(invite => (
                    <li key={invite.id}>
                      <Link to="/admin/invites" className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 hover:bg-muted/50 transition-colors">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{invite.custom_path || invite.token}</p>
                          <p className="text-xs text-muted-foreground" title={invite.created_at ? formatTimestamp(invite.created_at) : undefined}>
                            {invite.created_at ? `Created ${formatRelative(invite.created_at).replace(/^Just now$/, 'just now')}` : 'Created at an unknown time'} · {invite.current_uses} / {invite.max_uses ?? '∞'} uses
                          </p>
                        </div>
                        <Badge variant={invite.is_paused || invite.is_expired || invite.has_reached_max_uses ? 'warning' : 'success'}>
                          {invite.is_paused ? 'Paused' : invite.is_expired ? 'Expired' : invite.has_reached_max_uses ? 'Used up' : invite.is_active ? 'Active' : 'Disabled'}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </> : null}
      </CardContent>
    </Card>
  );
};
