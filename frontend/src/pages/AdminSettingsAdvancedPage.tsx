import { useState, useEffect } from 'react';
import {
  IconAlertTriangle,
  IconShieldLock,
  IconShieldCheck,
  IconClockHour4,
} from '@tabler/icons-react';

import { useAdvancedSettings, type AdvancedSettings } from '../hooks/useSettings';
import { PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';

export const AdminSettingsAdvancedPage = () => {
  const { settings, loading, error, refresh } = useAdvancedSettings();
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<AdvancedSettings>({
    api_timeout_seconds: 3,
  });
  const [submitting, setSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  }, [settings]);

  const handleChange = (field: keyof AdvancedSettings, value: number) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await requestJson('/admin/api/v2/settings/advanced', {
        method: 'PATCH',
        body: JSON.stringify(formValues),
      });
      success('Advanced settings saved successfully');
      setHasChanges(false);
      await refresh();
    } catch (err) {
      showError(`Failed to save settings: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Advanced Settings"
        description="Configure security and session settings"
      />

      {error && (
        <Alert variant="destructive">
          <IconAlertTriangle />
          <AlertTitle>Failed to load advanced settings</AlertTitle>
          <AlertDescription>{(error as Error).message}</AlertDescription>
        </Alert>
      )}

      <Alert variant="default">
        <IconShieldLock />
        <AlertTitle>Performance & Monitoring</AlertTitle>
        <AlertDescription>
          Configure timeouts and monitoring intervals for optimal performance. Changes take effect immediately.
        </AlertDescription>
      </Alert>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Loading advanced settings...
        </div>
      ) : (
        !error && (
          <form onSubmit={handleSubmit} className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <IconShieldCheck className="size-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="mb-1 text-xl font-semibold">API Requests</CardTitle>
                    <CardDescription>Configure timeout for external service connections</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="api_timeout_seconds">
                  API Timeout (seconds) <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="api_timeout_seconds"
                  type="number"
                  value={formValues.api_timeout_seconds}
                  onChange={(e) => handleChange('api_timeout_seconds', Number(e.target.value))}
                  required
                  min="3"
                  max="30"
                />
                <p className="text-xs text-muted-foreground">
                  Timeout for API requests to external services like Plex, Jellyfin, etc. (3-30 seconds, default: 3)
                </p>
              </CardContent>
            </Card>

            <div className="flex items-center justify-end gap-3">
              <Button
                type="button"
                variant="ghost"
                onClick={handleReset}
                disabled={!hasChanges || submitting}
              >
                Reset
              </Button>
              <Button type="submit" variant="default" disabled={!hasChanges || submitting}>
                {submitting ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        )
      )}
    </div>
  );
};

export default AdminSettingsAdvancedPage;
