import { useState } from 'react';
import { DashboardLayout, ActiveStreamsCard, WatchStatsCard, HistoryCard, ServersModal, InvitesSummaryCard, StreamingSummaryCard, ServerStatusCard } from '../components/dashboard';

export const DashboardPage = () => {
  const [serversModalOpen, setServersModalOpen] = useState(false);

  return (
    <>
      <DashboardLayout>
        <div className="space-y-6">
          <ServerStatusCard onViewAll={() => setServersModalOpen(true)} />
          <WatchStatsCard />
          <div className="grid gap-6 md:grid-cols-2">
            <InvitesSummaryCard />
            <StreamingSummaryCard />
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <ActiveStreamsCard />
            <HistoryCard />
          </div>
        </div>
      </DashboardLayout>
      <ServersModal open={serversModalOpen} onClose={() => setServersModalOpen(false)} />
    </>
  );
};

export default DashboardPage;
