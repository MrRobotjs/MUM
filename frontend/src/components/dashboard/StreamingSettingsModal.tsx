import { useEffect, useState } from 'react';
import { FormField } from '../index';
import { useStreamingSettings } from '../../hooks/useStreamingSettings';
import { useAlerts } from '../../contexts/AlertContext';
import { requestJson } from '../../util/apiClient';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useUserPreferences } from '@/hooks/useUserPreferences';

type StreamingSettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export const StreamingSettingsModal = ({ open, onClose }: StreamingSettingsModalProps) => {
  const { success, error: showError } = useAlerts();
  const { settings, loading, error, refresh } = useStreamingSettings();
  const { getPreference, setPreference, syncEnabled } = useUserPreferences();
  const [interval, setInterval] = useState(30);
  const [streamCounterEnabled, setStreamCounterEnabled] = useState(false);
  const [initialStreamCounterEnabled, setInitialStreamCounterEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setInterval(settings.session_monitoring_interval);
    }
    // Load stream counter preference
    const enabled = getPreference<boolean>('stream_counter', false);
    setStreamCounterEnabled(enabled);
    setInitialStreamCounterEnabled(enabled);
  }, [settings, open, getPreference]);

  useEffect(() => {
    if (error) {
      showError('Failed to load settings: ' + String(error));
    }
  }, [error, showError]);

  const handleStreamCounterToggle = (checked: boolean) => {
    setStreamCounterEnabled(checked);
  };

  const handleSubmit = async () => {
    setValidationError(null);
    // Always validate interval regardless of badge setting
    if (interval < 5 || interval > 300) {
      setValidationError('Interval must be between 5 and 300 seconds.');
      return;
    }

    setSaving(true);
    try {
      if (streamCounterEnabled !== initialStreamCounterEnabled) {
        await setPreference('stream_counter', streamCounterEnabled);
        setInitialStreamCounterEnabled(streamCounterEnabled);
      }

      await requestJson('/admin/api/v2/settings/streaming', {
        method: 'PATCH',
        body: JSON.stringify({
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
              label={
                <span className="inline-flex items-center gap-2">
                  Sidebar stream counter
                  <i
                    className={`fa-solid fa-arrow-right-arrow-left text-sm ${syncEnabled ? 'text-emerald-500' : 'text-muted-foreground'}`}
                    aria-hidden="true"
                  />
                </span>
              }
              description="Show or hide the active stream counter badge in the sidebar. Live stream data is kept warm in the background; this preference only controls the badge visibility and is stored per user."
            >
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="streamBadge"
                  className="text-sm font-medium cursor-pointer"
                >
                  Show active stream badge in sidebar
                </Label>
                <Switch
                  id="streamBadge"
                  checked={streamCounterEnabled}
                  onCheckedChange={handleStreamCounterToggle}
                />
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
