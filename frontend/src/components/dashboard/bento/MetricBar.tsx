import { cn } from '@/lib/utils';

type MetricBarProps = {
  label: string;
  value: number;
  max?: number;
  suffix?: string;
  className?: string;
};

export const MetricBar = ({ label, value, max, suffix, className }: MetricBarProps) => {
  const denominator = max && max > 0 ? max : Math.max(value, 1);
  const percent = Math.min(100, Math.round((value / denominator) * 100));

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {value}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};

type SplitMetricBarProps = {
  leftLabel: string;
  leftValue: number;
  leftPercent: number;
  rightLabel: string;
  rightValue: number;
  rightPercent: number;
};

export const SplitMetricBar = ({
  leftLabel,
  leftValue,
  leftPercent,
  rightLabel,
  rightValue,
  rightPercent,
}: SplitMetricBarProps) => (
  <div className="space-y-2">
    <div className="flex h-2 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full bg-emerald-500 transition-[width] duration-300"
        style={{ width: `${leftPercent}%` }}
      />
      <div
        className="h-full bg-amber-500 transition-[width] duration-300"
        style={{ width: `${rightPercent}%` }}
      />
    </div>
    <div className="grid grid-cols-2 gap-3 text-xs">
      <div className="space-y-0.5">
        <p className="font-medium text-foreground">{leftLabel}</p>
        <p className="tabular-nums text-muted-foreground">
          {leftValue} · {leftPercent}%
        </p>
      </div>
      <div className="space-y-0.5 text-right">
        <p className="font-medium text-foreground">{rightLabel}</p>
        <p className="tabular-nums text-muted-foreground">
          {rightValue} · {rightPercent}%
        </p>
      </div>
    </div>
  </div>
);

export const MetricBarSkeleton = ({ rows = 3 }: { rows?: number }) => (
  <div className="space-y-3">
    {Array.from({ length: rows }).map((_, index) => (
      <div key={index} className="space-y-1.5">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-2 animate-pulse rounded-full bg-muted" />
      </div>
    ))}
  </div>
);
