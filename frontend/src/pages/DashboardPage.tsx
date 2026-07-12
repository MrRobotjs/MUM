import { useState } from 'react';
import { DashboardLayout } from '../components/dashboard/DashboardLayout';
import { ServersModal } from '../components/dashboard/ServersModal';
import {
  KpiStrip,
  LiveStreamsWidget,
  PluginStatusWidget,
  UsersInvitesWidget,
  StreamingOverviewWidget,
  HistoryWidget,
  WatchStatsWidget,
} from '../components/dashboard/widgets';

export const DashboardPage = () => {
  const [serversModalOpen, setServersModalOpen] = useState(false);

  return (
    <>
      <DashboardLayout>
        <KpiStrip />

        <LiveStreamsWidget />
        <PluginStatusWidget onViewAll={() => setServersModalOpen(true)} />
        <UsersInvitesWidget />

        <StreamingOverviewWidget />
        <HistoryWidget />

        <WatchStatsWidget />
      </DashboardLayout>

      <ServersModal open={serversModalOpen} onClose={() => setServersModalOpen(false)} />
    </>
  );
};

export default DashboardPage;
