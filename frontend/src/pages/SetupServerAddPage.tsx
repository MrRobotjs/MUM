import { useMemo } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ServerAddForm } from '../components/servers';
import { usePlugins } from '../hooks/usePlugins';
import { useServers } from '../hooks/useServers';
import { SetupLayout } from './SetupLayout';

function SetupServerAddContent() {
  const { pluginId } = useParams({ from: '/setup/plugins/$pluginId/servers/add' });
  const navigate = useNavigate();
  const { refresh: refreshServers } = useServers({ serviceType: pluginId || undefined });

  const handleSuccess = async () => {
    await refreshServers();
    navigate({ to: '/setup/plugins/$pluginId', params: { pluginId } });
  };

  const handleCancel = () => {
    navigate({ to: '/setup/plugins/$pluginId', params: { pluginId } });
  };

  return (
    <div className="space-y-6">
      <ServerAddForm
        pluginId={pluginId}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
      />
    </div>
  );
}

export default function SetupServerAddPage() {
  const { pluginId } = useParams({ from: '/setup/plugins/$pluginId/servers/add' });
  const { plugins } = usePlugins();
  const plugin = useMemo(
    () => plugins.find((item) => item.pluginId === pluginId),
    [plugins, pluginId]
  );

  return (
    <SetupLayout
      stepId="plugins"
      title={plugin ? `Add ${plugin.name} Server` : 'Add Server'}
      subtitle="Configure a new server for this media service plugin."
    >
      <SetupServerAddContent />
    </SetupLayout>
  );
}
