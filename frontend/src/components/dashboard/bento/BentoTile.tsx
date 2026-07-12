import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { BentoTileSpan } from './bento.types';

const lgColClass: Record<BentoTileSpan['col'], string> = {
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
  5: 'lg:col-span-5',
  6: 'lg:col-span-6',
  7: 'lg:col-span-7',
  8: 'lg:col-span-8',
  12: 'lg:col-span-12',
};

const mdColClass: Record<NonNullable<BentoTileSpan['mdCol']>, string> = {
  3: 'md:col-span-3',
  4: 'md:col-span-4',
  6: 'md:col-span-6',
};

const rowClass: Record<NonNullable<BentoTileSpan['row']>, string> = {
  1: 'lg:row-span-1',
  2: 'lg:row-span-2',
};

type BentoTileProps = {
  span: BentoTileSpan;
  children: ReactNode;
  className?: string;
  /** Accessible label for the tile region */
  label?: string;
};

/**
 * Solid tile shell — no blur/glass. Clear border, readable contrast.
 */
export const BentoTile = ({ span, children, className, label }: BentoTileProps) => {
  const mdCol = span.mdCol ?? (span.col >= 6 ? 6 : span.col >= 4 ? 4 : 3);

  return (
    <section
      aria-label={label}
      className={cn(
        'col-span-1 flex min-h-0 flex-col',
        'rounded-lg border border-border bg-card text-card-foreground',
        mdColClass[mdCol],
        lgColClass[span.col],
        span.row ? rowClass[span.row] : undefined,
        className,
      )}
    >
      {children}
    </section>
  );
};

type BentoTileHeaderProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  badge?: ReactNode;
};

export const BentoTileHeader = ({ title, description, action, badge }: BentoTileHeaderProps) => (
  <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
        {badge}
      </div>
      {description ? (
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
    {action ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{action}</div> : null}
  </header>
);

export const BentoTileBody = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn('flex min-h-0 flex-1 flex-col px-5 py-4', className)}>{children}</div>
);

export const BentoTileFooter = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) => (
  <footer
    className={cn(
      'mt-auto flex shrink-0 items-center justify-between gap-2 border-t border-border px-5 py-3',
      className,
    )}
  >
    {children}
  </footer>
);
