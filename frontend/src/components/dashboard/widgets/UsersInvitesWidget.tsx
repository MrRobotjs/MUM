import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useInviteSummary } from '@/hooks/useInviteSummary';
import { useUsersPaginated } from '@/hooks/useUsersPaginated';
import { BentoTile, BentoTileBody, BentoTileHeader } from '../bento';

type StatBlockProps = {
  label: string;
  value: number | string;
  hint?: string;
  accent?: 'default' | 'success' | 'warning';
};

const accentClass: Record<NonNullable<StatBlockProps['accent']>, string> = {
  default: 'text-foreground',
  success: 'text-emerald-400',
  warning: 'text-amber-400',
};

const StatBlock = ({ label, value, hint, accent = 'default' }: StatBlockProps) => (
  <div className="rounded-md border border-border bg-background px-4 py-3">
    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </p>
    <p className={`mt-1 text-2xl font-semibold tabular-nums ${accentClass[accent]}`}>{value}</p>
    {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
  </div>
);

export const UsersInvitesWidget = () => {
  const { summary: inviteSummary, loading: invitesLoading, error: invitesError } = useInviteSummary();
  const {
    pagination,
    loading: usersLoading,
    error: usersError,
  } = useUsersPaginated({ page: 1, pageSize: 1 });

  const totalUsers = pagination?.total_items ?? 0;

  const loading = invitesLoading || usersLoading;
  const counts = inviteSummary?.counts;

  return (
    <BentoTile span={{ col: 5, mdCol: 6 }} label="Users and invites">
      <BentoTileHeader
        title="Users & invites"
        description="Directory size and invite pipeline health."
        action={
          <div className="flex gap-1">
            <Button asChild variant="ghost" size="sm" className="h-8 text-xs">
              <Link to="/admin/users">Users</Link>
            </Button>
            <Button asChild variant="ghost" size="sm" className="h-8 text-xs">
              <Link to="/admin/invites">Invites</Link>
            </Button>
          </div>
        }
      />

      <BentoTileBody>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="h-4 w-4" />
            Loading metrics…
          </div>
        ) : usersError || invitesError ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Failed to load user or invite statistics.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <StatBlock label="Total users" value={totalUsers} hint="Managed accounts" />
            <StatBlock
              label="Usable invites"
              value={counts?.usable ?? 0}
              hint={`${counts?.active ?? 0} active`}
              accent="success"
            />
            <StatBlock label="Paused" value={counts?.paused ?? 0} accent="warning" />
            <StatBlock
              label="Expired / maxed"
              value={(counts?.expired ?? 0) + (counts?.maxed ?? 0)}
              hint={`${counts?.total ?? 0} total invites`}
            />
          </div>
        )}

        {inviteSummary && inviteSummary.recent_usages.length > 0 ? (
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Recent invite activity
            </p>
            <ul className="mt-2 space-y-1.5">
              {inviteSummary.recent_usages.slice(0, 3).map((usage) => (
                <li
                  key={usage.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
                >
                  <span className="truncate font-medium text-foreground">
                    {usage.plex_username || usage.discord_username || 'Anonymous'}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {usage.accepted_invite ? 'Accepted' : 'Pending'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </BentoTileBody>
    </BentoTile>
  );
};
