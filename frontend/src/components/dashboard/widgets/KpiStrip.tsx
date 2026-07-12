import type { ReactNode } from 'react';
import {
  IconActivity,
  IconDeviceTv,
  IconTicket,
  IconUsers,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { useAdminApi } from '@/hooks/useAdminApi';
import { useInviteSummary } from '@/hooks/useInviteSummary';
import { useStreamingWebSocket } from '@/hooks/useStreamingWebSocket';
import { useUsersPaginated } from '@/hooks/useUsersPaginated';
import { BentoTile, BentoTileBody } from '../bento';

type ServerStatusResponse = {
  data: {
    summary: {
      total_servers: number;
      online: number;
      offline: number;
    };
  };
};

type KpiMetricProps = {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  iconClassName?: string;
};

const KpiMetric = ({ label, value, icon, iconClassName }: KpiMetricProps) => (
  <BentoTile span={{ col: 3, mdCol: 6 }} label={label}>
    <BentoTileBody className="flex items-center justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        {value}
      </div>
      <div
        className={cn(
          'shrink-0 rounded-md border border-border bg-background p-2',
          iconClassName,
        )}
      >
        {icon}
      </div>
    </BentoTileBody>
  </BentoTile>
);

const KpiValueSkeleton = () => (
  <div className="h-8 w-16 animate-pulse rounded bg-muted" aria-hidden />
);

const KpiValue = ({
  children,
  isLoading,
  error,
}: {
  children: ReactNode;
  isLoading?: boolean;
  error?: unknown;
}) => {
  if (error) {
    return <span className="text-sm font-medium text-destructive">Error</span>;
  }
  if (isLoading) {
    return <KpiValueSkeleton />;
  }
  return (
    <span className="text-3xl font-bold tabular-nums tracking-tight text-foreground">
      {children}
    </span>
  );
};

export const KpiStrip = () => {
  const { activeCount, isConnected } = useStreamingWebSocket({ autoConnect: false });

  const {
    pagination,
    loading: usersLoading,
    error: usersError,
  } = useUsersPaginated({ page: 1, pageSize: 1 });
  const totalUsers = pagination?.total_items ?? 0;

  const {
    summary: inviteSummary,
    loading: invitesLoading,
    error: invitesError,
  } = useInviteSummary();
  const activeInvites = inviteSummary?.counts?.usable ?? inviteSummary?.counts?.active ?? 0;

  const {
    data: statusData,
    loading: statusLoading,
    error: statusError,
  } = useAdminApi<ServerStatusResponse>('/server-status');

  const summary = statusData?.data.summary;
  const onlineServers = summary?.online ?? 0;
  const totalServers = summary?.total_servers ?? 0;
  const allOnline = totalServers > 0 && onlineServers === totalServers;
  const partiallyOnline = onlineServers > 0 && onlineServers < totalServers;

  const healthLabel =
    totalServers > 0 ? `${onlineServers}/${totalServers}` : '—';

  return (
    <>
      <KpiMetric
        label="Active streams"
        value={
          <KpiValue>
            {activeCount}
            {isConnected && activeCount > 0 ? (
              <span className="sr-only">Live updates connected</span>
            ) : null}
          </KpiValue>
        }
        icon={
          <IconDeviceTv
            className={cn(
              'h-5 w-5',
              activeCount > 0 && isConnected
                ? 'animate-pulse text-primary'
                : activeCount > 0
                  ? 'text-primary'
                  : 'text-muted-foreground',
            )}
            stroke={1.75}
          />
        }
      />

      <KpiMetric
        label="Total users"
        value={
          <KpiValue isLoading={usersLoading} error={usersError}>
            {totalUsers}
          </KpiValue>
        }
        icon={<IconUsers className="h-5 w-5 text-muted-foreground" stroke={1.75} />}
      />

      <KpiMetric
        label="Active invites"
        value={
          <KpiValue isLoading={invitesLoading} error={invitesError}>
            {activeInvites}
          </KpiValue>
        }
        icon={<IconTicket className="h-5 w-5 text-muted-foreground" stroke={1.75} />}
      />

      <KpiMetric
        label="System status"
        value={
          <KpiValue isLoading={statusLoading} error={statusError}>
            {healthLabel}
          </KpiValue>
        }
        icon={
          <IconActivity
            className={cn(
              'h-5 w-5',
              allOnline
                ? 'text-emerald-500'
                : partiallyOnline
                  ? 'text-amber-500'
                  : 'text-muted-foreground',
            )}
            stroke={1.75}
          />
        }
      />
    </>
  );
};
