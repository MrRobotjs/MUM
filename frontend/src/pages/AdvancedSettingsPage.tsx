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

export const AdvancedSettingsPage = () => {
  const { settings, loading, error, refresh } = useAdvancedSettings();
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<AdvancedSettings>({
    session_lifetime: 86400,
    max_login_attempts: 5,
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

      <Alert variant="warning">
        <IconShieldLock />
        <AlertTitle>Security-sensitive configuration</AlertTitle>
        <AlertDescription>
          Changing these settings may affect application security. Only modify them if you understand the
          implications.
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
                    <CardTitle className="mb-1 text-xl font-semibold">Security</CardTitle>
                    <CardDescription>Adjust token and login protection thresholds</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* CSRF settings removed (JWT + SameSite=Strict used instead) */}

                <div className="space-y-2">
                  <Label htmlFor="max_login_attempts">
                    Max Login Attempts <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="max_login_attempts"
                    type="number"
                    value={formValues.max_login_attempts}
                    onChange={(e) => handleChange('max_login_attempts', Number(e.target.value))}
                    required
                    min="3"
                    max="20"
                  />
                  <p className="text-xs text-muted-foreground">
                    Number of failed login attempts before account lockout (3-20, default: 5)
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <IconClockHour4 className="size-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle className="mb-1 text-xl font-semibold">Sessions</CardTitle>
                    <CardDescription>Control how long signed-in sessions remain active</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <Label htmlFor="session_lifetime">
                  Session Lifetime (seconds) <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="session_lifetime"
                  type="number"
                  value={formValues.session_lifetime}
                  onChange={(e) => handleChange('session_lifetime', Number(e.target.value))}
                  required
                  min="3600"
                  max="2592000"
                  step="3600"
                />
                <p className="text-xs text-muted-foreground">
                  How long user sessions remain active (3600-2592000 seconds, default: 86400)
                  <br />
                  3600 = 1 hour, 86400 = 1 day, 604800 = 1 week, 2592000 = 30 days
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

export default AdvancedSettingsPage;
