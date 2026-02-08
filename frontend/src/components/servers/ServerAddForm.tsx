import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faWifi, faCheck, faXmark, faCircleExclamation } from '@fortawesome/free-solid-svg-icons';
import { FormField } from '../';
import { useAlerts } from '../../contexts';
import { requestJson } from '../../util/apiClient';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SERVICE_TYPES } from '@/config/pluginMetadata';
import { Spinner } from '@/components/ui/spinner'

type ConnectionTestStatus = 'idle' | 'testing' | 'success' | 'error';

export type ServerFormValues = {
  server_nickname: string;
  service_type: string;
  url: string;
  api_key?: string;
  username?: string;
  password?: string;
  public_url?: string;
  jellyfin_owner_user_id?: string;
  overseerr_url?: string;
  overseerr_api_key?: string;
  overseerr_enabled?: boolean;
  is_active: boolean;
  websocket_refresh_interval?: number;
};

const normalizeServerPayload = (values: ServerFormValues, pluginId: string) => {
  const payload: Record<string, unknown> = {
    server_nickname: values.server_nickname,
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

  if (values.username) {
    payload.username = values.username;
  }

  if (values.password) {
    payload.password = values.password;
  }

  if (values.overseerr_api_key) {
    payload.overseerr_api_key = values.overseerr_api_key;
  }

  if (pluginId === 'plex') {
    payload.websocket_refresh_interval = values.websocket_refresh_interval ?? 30;
  }

  if (pluginId === 'jellyfin') {
    const ownerId = values.jellyfin_owner_user_id?.trim();
    if (ownerId) {
      payload.jellyfin_owner_user_id = ownerId;
    }
  }

  return payload;
};

export interface ServerAddFormProps {
  pluginId: string;
  onSuccess: () => void;
  onCancel: () => void;
  submitEndpoint?: string;
}

export const ServerAddForm = ({ pluginId, onSuccess, onCancel, submitEndpoint }: ServerAddFormProps) => {
  const { success, error: showError } = useAlerts();

  const [values, setValues] = useState<ServerFormValues>({
    server_nickname: '',
    service_type: pluginId || 'plex',
    url: '',
    api_key: '',
    username: '',
    password: '',
    public_url: '',
    jellyfin_owner_user_id: '',
    overseerr_url: '',
    overseerr_api_key: '',
    overseerr_enabled: false,
    is_active: true,
    websocket_refresh_interval: 30,
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionTestStatus, setConnectionTestStatus] = useState<ConnectionTestStatus>('idle');
  const [activeTab, setActiveTab] = useState<'details' | 'overseerr'>('details');

  const handleTestConnection = async () => {
    setConnectionTestStatus('testing');
    setError(null);

    try {
      const isRomm = values.service_type === 'romm';
      if (isRomm && (!values.username?.trim() || !values.password)) {
        setConnectionTestStatus('error');
        showError('RomM requires a username and password.');
        return;
      }

      const testData: any = {
        name: values.server_nickname,
        url: values.url,
        service_type: values.service_type,
      };

      if (values.api_key) {
        testData.api_key = values.api_key;
      }

      if (values.username) {
        testData.username = values.username;
      }

      if (values.password) {
        testData.password = values.password;
      }

      if (values.overseerr_enabled) {
        testData.overseerr_enabled = true;
        testData.overseerr_url = values.overseerr_url || '';
        testData.overseerr_api_key = values.overseerr_api_key || '';
      }

      const response = await requestJson(`/api/v2/setup/plugins/${values.service_type}/test-connection`, {
        method: 'POST',
        body: JSON.stringify(testData),
      });

      const payload = response?.data || response;

      if (payload?.success) {
        let message = payload.message || 'Connection successful';

        if (payload.overseerr) {
          if (payload.overseerr.success) {
            message += ` | Overseerr: ${payload.overseerr.message}`;
            if (payload.overseerr.linked_users && payload.overseerr.linked_users.length > 0) {
              const linkedCount = payload.overseerr.linked_users.filter((u: any) => u.is_linked).length;
              message += ` (${linkedCount} users linked)`;
            }
          } else {
            setConnectionTestStatus('error');
            showError(`Overseerr connection failed: ${payload.overseerr.message || 'Unknown error'}`);
            return;
          }
        }

        setConnectionTestStatus('success');
        success(message);

        setTimeout(() => {
          setConnectionTestStatus('idle');
        }, 3000);
      } else {
        setConnectionTestStatus('error');
        showError(`Connection test failed: ${payload?.message || 'Unknown error'}`);
      }
    } catch (err) {
      setConnectionTestStatus('error');
      showError(`Error testing connection: ${(err as Error).message}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const isRomm = values.service_type === 'romm';
    if (isRomm && (!values.username?.trim() || !values.password)) {
      showError('RomM requires a username and password.');
      return;
    }

    if (values.service_type === 'plex') {
      const interval = values.websocket_refresh_interval ?? 30;
      if (!Number.isFinite(interval) || interval < 2 || interval > 300) {
        showError('WebSocket refresh interval must be between 2 and 300 seconds.');
        return;
      }
    }

    const payload = normalizeServerPayload(values, pluginId);
    const endpoint = submitEndpoint || '/api/v2/servers';

    try {
      setSubmitting(true);
      await requestJson(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      success(`Server "${values.server_nickname}" added`);
      onSuccess();
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
        if (value === 'romm') {
          updated.api_key = '';
        }
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

  const getTestButtonContent = () => {
    if (connectionTestStatus === 'testing') {
      return (
        <>
          <Spinner className="size-4" />
          Testing...
        </>
      );
    }
    if (connectionTestStatus === 'success') {
      return (
        <>
          <FontAwesomeIcon icon={faCheck} className="size-4" />
          Connection Successful
        </>
      );
    }
    if (connectionTestStatus === 'error') {
      return (
        <>
          <FontAwesomeIcon icon={faXmark} className="size-4" />
          Connection Failed
        </>
      );
    }
    return (
      <>
        <FontAwesomeIcon icon={faWifi} className="size-4" />
        Test Connection
      </>
    );
  };

  const isRomm = values.service_type === 'romm';

  return (
    <form id="server-add-form" onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <FontAwesomeIcon icon={faCircleExclamation} className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as 'details' | 'overseerr')}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="details">Details</TabsTrigger>
          {values.service_type === 'plex' && (
            <TabsTrigger value="overseerr">Overseerr</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="details" className="mt-6">
          <Card>
            <CardContent>
              <div className="space-y-4">
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
                      {SERVICE_TYPES.find((type) => type.value === values.service_type)?.label ?? values.service_type}
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

                {isRomm ? (
                  <>
                    <FormField id="username" label="Username" required>
                      <Input
                        id="username"
                        type="text"
                        value={values.username ?? ''}
                        onChange={(e) => handleFieldChange('username', e.target.value)}
                        placeholder="RomM username"
                        required
                      />
                    </FormField>
                    <FormField id="password" label="Password" required>
                      <Input
                        id="password"
                        type="password"
                        value={values.password ?? ''}
                        onChange={(e) => handleFieldChange('password', e.target.value)}
                        placeholder="RomM password"
                        required
                      />
                    </FormField>
                  </>
                ) : (
                  <FormField id="api_key" label="API Key">
                    <Input
                      id="api_key"
                      type="password"
                      value={values.api_key}
                      onChange={(e) => handleFieldChange('api_key', e.target.value)}
                      placeholder="Enter API key"
                    />
                  </FormField>
                )}

                {values.service_type === 'jellyfin' ? (
                  <FormField
                    id="jellyfin_owner_user_id"
                    label="Owner ID (Optional)"
                    description="Jellyfin app tokens are not user-scoped. Provide the owner user ID to enable Owner role detection."
                  >
                    <Input
                      id="jellyfin_owner_user_id"
                      type="text"
                      value={values.jellyfin_owner_user_id ?? ''}
                      onChange={(e) => handleFieldChange('jellyfin_owner_user_id', e.target.value)}
                      placeholder="e.g. 811aef0f3fed4fccbaf491c3715acabb"
                    />
                  </FormField>
                ) : null}

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
        </TabsContent>

        {values.service_type === 'plex' && (
          <TabsContent value="overseerr" className="mt-6">
            <Card>
              <CardContent>
                <div className="space-y-4">
                  <FormField id="overseerr_enabled" label="Overseerr Integration">
                    <div className="flex items-center gap-3">
                      <Switch
                        id="overseerr_enabled"
                        checked={values.overseerr_enabled ?? false}
                        onCheckedChange={(checked) => setValues({ ...values, overseerr_enabled: checked })}
                      />
                      <Label htmlFor="overseerr_enabled" className="cursor-pointer">
                        Enable Plex Overseerr integration
                      </Label>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Link this Plex server to Overseerr for request management
                    </p>
                  </FormField>

                  {values.overseerr_enabled && (
                    <>
                      <FormField id="overseerr_url" label="Overseerr URL" required>
                        <Input
                          id="overseerr_url"
                          type="url"
                          value={values.overseerr_url}
                          onChange={(e) => setValues({ ...values, overseerr_url: e.target.value })}
                          placeholder="https://overseerr.example.com"
                        />
                      </FormField>

                      <FormField id="overseerr_api_key" label="Overseerr API Key" required>
                        <Input
                          id="overseerr_api_key"
                          type="password"
                          value={values.overseerr_api_key}
                          onChange={(e) => setValues({ ...values, overseerr_api_key: e.target.value })}
                          placeholder="Overseerr API key"
                        />
                      </FormField>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      <div className="flex items-center justify-end gap-3">
        <Button variant="ghost" onClick={onCancel} type="button">
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
        <Button type="submit" disabled={submitting || connectionTestStatus !== 'success'}>
          {submitting ? 'Adding…' : 'Add Server'}
        </Button>
      </div>
    </form>
  );
};

export default ServerAddForm;
