import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePlugins } from '../hooks/usePlugins';
import { useServers, type Server } from '../hooks/useServers';
import { ServerModal, type ServerFormValues } from '../components/servers';
import { PageHeader } from '../components';
import { useAlerts } from '../contexts';
import { requestJson } from '../util/apiClient';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { IconAlertCircle, IconInfoCircle } from '@tabler/icons-react';

const normalizeServerPayload = (values: ServerFormValues, pluginId: string) => {
  const payload: Record<string, unknown> = {
    server_nickname: values.server_nickname,
    server_name: values.server_name || null,
    service_type: pluginId,
    url: values.url,
    public_url: values.public_url || null,
    is_active: values.is_active,
    overseerr_enabled: values.overseerr_enabled ?? false,
    overseerr_url: values.overseerr_url || null
  };

  if (values.api_key) {
    payload.api_key = values.api_key;
  }

  if (values.overseerr_api_key) {
    payload.overseerr_api_key = values.overseerr_api_key;
  }

  if (pluginId === 'plex') {
    payload.websocket_refresh_interval = values.websocket_refresh_interval ?? 30;
  }

  return payload;
};

export const PluginDetailPage = () => {
  const { pluginId = '' } = useParams<{ pluginId: string }>();
  const navigate = useNavigate();
  const { plugins, loading: pluginsLoading, error: pluginsError, refresh: refreshPlugins } = usePlugins();
  const plugin = useMemo(() => plugins.find((item) => item.pluginId === pluginId), [plugins, pluginId]);
  const {
    servers,
    loading: serversLoading,
    error: serversError,
    refresh: refreshServers
  } = useServers({ serviceType: pluginId || undefined });
  const { success, error: showError } = useAlerts();

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleCloseModal = () => {
    setModalOpen(false);
  };

  const handleAddServer = () => {
    setModalOpen(true);
  };

  const handleToggleServerStatus = async (server: Server) => {
    const newStatus = !server.is_active;
    try {
      await requestJson(`/admin/api/v1/servers/${server.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: newStatus })
      });
      success(`Server "${server.server_nickname}" ${newStatus ? 'enabled' : 'disabled'}`);
      await Promise.all([refreshServers(), refreshPlugins()]);
    } catch (err) {
      showError(`Failed to update server status: ${(err as Error).message}`);
    }
  };

  const handleDeleteServer = async (server: Server) => {
    if (!confirm(`Remove server "${server.server_nickname}" from ${plugin?.name || 'plugin'}?`)) {
      return;
    }

    try {
      await requestJson(`/admin/api/v1/servers/${server.id}`, {
        method: 'DELETE'
      });
      success(`Server "${server.server_nickname}" removed`);
      await Promise.all([refreshServers(), refreshPlugins()]);
    } catch (err) {
      showError(`Failed to delete server: ${(err as Error).message}`);
    }
  };

  const handleSubmit = async (formValues: ServerFormValues) => {
    if (!pluginId) {
      showError('Unknown plugin id');
      return;
    }

    const payload = normalizeServerPayload(formValues, pluginId);

    try {
      setSaving(true);
      await requestJson('/admin/api/v1/servers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      success(`Server "${formValues.server_nickname}" added`);

      await Promise.all([refreshServers(), refreshPlugins()]);
      handleCloseModal();
    } catch (err) {
      showError(`Failed to save server: ${(err as Error).message}`);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  if (pluginsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        Loading plugin details…
      </div>
    );
  }

  if (pluginsError) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle />
        <AlertTitle>Failed to load plugins</AlertTitle>
        <AlertDescription>{(pluginsError as Error).message}</AlertDescription>
      </Alert>
    );
  }

  if (!plugin) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate('/admin/settings/plugins')}>
          ← Back to Plugins
        </Button>
        <Alert variant="destructive">
          <IconAlertCircle />
          <AlertTitle>Plugin not found</AlertTitle>
          <AlertDescription>Plugin "{pluginId}" could not be located.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const configuredCount = servers.length;

  const headerActions = (
    <Button onClick={handleAddServer}>
      Add Server
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${plugin.name} Servers`}
        description="Configure media servers linked to this plugin."
        actions={headerActions}
      />

      <Card>
        <CardHeader className="space-y-1">
          <CardTitle>Plugin details</CardTitle>
          <CardDescription>
            {plugin.description || 'No description provided.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Author</dt>
              <dd className="text-foreground">{plugin.author ?? 'Unknown'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">License</dt>
              <dd className="text-foreground">{plugin.license ?? 'Not specified'}</dd>
            </div>
            {plugin.repository_url ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Repository</dt>
                <dd>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={plugin.repository_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {plugin.repository_url}
                  </a>
                </dd>
              </div>
            ) : null}
            {plugin.homepage ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Homepage</dt>
                <dd>
                  <a
                    className="text-primary underline underline-offset-4"
                    href={plugin.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {plugin.homepage}
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>

          {plugin.supportedFeatures.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {plugin.supportedFeatures.map((feature) => (
                <Badge key={feature} variant="outline" className="text-xs">
                  {feature.replace(/_/g, ' ')}
                </Badge>
              ))}
            </div>
          ) : null}

          {plugin.lastError ? (
            <Alert variant="destructive">
              <IconAlertCircle />
              <AlertTitle>Plugin warning</AlertTitle>
              <AlertDescription>{plugin.lastError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Configured servers</CardTitle>
            <CardDescription>Servers currently linked to this plugin.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => refreshServers()}>
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {serversError ? (
            <Alert variant="destructive">
              <IconAlertCircle />
              <AlertTitle>Failed to load servers</AlertTitle>
              <AlertDescription>{(serversError as Error).message}</AlertDescription>
            </Alert>
          ) : null}

          {serversLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
              Loading servers…
            </div>
          ) : servers.length === 0 ? (
            <Alert variant="info">
              <IconInfoCircle />
              <AlertTitle>No servers configured</AlertTitle>
              <AlertDescription>
                There are no servers linked to this plugin yet.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {servers.map((server) => (
                <Card key={server.id} className="border border-border/60">
                  <CardHeader className="flex flex-row items-start justify-between gap-4">
                    <div>
                      <CardTitle className="text-base">
                        {server.server_nickname}
                      </CardTitle>
                      <CardDescription>
                        {server.server_name ?? 'No remote name'}
                      </CardDescription>
                    </div>
                    <Badge variant={server.is_active ? 'success' : 'outline'}>
                      {server.is_active ? 'Active' : 'Inactive'}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm text-muted-foreground">
                    <div>
                      <span className="font-medium text-foreground">URL:</span>{' '}
                      <a
                        className="text-primary underline underline-offset-4 break-all"
                        href={server.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {server.url}
                      </a>
                    </div>
                    {server.public_url ? (
                      <div>
                        <span className="font-medium text-foreground">Public URL:</span>{' '}
                        <a
                          className="text-primary underline underline-offset-4 break-all"
                          href={server.public_url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {server.public_url}
                        </a>
                      </div>
                    ) : null}
                    {server.service_type === 'plex' ? (
                      <div>
                        <span className="font-medium text-foreground">WebSocket refresh:</span>{' '}
                        {(server.websocket_refresh_interval ?? 30).toString()}s
                      </div>
                    ) : null}
                    {server.last_sync_at ? (
                      <div>
                        <span className="font-medium text-foreground">Last Sync:</span>{' '}
                        {new Date(server.last_sync_at).toLocaleString()}
                      </div>
                    ) : null}
                    {server.overseerr_enabled ? (
                      <div>
                        <span className="font-medium text-foreground">Overseerr:</span>{' '}
                        {server.overseerr_url ? (
                          <a
                            className="text-primary underline underline-offset-4 break-all"
                            href={server.overseerr_url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {server.overseerr_url}
                          </a>
                        ) : (
                          'Enabled'
                        )}
                      </div>
                    ) : null}

                    <Separator />

                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Switch
                          id={`server-${server.id}-status`}
                          checked={server.is_active}
                          onCheckedChange={() => handleToggleServerStatus(server)}
                        />
                        <Label htmlFor={`server-${server.id}-status`} className="text-sm cursor-pointer">
                          {server.is_active ? 'Enabled' : 'Disabled'}
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" onClick={() => navigate(`/admin/settings/plugins/${pluginId}/servers/${server.id}`)}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDeleteServer(server)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ServerModal
        open={modalOpen}
        onClose={handleCloseModal}
        onSubmit={handleSubmit}
        loading={saving}
        serviceTypeLocked
        defaultServiceType={pluginId}
      />
    </div>
  );
};

export default PluginDetailPage;
