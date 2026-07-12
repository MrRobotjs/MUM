import type { ReactNode } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { BentoGrid } from './bento';

type DashboardLayoutProps = {
  children: ReactNode;
};

export const DashboardLayout = ({ children }: DashboardLayoutProps) => (
  <div className="space-y-6">
    <PageHeader
      title="Dashboard"
      description="Overview of streaming activity, users, invites, and connected media services."
    />
    <BentoGrid>{children}</BentoGrid>
  </div>
);

/** @deprecated Prefer BentoTile — kept for legacy cards during migration. */
export { DashboardCard } from './legacy/DashboardCard';
