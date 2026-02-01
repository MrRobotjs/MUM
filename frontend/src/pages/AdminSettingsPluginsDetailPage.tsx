import { useMemo } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { usePlugins } from '../hooks/usePlugins';
import { PluginConfiguration } from '../components/plugins';
import { PageHeader } from '../components';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

export const AdminSettingsPluginsDetailPage = () => {
  const { pluginId } = useParams({ from: '/admin/settings/plugins/$pluginId' });
  const resolvedPluginId = pluginId ?? '';
  const navigate = useNavigate();
  const { plugins, loading: pluginsLoading, error: pluginsError, refresh: refreshPlugins } = usePlugins();
  const plugin = useMemo(() => plugins.find((item) => item.pluginId === resolvedPluginId), [plugins, resolvedPluginId]);

  if (pluginsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4 text-muted-foreground" />
        Loading plugin details…
      </div>
    );
  }

  if (pluginsError) {
    return (
      <Alert variant="destructive">
        <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
        <AlertTitle>Failed to load plugins</AlertTitle>
        <AlertDescription>{(pluginsError as Error).message}</AlertDescription>
      </Alert>
    );
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate({ to: '/admin/settings/plugins' })}>
          ← Back to Plugins
        </Button>
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Plugin not found</AlertTitle>
          <AlertDescription>Plugin "{resolvedPluginId}" could not be located.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${plugin.name} Servers`}
        description="Configure media servers linked to this plugin."
      />

      <PluginConfiguration
        plugin={plugin}
        pluginId={resolvedPluginId}
        onServerAdded={() => refreshPlugins()}
        showEditButton={true}
      />
    </div>
  );
};

export default AdminSettingsPluginsDetailPage;
