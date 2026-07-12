import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type BentoGridProps = {
  children: ReactNode;
  className?: string;
};

/**
 * 12-column modular grid (Bento layout).
 * Mobile: single column. md: 6 columns. lg+: 12 columns.
 */
export const BentoGrid = ({ children, className }: BentoGridProps) => (
  <div
    className={cn(
      'grid grid-cols-1 gap-4 md:grid-cols-6 lg:grid-cols-12 auto-rows-min',
      className,
    )}
  >
    {children}
  </div>
);
