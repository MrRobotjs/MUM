import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { IconWifi, IconCheck, IconX } from '@tabler/icons-react';
import { PageHeader } from '../components';
import { FormField } from '../components';
import { useServers, useServerDetail } from '../hooks/useServers';
import { usePlugins } from '../hooks/usePlugins';
import { useAlerts } from '../contexts';
import { requestJson } from '../util/apiClient';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

type ConnectionTestStatus = 'idle' | 'testing' | 'success' | 'error';

type ServerFormValues = {
  server_nickname: string;
  server_name?: string;
  service_type: string;
  url: string;
  api_key?: string;
  public_url?: string;
  overseerr_url?: string;
  overseerr_api_key?: string;
  overseerr_enabled?: boolean;
  is_active: boolean;
  websocket_refresh_interval?: number;
};

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

export const ServerEditPage = () => {
  const { pluginId = '', serverId = '' } = useParams<{ pluginId: string; serverId: string }>();
  const navigate = useNavigate();
  const { success, error: showError } = useAlerts();
  const { plugins } = usePlugins();
  const { refresh: refreshServers } = useServers({ serviceType: pluginId || undefined });
  const { server, loading: serverLoading, error: serverError } = useServerDetail(Number(serverId));

  const plugin = useMemo(() => plugins.find((item) => item.pluginId === pluginId), [plugins, pluginId]);

  const [values, setValues] = useState<ServerFormValues>({
    server_nickname: '',
    server_name: '',
    service_type: pluginId || 'plex',
    url: '',
    api_key: '',
    public_url: '',
    overseerr_url: '',
    overseerr_api_key: '',
    overseerr_enabled: false,
    is_active: true,
    websocket_refresh_interval: 30,
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionTestStatus, setConnectionTestStatus] = useState<ConnectionTestStatus>('idle');

  useEffect(() => {
    if (server) {
      setValues({
        server_nickname: server.server_nickname,
        server_name: server.server_name || '',
        service_type: server.service_type,
        url: server.url,
        api_key: '',
        public_url: server.public_url || '',
        overseerr_url: server.overseerr_url || '',
        overseerr_api_key: '',
        overseerr_enabled: server.overseerr_enabled ?? false,
        is_active: server.is_active,
        websocket_refresh_interval:
          server.service_type === 'plex'
            ? server.websocket_refresh_interval ?? 30
            : undefined,
      });
    }
  }, [server]);

  const handleTestConnection = async () => {
    setConnectionTestStatus('testing');
    setError(null);

    try {
      const testData: any = {
        name: values.server_nickname,
        url: values.url,
        service_type: values.service_type,
      };

      if (values.api_key) {
        testData.api_key = values.api_key;
      }

      if (values.overseerr_enabled) {
        testData.overseerr_enabled = true;
        testData.overseerr_url = values.overseerr_url || '';
        testData.overseerr_api_key = values.overseerr_api_key || '';
      }

      const response = await requestJson(`/admin/api/v1/setup/plugins/${values.service_type}/test-connection`, {
        method: 'POST',
        body: JSON.stringify(testData),
      });

      if (response.success) {
        let message = response.message;

        if (response.overseerr) {
          if (response.overseerr.success) {
            message += ` | Overseerr: ${response.overseerr.message}`;
            if (response.overseerr.linked_users && response.overseerr.linked_users.length > 0) {
              const linkedCount = response.overseerr.linked_users.filter((u: any) => u.is_linked).length;
              message += ` (${linkedCount} users linked)`;
            }
          } else {
            setConnectionTestStatus('error');
            showError(`Overseerr connection failed: ${response.overseerr.message}`);
            return;
          }
        }

        setConnectionTestStatus('success');
        success(`Connection successful: ${message}`);

        setTimeout(() => {
          setConnectionTestStatus('idle');
        }, 3000);
      } else {
        setConnectionTestStatus('error');
        showError(`Connection test failed: ${response.message}`);
      }
    } catch (err) {
      setConnectionTestStatus('error');
      showError(`Error testing connection: ${(err as Error).message}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (values.service_type === 'plex') {
      const interval = values.websocket_refresh_interval ?? 30;
      if (!Number.isFinite(interval) || interval < 2 || interval > 300) {
        showError('WebSocket refresh interval must be between 2 and 300 seconds.');
        return;
      }
    }

    const payload = normalizeServerPayload(values, pluginId);

    try {
      setSubmitting(true);
      await requestJson(`/admin/api/v1/servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      success(`Server "${values.server_nickname}" updated`);
      await refreshServers();
      navigate(`/admin/settings/plugins/${pluginId}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to save server');
      showError(`Failed to save server: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFieldChange = (field: keyof ServerFormValues, value: any) => {
    setValues((prev) => {
      const updated: ServerFormValues = { ...prev, [field]: value };

      if (field === 'service_type') {
        if (value === 'plex') {
          if (!updated.websocket_refresh_interval || updated.websocket_refresh_interval < 2) {
            updated.websocket_refresh_interval = 30;
          }
        } else {
          updated.websocket_refresh_interval = undefined;
        }
      }

      if (field === 'websocket_refresh_interval') {
        updated.websocket_refresh_interval = Number(value);
      }

      return updated;
    });
  };

  const handleCancel = () => {
    navigate(`/admin/settings/plugins/${pluginId}`);
  };

  if (serverLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Loading..."
          description="Fetching server details"
        />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading server details...
        </div>
      </div>
    );
  }

  if (serverError || !server) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={handleCancel}>
          ← Back
        </Button>
        <Alert variant="destructive">
          <AlertTitle>Server not found</AlertTitle>
          <AlertDescription>
            {serverError ? (serverError as Error).message : 'The requested server could not be found.'}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const serviceTypes = [
    { value: 'plex', label: 'Plex' },
    { value: 'jellyfin', label: 'Jellyfin' },
    { value: 'emby', label: 'Emby' },
    { value: 'kavita', label: 'Kavita' },
    { value: 'audiobookshelf', label: 'AudioBookshelf' },
    { value: 'komga', label: 'Komga' },
    { value: 'romm', label: 'RomM' },
  ];

  const getTestButtonContent = () => {
    if (connectionTestStatus === 'testing') {
      return (
        <>
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          Testing...
        </>
      );
    }
    if (connectionTestStatus === 'success') {
      return (
        <>
          <IconCheck className="size-4" />
          Connection Successful
        </>
      );
    }
    if (connectionTestStatus === 'error') {
      return (
        <>
          <IconX className="size-4" />
          Connection Failed
        </>
      );
    }
    return (
      <>
        <IconWifi className="size-4" />
        Test Connection
      </>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit Server: ${server.server_nickname}`}
        description={`Modify settings for this ${plugin?.name || pluginId} server`}
      />

      <form id="server-edit-form" onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

            <FormField id="server_nickname" label="Server Nickname" required>
              <Input
                id="server_nickname"
                type="text"
                value={values.server_nickname}
                onChange={(e) => setValues({ ...values, server_nickname: e.target.value })}
                required
                placeholder="My Plex Server"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Friendly name for this server (used in UI)
              </p>
            </FormField>

            <FormField id="service_type" label="Service Type" required>
              <div className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs md:text-sm">
                <span className="text-sm">
                  {serviceTypes.find((type) => type.value === values.service_type)?.label ?? values.service_type}
                </span>
                <Badge variant="secondary">Locked</Badge>
              </div>
            </FormField>

            <FormField id="url" label="Server URL" required>
              <Input
                id="url"
                type="url"
                value={values.url}
                onChange={(e) => handleFieldChange('url', e.target.value)}
                required
                placeholder="https://plex.example.com:32400"
              />
            </FormField>

            <FormField id="api_key" label="API Key">
              <Input
                id="api_key"
                type="password"
                value={values.api_key}
                onChange={(e) => handleFieldChange('api_key', e.target.value)}
                placeholder="••••••••"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave blank to keep existing key
              </p>
            </FormField>

            <FormField id="server_name" label="Server Name (Optional)">
              <Input
                id="server_name"
                type="text"
                value={values.server_name}
                onChange={(e) => setValues({ ...values, server_name: e.target.value })}
                placeholder="Actual server name from service"
              />
            </FormField>

            <FormField id="public_url" label="Public URL (Optional)">
              <Input
                id="public_url"
                type="url"
                value={values.public_url}
                onChange={(e) => setValues({ ...values, public_url: e.target.value })}
                placeholder="https://public.example.com"
              />
            </FormField>

            {values.service_type === 'plex' ? (
              <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-2">
                <FormField
                  id="websocket_refresh_interval"
                  label="WebSocket refresh interval (seconds)"
                  description="How often to re-sync live playback progress while using Plex WebSocket updates."
                >
                  <Input
                    id="websocket_refresh_interval"
                    type="number"
                    min={2}
                    max={300}
                    step={1}
                    value={values.websocket_refresh_interval ?? 30}
                    onChange={(e) => handleFieldChange('websocket_refresh_interval', Number(e.target.value))}
                  />
                </FormField>
                <p className="text-xs text-muted-foreground">
                  Lower intervals can make progress jump backward or forward because Plex periodically reports inconsistent
                  timestamps when polled too frequently.
                </p>
              </div>
            ) : null}

            <div className="flex items-center gap-4 my-4">
              <Separator className="flex-1" />
              <span className="text-sm font-medium text-muted-foreground">Overseerr Integration (Optional)</span>
              <Separator className="flex-1" />
            </div>

            <FormField id="overseerr_enabled" label="Overseerr Integration">
              <div className="flex items-center gap-3">
                <Switch
                  id="overseerr_enabled"
                  checked={values.overseerr_enabled ?? false}
                  onCheckedChange={(checked) => setValues({ ...values, overseerr_enabled: checked })}
                />
                <Label htmlFor="overseerr_enabled" className="cursor-pointer">
                  Enable Overseerr integration
                </Label>
              </div>
            </FormField>

            {values.overseerr_enabled && (
              <>
                <FormField id="overseerr_url" label="Overseerr URL">
                  <Input
                    id="overseerr_url"
                    type="url"
                    value={values.overseerr_url}
                    onChange={(e) => setValues({ ...values, overseerr_url: e.target.value })}
                    placeholder="https://overseerr.example.com"
                  />
                </FormField>

                <FormField id="overseerr_api_key" label="Overseerr API Key">
                  <Input
                    id="overseerr_api_key"
                    type="password"
                    value={values.overseerr_api_key}
                    onChange={(e) => setValues({ ...values, overseerr_api_key: e.target.value })}
                    placeholder={server.overseerr_api_key ? '••••••••' : 'Overseerr API key'}
                  />
                </FormField>
              </>
            )}

            <FormField id="is_active" label="Status">
              <div className="flex items-center gap-3">
                <Switch
                  id="is_active"
                  checked={values.is_active}
                  onCheckedChange={(checked) => setValues({ ...values, is_active: checked })}
                />
                <Label htmlFor="is_active" className="cursor-pointer">
                  Active
                </Label>
              </div>
            </FormField>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={handleCancel} type="button">
            Cancel
          </Button>
          <Button
            variant={connectionTestStatus === 'success' ? 'default' : connectionTestStatus === 'error' ? 'destructive' : 'outline'}
            onClick={handleTestConnection}
            disabled={connectionTestStatus === 'testing' || submitting}
            type="button"
          >
            {getTestButtonContent()}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </form>
    </div>
  );
};
