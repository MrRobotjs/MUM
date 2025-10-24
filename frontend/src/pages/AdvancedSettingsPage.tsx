import { useState, useEffect } from 'react';
import { useAdvancedSettings, type AdvancedSettings } from '../hooks/useSettings';
import { PageHeader, FormField } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';

export const AdvancedSettingsPage = () => {
  const { settings, loading, error, refresh } = useAdvancedSettings();
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<AdvancedSettings>({
    csrf_timeout: 3600,
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
      await requestJson('/admin/api/v1/settings/advanced', {
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

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
        Loading advanced settings...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load advanced settings: {(error as Error).message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Advanced Settings"
        description="Configure security and session settings"
      />

      <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <i className="fa-solid fa-triangle-exclamation text-yellow-500" />
          <span className="text-sm">
            Changing these settings may affect application security. Only modify if you understand the implications.
          </span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Security</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="csrf_timeout">
                CSRF Token Timeout (seconds) <span className="text-destructive">*</span>
              </Label>
              <Input
                id="csrf_timeout"
                type="number"
                value={formValues.csrf_timeout}
                onChange={(e) => handleChange('csrf_timeout', Number(e.target.value))}
                required
                min="300"
                max="86400"
                step="60"
              />
              <p className="text-xs text-muted-foreground">
                How long CSRF tokens remain valid (300-86400 seconds, default: 3600)
              </p>
            </div>

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
            <CardTitle>Sessions</CardTitle>
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
    </div>
  );
};

export default AdvancedSettingsPage;
