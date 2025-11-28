import { useState, useEffect } from 'react';
import { IconWifi, IconCheck, IconX, IconAlertCircle } from '@tabler/icons-react';
import { FormField } from '../';
import type { Server } from '../../hooks/useServers';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '../ui/alert';
import { requestJson } from '../../util/apiClient';
import { useAlerts } from '../../contexts';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { SERVICE_TYPES } from '@/config/pluginMetadata';

export type ServerFormValues = {
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

type ConnectionTestStatus = 'idle' | 'testing' | 'success' | 'error';

type ServerModalProps = {
  open: boolean;
  onClose: () => void;
  initialValues?: Server;
  onSubmit: (values: ServerFormValues) => Promise<void>;
  loading?: boolean;
  serviceTypeLocked?: boolean;
  defaultServiceType?: string;
};

export const ServerModal = ({
  open,
  onClose,
  initialValues,
  onSubmit,
  loading = false,
  serviceTypeLocked = false,
  defaultServiceType,
}: ServerModalProps) => {
  const [values, setValues] = useState<ServerFormValues>({
    server_nickname: '',
    server_name: '',
    service_type: 'plex',
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
  const [connectionTested, setConnectionTested] = useState(false);
  const { success: showSuccess, error: showError } = useAlerts();

  useEffect(() => {
    if (initialValues) {
      setValues({
        server_nickname: initialValues.server_nickname,
        server_name: initialValues.server_name || '',
        service_type: initialValues.service_type,
        url: initialValues.url,
        api_key: '',
        public_url: initialValues.public_url || '',
        overseerr_url: initialValues.overseerr_url || '',
        overseerr_api_key: '',
        overseerr_enabled: initialValues.overseerr_enabled ?? false,
        is_active: initialValues.is_active,
        websocket_refresh_interval:
          initialValues.service_type === 'plex'
            ? initialValues.websocket_refresh_interval ?? 30
            : undefined,
      });
    } else {
      setValues({
        server_nickname: '',
        server_name: '',
        service_type: defaultServiceType ?? 'plex',
        url: '',
        api_key: '',
        public_url: '',
        overseerr_url: '',
        overseerr_api_key: '',
        overseerr_enabled: false,
        is_active: true,
        websocket_refresh_interval: (defaultServiceType ?? 'plex') === 'plex' ? 30 : undefined,
      });
    }
    setError(null);
    setConnectionTestStatus('idle');
    setConnectionTested(false);
  }, [initialValues, open]);

  const handleTestConnection = async () => {
    setConnectionTestStatus('testing');
    setError(null);

    try {
      const testData: any = {
        name: values.server_nickname,
        url: values.url,
        service_type: values.service_type,
      };

      // Add API key if provided
      if (values.api_key) {
        testData.api_key = values.api_key;
      }

      // Add Overseerr fields if enabled
      if (values.overseerr_enabled) {
        testData.overseerr_enabled = true;
        testData.overseerr_url = values.overseerr_url || '';
        testData.overseerr_api_key = values.overseerr_api_key || '';
      }

      const response = await requestJson(`/admin/api/v2/setup/plugins/${values.service_type}/test-connection`, {
        method: 'POST',
        body: JSON.stringify(testData),
      });

      if (response.success) {
        let message = response.message;

        // Handle Overseerr results
        if (response.overseerr) {
          if (response.overseerr.success) {
            message += ` | Overseerr: ${response.overseerr.message}`;
            if (response.overseerr.linked_users && response.overseerr.linked_users.length > 0) {
              const linkedCount = response.overseerr.linked_users.filter((u: any) => u.is_linked).length;
              message += ` (${linkedCount} users linked)`;
            }
          } else {
            setConnectionTestStatus('error');
            setConnectionTested(false);
            showError(`Overseerr connection failed: ${response.overseerr.message}`);
            return;
          }
        }

        setConnectionTestStatus('success');
        setConnectionTested(true);
        showSuccess(`Connection successful: ${message}`);

        // Reset button to idle after 3 seconds
        setTimeout(() => {
          setConnectionTestStatus('idle');
        }, 3000);
      } else {
        setConnectionTestStatus('error');
        setConnectionTested(false);
        showError(`Connection test failed: ${response.message}`);
      }
    } catch (err) {
      setConnectionTestStatus('error');
      setConnectionTested(false);
      showError(`Error testing connection: ${(err as Error).message}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Require connection test for new servers
    if (!initialValues && !connectionTested) {
      showError('Please test the connection successfully before adding the server.');
      return;
    }

    if (values.service_type === 'plex') {
      const interval = values.websocket_refresh_interval ?? 30;
      if (!Number.isFinite(interval) || interval < 2 || interval > 300) {
        showError('WebSocket refresh interval must be between 2 and 300 seconds.');
        return;
      }
    }

    setError(null);
    setSubmitting(true);

    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      setError((err as Error).message || 'Failed to save server');
    } finally {
      setSubmitting(false);
    }
  };

  // Reset connection test when critical fields change
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

    // Reset connection test if critical fields change
    if (['url', 'api_key', 'service_type'].includes(field) && connectionTested) {
      setConnectionTested(false);
      setConnectionTestStatus('idle');
    }
  };

  const formId = 'server-form';

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

  const footer = [
    <Button
      key="cancel"
      type="button"
      variant="outline"
      onClick={onClose}
      disabled={submitting || loading}
    >
      Cancel
    </Button>,
    <Button
      key="test"
      type="button"
      variant={connectionTestStatus === 'success' ? 'default' : connectionTestStatus === 'error' ? 'destructive' : 'outline'}
      onClick={handleTestConnection}
      disabled={connectionTestStatus === 'testing' || submitting || loading}
    >
      {getTestButtonContent()}
    </Button>,
    <Button
      key="submit"
      type="submit"
      form={formId}
      disabled={submitting || loading || (!initialValues && !connectionTested)}
    >
      {submitting ? 'Saving…' : initialValues ? 'Save Changes' : 'Add Server'}
    </Button>,
  ];

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      onClose();
    }
  };

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={initialValues ? 'Edit Server' : 'Add Server'}
      footer={footer}
      contentClassName="max-w-3xl"
      bodyClassName="space-y-4"
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <IconAlertCircle />
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
          <p className="mt-1 text-xs text-muted-foreground">Friendly name for this server (used in UI)</p>
        </FormField>

        <FormField id="service_type" label="Service Type" required>
          {serviceTypeLocked ? (
            <div className="flex w-full items-center justify-between rounded-md border bg-muted/50 px-3 py-2">
              <span className="text-sm font-medium text-foreground">
                {SERVICE_TYPES.find((type) => type.value === values.service_type)?.label ?? values.service_type}
              </span>
              <Badge variant="outline">Locked</Badge>
            </div>
          ) : (
            <Select
              value={values.service_type}
              onValueChange={(value) => handleFieldChange('service_type', value)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select service" />
              </SelectTrigger>
              <SelectContent>
                {SERVICE_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
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
            placeholder={initialValues ? '••••••••' : 'API key or token'}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {initialValues ? 'Leave blank to keep existing key' : 'Required for most services'}
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
          <div className="rounded-lg border bg-muted/50 p-4 space-y-2">
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

        <div className="flex items-center gap-2 py-2">
          <span className="text-sm font-semibold text-muted-foreground">Overseerr Integration (Optional)</span>
          <div className="h-px flex-1 bg-border" />
        </div>

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
            placeholder={initialValues && initialValues.overseerr_api_key ? '••••••••' : 'Overseerr API key'}
          />
        </FormField>

        <FormField id="overseerr_enabled" label="Overseerr Integration">
          <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2">
            <Switch
              id="overseerr_enabled"
              checked={values.overseerr_enabled ?? false}
              onCheckedChange={(checked) => setValues({ ...values, overseerr_enabled: checked })}
            />
            <Label htmlFor="overseerr_enabled" className="text-sm font-medium text-foreground/80">
              Enable Overseerr integration
            </Label>
          </div>
        </FormField>

        <FormField id="is_active" label="Status">
          <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2">
            <Switch
              id="is_active"
              checked={values.is_active}
              onCheckedChange={(checked) => setValues({ ...values, is_active: checked })}
            />
            <Label htmlFor="is_active" className="text-sm font-medium text-foreground/80">
              Active
            </Label>
          </div>
        </FormField>

      </form>
    </ResponsiveDialog>
  );
};
