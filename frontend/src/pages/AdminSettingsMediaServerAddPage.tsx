import { useNavigate, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components';
import { ServerAddForm } from '../components/servers';
import { useMediaServices } from '../hooks/useMediaServices';
import { useServers } from '../hooks/useServers';

/** Adds a server to one media service. */
export const AdminSettingsMediaServerAddPage = () => {
  const { serviceId } = useParams({ from: '/admin/settings/media-servers/$serviceId/servers/add' });
  const navigate = useNavigate();
  const { services } = useMediaServices();
  const { refresh: refreshServers } = useServers({ serviceType: serviceId || undefined });
  const service = services.find((item) => item.id === serviceId);

  const backToService = () => navigate({ to: '/admin/settings/media-servers/$serviceId', params: { serviceId } });
  const handleSuccess = async () => {
    await refreshServers();
    backToService();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Add ${service?.name || 'Server'} Server`}
        description={`Configure a new ${service?.name || serviceId} server`}
      />
      <ServerAddForm serviceId={serviceId} onSuccess={handleSuccess} onCancel={backToService} />
    </div>
  );
};

export default AdminSettingsMediaServerAddPage;
