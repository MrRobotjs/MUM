import type { ReactNode } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export const DashboardLayout = ({ children }: { children: ReactNode }) => (
  <div className="space-y-6">
    {children}
  </div>
);

export const DashboardCard = ({ title, children, className }: { title: string; children: ReactNode; className?: string }) => (
  <Card className={className}>
    <CardHeader className="pb-3">
      <CardTitle>{title}</CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      {children}
    </CardContent>
  </Card>
);
