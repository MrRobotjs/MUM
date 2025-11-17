import { useEffect, useState, useMemo } from 'react';
import { FormField } from '../index';
import { useStreamingSettings } from '../../hooks/useStreamingSettings';
import { useAlerts } from '../../contexts/AlertContext';
import { requestJson } from '../../util/apiClient';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

// Services that support WebSocket for real-time streaming updates
// Add new services here as WebSocket support is implemented
const WEBSOCKET_ENABLED_SERVICES: readonly string[] = ['plex'] as const;
// Future: Add 'jellyfin' and 'emby' when WebSocket support is implemented

type StreamingSettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export const StreamingSettingsModal = ({ open, onClose }: StreamingSettingsModalProps) => {
  const { success, error: showError } = useAlerts();
  const { settings, loading, error, refresh } = useStreamingSettings();
  const [enableBadge, setEnableBadge] = useState(false);
  const [interval, setInterval] = useState(30);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Format WebSocket-enabled services for display
  const websocketServicesList = useMemo(() => {
    const services = WEBSOCKET_ENABLED_SERVICES.map((s) => s.charAt(0).toUpperCase() + s.slice(1));
    if (services.length === 1) {
      return services[0];
    } else if (services.length === 2) {
      return services.join(' and ');
    } else {
      return services.slice(0, -1).join(', ') + ', and ' + services[services.length - 1];
    }
  }, []);

  useEffect(() => {
    if (settings) {
      setEnableBadge(settings.enable_navbar_stream_badge);
      setInterval(settings.session_monitoring_interval);
    }
  }, [settings, open]);

  useEffect(() => {
    if (error) {
      showError('Failed to load settings: ' + String(error));
    }
  }, [error, showError]);

  const handleSubmit = async () => {
    setValidationError(null);
    // Always validate interval regardless of badge setting
    if (interval < 5 || interval > 300) {
      setValidationError('Interval must be between 5 and 300 seconds.');
      return;
    }

    setSaving(true);
    try {
      await requestJson('/admin/api/v2/settings/streaming', {
        method: 'PATCH',
        body: JSON.stringify({
          enable_navbar_stream_badge: enableBadge,
          session_monitoring_interval: interval,
          // Preserve current websocket refresh interval (required by v2)
          websocket_refresh_interval: settings?.websocket_refresh_interval ?? 30
        })
      });

      success('Streaming settings saved');
      await refresh();
      onClose();
    } catch (err) {
      showError('Failed to save settings: ' + String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenChange = (value: boolean) => {
    if (!value && !saving) {
      onClose();
    }
  };

  const footer = [
    <Button key="cancel" variant="outline" onClick={onClose} disabled={saving}>
      Cancel
    </Button>,
    <Button key="save" onClick={handleSubmit} disabled={saving}>
      {saving ? 'Saving…' : 'Save Settings'}
    </Button>,
  ];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Streaming Settings"
      description="Control how frequently streaming sessions are monitored and displayed."
      footer={footer}
      contentClassName="max-w-lg"
      bodyClassName="space-y-4"
    >
      {loading && !settings ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="loading loading-spinner loading-sm" /> Loading settings…
        </div>
      ) : null}

      {settings ? (
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4">
            <FormField 
              id="streamBadge" 
              label="Enable nav bar stream badge"
              description={`Show active stream count in the navigation bar for WebSocket-enabled services (${websocketServicesList}). Other services use polling.`}
            >
              <div className="flex items-center space-x-3">
                <Checkbox
                  id="streamBadge"
                  checked={enableBadge}
                  onCheckedChange={(checked) => setEnableBadge(checked === true)}
                />
                <Label
                  htmlFor="streamBadge"
                  className="text-sm text-foreground/80 font-normal cursor-pointer"
                >
                  Show active stream count in the navigation bar.
                </Label>
              </div>
            </FormField>
          </div>

          <div className="rounded-lg border bg-muted/50 p-4">
            <FormField
              id="monitorInterval"
              label="Session monitoring interval (seconds)"
              description="How often to poll for new sessions from services that don't support WebSocket (e.g., Jellyfin, Emby). This interval also controls how often the backend checks for stopped sessions to finalize stream history records."
              error={validationError || undefined}
            >
              <Input
                id="monitorInterval"
                type="number"
                min={5}
                max={300}
                step={1}
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value))}
                disabled={saving}
              />
            </FormField>
          </div>

        </div>
      ) : null}
    </ResponsiveDialog>
  );
};

export default StreamingSettingsModal;
