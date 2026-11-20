import { useMemo } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ServerAddForm } from '../components/servers';
import { useMediaServices } from '../hooks/useMediaServices';
import { useServers } from '../hooks/useServers';
import { SetupLayout } from './SetupLayout';

function SetupServerAddContent() {
  const { serviceId } = useParams({ from: '/setup/media-servers/$serviceId/servers/add' });
  const navigate = useNavigate();
  const { refresh: refreshServers } = useServers({ serviceType: serviceId || undefined });

  const handleSuccess = async () => {
    await refreshServers();
    navigate({ to: '/setup/media-servers/$serviceId', params: { serviceId } });
  };

  const handleCancel = () => {
    navigate({ to: '/setup/media-servers/$serviceId', params: { serviceId } });
  };

  const submitEndpoint = serviceId
    ? `/api/providers/${serviceId}/servers`
    : '/api/servers';

  return (
    <div className="space-y-6">
      <ServerAddForm
        serviceId={serviceId}
        submitEndpoint={submitEndpoint}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
      />
    </div>
  );
}

export default function SetupServerAddPage() {
  const { serviceId } = useParams({ from: '/setup/media-servers/$serviceId/servers/add' });
  const { services } = useMediaServices();
  const service = useMemo(
    () => services.find((item) => item.id === serviceId),
    [services, serviceId]
  );

  return (
    <SetupLayout
      stepId="media-servers"
      title={service ? `Add ${service.name} Server` : 'Add Server'}
      subtitle="Configure a new server for this media service."
    >
      <SetupServerAddContent />
    </SetupLayout>
  );
}
