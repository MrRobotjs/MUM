import { useState } from 'react';
import {
  DashboardLayout,
  ServerStatusCard,
  ActiveStreamsCard,
  WatchStatsCard,
  HistoryCard,
  ServersModal,
  InvitesSummaryCard,
  StreamingSummaryCard
} from '../components/dashboard';

export const DashboardPage = () => {
  const [serversModalOpen, setServersModalOpen] = useState(false);
  return (
    <>
      <DashboardLayout>
        {/* Top Row - Server Status */}
        <ServerStatusCard onViewAll={() => setServersModalOpen(true)} />

        {/* Second Row - Watch Stats (Full Width) */}
        <WatchStatsCard />

        {/* Third Row - Split View */}
        <div className="grid gap-6 lg:grid-cols-2">
          <InvitesSummaryCard />
          <StreamingSummaryCard />
        </div>

        {/* Fourth Row - Split View */}
        <div className="grid gap-6 lg:grid-cols-2">
          <ActiveStreamsCard />
          <HistoryCard />
        </div>
      </DashboardLayout>
      <ServersModal open={serversModalOpen} onClose={() => setServersModalOpen(false)} />
    </>
  );
};

export default DashboardPage;
