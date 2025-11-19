import clsx from 'clsx';
import { useInviteSummary } from '../../hooks/useInviteSummary';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Link } from '@tanstack/react-router';

const metricClassNames: Record<string, string> = {
  total: 'bg-primary/10 text-primary',
  active: 'bg-green-50 dark:bg-green-400/10 text-green-600 dark:text-green-400',
  usable: 'bg-blue-50 dark:bg-blue-400/10 text-blue-600 dark:text-blue-400',
  expired: 'bg-amber-50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-400',
  maxed: 'bg-red-50 dark:bg-red-400/10 text-red-600 dark:text-red-400',
  inactive: 'bg-muted text-muted-foreground'
};

export const InvitesSummaryCard = () => {
  const { summary, loading, error } = useInviteSummary();

  const counts = summary?.counts;
  const metrics = counts
    ? [
        { key: 'total', label: 'Total', value: counts.total },
        { key: 'usable', label: 'Usable', value: counts.usable },
        { key: 'active', label: 'Active', value: counts.active },
        { key: 'inactive', label: 'Inactive', value: counts.inactive },
        { key: 'expired', label: 'Expired', value: counts.expired },
        { key: 'maxed', label: 'Maxed', value: counts.maxed }
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-xl">Invites</CardTitle>
            <CardDescription>Current invite health and recent activity.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/invites">Manage</Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading invite metrics…</p>
        ) : null}

        {error ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load invite summary.
          </div>
        ) : null}

        {summary ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              {metrics.map((metric) => (
                <div
                  key={metric.key}
                  className={clsx(
                    'rounded-xl px-4 py-3',
                    metricClassNames[metric.key] ?? 'bg-muted text-foreground'
                  )}
                >
                  <p className="text-xs uppercase">{metric.label}</p>
                  <p className="text-2xl font-semibold">{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground/80">Recent Invites</h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {summary.recent_invites.length === 0 ? (
                    <li className="text-muted-foreground">No invites created recently.</li>
                  ) : null}
                  {summary.recent_invites.map((invite) => (
                    <li key={invite.id} className="flex items-center justify-between rounded-lg border bg-muted/50 px-3 py-2">
                      <div>
                        <p className="font-medium">
                          {invite.custom_path || invite.token}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Created{' '}
                          {invite.created_at ? new Date(invite.created_at).toLocaleString() : 'Unknown'} • Uses{' '}
                          {invite.current_uses}/{invite.max_uses ?? '∞'}
                        </p>
                      </div>
                      <Badge
                        variant={
                          invite.is_expired || invite.has_reached_max_uses ? 'warning' : 'success'
                        }
                      >
                        {invite.is_expired
                          ? 'Expired'
                          : invite.has_reached_max_uses
                            ? 'Maxed'
                            : invite.is_active
                              ? 'Active'
                              : 'Disabled'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-foreground/80">Recent Usage</h3>
                <ul className="mt-3 space-y-2 text-sm">
                  {summary.recent_usages.length === 0 ? (
                    <li className="text-muted-foreground">No recent invite usage.</li>
                  ) : null}
                  {summary.recent_usages.map((usage) => (
                    <li key={usage.id} className="rounded-lg border bg-muted/50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <p className="font-medium">
                          {usage.plex_username || usage.discord_username || 'Anonymous'}
                        </p>
                        <Badge variant={usage.accepted_invite ? 'success' : 'outline'}>
                          {usage.accepted_invite ? 'Accepted' : 'Pending'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {usage.used_at ? new Date(usage.used_at).toLocaleString() : 'Unknown time'}
                      </p>
                      {usage.status_message ? (
                        <p className="text-xs text-muted-foreground">{usage.status_message}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default InvitesSummaryCard;
