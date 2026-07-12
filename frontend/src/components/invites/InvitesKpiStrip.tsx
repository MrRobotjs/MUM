import type { ReactNode } from 'react';
import {
  IconCircleCheck,
  IconClockOff,
  IconPlayerPause,
  IconTicket,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { useInviteSummary } from '@/hooks/useInviteSummary';

type KpiMetricProps = {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  iconClassName?: string;
};

const KpiMetric = ({ label, value, icon, iconClassName }: KpiMetricProps) => (
  <section
    aria-label={label}
    className="rounded-lg border border-border bg-card text-card-foreground"
  >
    <div className="flex items-center justify-between gap-3 p-4">
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
    </div>
  </section>
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

export const InvitesKpiStrip = () => {
  const { summary, loading, error } = useInviteSummary();
  const counts = summary?.counts ?? {
    total: 0,
    usable: 0,
    paused: 0,
    expired: 0,
    maxed: 0,
  };

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <KpiMetric
        label="Total invites"
        value={
          <KpiValue isLoading={loading} error={error}>
            {counts.total}
          </KpiValue>
        }
        icon={<IconTicket className="h-5 w-5 text-muted-foreground" stroke={1.75} />}
      />

      <KpiMetric
        label="Usable now"
        value={
          <KpiValue isLoading={loading} error={error}>
            {counts.usable}
          </KpiValue>
        }
        icon={<IconCircleCheck className="h-5 w-5 text-emerald-500" stroke={1.75} />}
      />

      <KpiMetric
        label="Paused (offline)"
        value={
          <KpiValue isLoading={loading} error={error}>
            {counts.paused}
          </KpiValue>
        }
        icon={<IconPlayerPause className="h-5 w-5 text-amber-500" stroke={1.75} />}
      />

      <KpiMetric
        label="Expired / maxed"
        value={
          <KpiValue isLoading={loading} error={error}>
            {counts.expired + counts.maxed}
          </KpiValue>
        }
        icon={<IconClockOff className="h-5 w-5 text-destructive" stroke={1.75} />}
      />
    </div>
  );
};
