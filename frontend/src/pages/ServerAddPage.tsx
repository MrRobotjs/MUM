import { useMemo } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components';
import { ServerAddForm } from '../components/servers';
import { usePlugins } from '../hooks/usePlugins';
import { useServers } from '../hooks/useServers';

export const ServerAddPage = () => {
  const { pluginId } = useParams({ from: '/admin/settings/plugins/$pluginId/servers/add' });
  const navigate = useNavigate();
  const { plugins } = usePlugins();
  const { refresh: refreshServers } = useServers({ serviceType: pluginId || undefined });

  const plugin = useMemo(() => plugins.find((item) => item.pluginId === pluginId), [plugins, pluginId]);

  const handleSuccess = async () => {
    await refreshServers();
    navigate({ to: '/admin/settings/plugins/$pluginId', params: { pluginId } });
  };

  const handleCancel = () => {
    navigate({ to: '/admin/settings/plugins/$pluginId', params: { pluginId } });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Add ${plugin?.name || 'Server'} Server`}
        description={`Configure a new ${plugin?.name || pluginId} server`}
      />

      <ServerAddForm
        pluginId={pluginId}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default ServerAddPage;
