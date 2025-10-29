import { useEffect, useState } from 'react';
import { FormField } from '../index';
import { useStreamingSettings } from '../../hooks/useStreamingSettings';
import { useToast } from '../../util/toast';
import { requestJson } from '../../util/apiClient';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { Button } from '@/components/ui/button';

type StreamingSettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export const StreamingSettingsModal = ({ open, onClose }: StreamingSettingsModalProps) => {
  const toast = useToast();
  const { settings, loading, error, refresh } = useStreamingSettings();
  const [enableBadge, setEnableBadge] = useState(false);
  const [interval, setInterval] = useState(30);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setEnableBadge(settings.enable_navbar_stream_badge);
      setInterval(settings.session_monitoring_interval);
    }
  }, [settings, open]);

  useEffect(() => {
    if (error) {
      toast.showToast({ type: 'error', title: 'Failed to load settings', description: String(error) });
    }
  }, [error, toast]);

  const handleSubmit = async () => {
    setValidationError(null);
    if (!enableBadge && (interval < 5 || interval > 300)) {
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

      toast.showToast({ type: 'success', title: 'Streaming settings saved' });
      await refresh();
      onClose();
    } catch (err) {
      toast.showToast({ type: 'error', title: 'Failed to save settings', description: String(err) });
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
        <div className="flex items-center gap-2 text-sm text-base-content/60">
          <span className="loading loading-spinner loading-sm" /> Loading settings…
        </div>
      ) : null}

      {settings ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-base-300 bg-base-200/40 p-4">
            <FormField id="streamBadge" label="Enable nav bar stream badge">
              <label className="label cursor-pointer justify-start p-0">
                <input
                  type="checkbox"
                  className="toggle toggle-primary mr-3"
                  checked={enableBadge}
                  onChange={(event) => setEnableBadge(event.target.checked)}
                />
                <span className="text-sm text-base-content/80">Show active stream count in the navigation bar.</span>
              </label>
            </FormField>
          </div>

          <div className="rounded-lg border border-base-300 bg-base-200/40 p-4">
            <FormField
              id="monitorInterval"
              label="Session monitoring interval (seconds)"
              description="How often to poll for new sessions. Disabled when the nav badge is enabled."
              error={validationError || undefined}
            >
              <input
                id="monitorInterval"
                type="number"
                min={5}
                max={300}
                step={1}
                className="input input-bordered w-full"
                value={interval}
                onChange={(event) => setInterval(Number(event.target.value))}
                disabled={enableBadge || saving}
              />
            </FormField>
          </div>

        </div>
      ) : null}
    </ResponsiveDialog>
  );
};

export default StreamingSettingsModal;
