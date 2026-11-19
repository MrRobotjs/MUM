import { DashboardLayout, ActivityCard, AdminLogCard, InvitesSummaryCard, ServerStatusCard } from '../components/dashboard';

export const DashboardPage = () => {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <ServerStatusCard />
        <ActivityCard />
        <div className="grid gap-6 md:grid-cols-2">
          <InvitesSummaryCard />
          <AdminLogCard />
        </div>
      </div>
    </DashboardLayout>
  );
};

export default DashboardPage;
