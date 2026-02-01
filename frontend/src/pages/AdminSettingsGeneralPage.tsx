import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faShieldHalved } from '@fortawesome/free-solid-svg-icons';

import { useGeneralSettings, type GeneralSettings } from '../hooks/useSettings';
import { PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Alert, AlertDescription } from '../components/ui/alert';
import { Spinner } from '@/components/ui/spinner'

const buildGeneralFormValues = (settings: GeneralSettings | null): GeneralSettings => ({
  app_name: '',
  app_base_url: '',
  app_local_url: '',
  enable_navbar_stream_badge: false, // Not editable here - managed in streaming settings
  session_monitoring_interval: 30, // Not editable here - managed in streaming settings
  api_timeout_seconds: 3, // Not editable here - managed in advanced settings
  jwt_cookie_secure: false,
  jwt_access_token_expires_minutes: 10,
  jwt_refresh_token_expires_days: 14,
  ...(settings ?? {}),
});

type GeneralSettingsFormProps = {
  initialValues: GeneralSettings;
  refresh: () => Promise<unknown>;
};

const GeneralSettingsForm = ({ initialValues, refresh }: GeneralSettingsFormProps) => {
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<GeneralSettings>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const handleChange = (field: keyof GeneralSettings, value: string | boolean | number) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await requestJson('/api/v2/settings/general', {
        method: 'PATCH',
        body: JSON.stringify(formValues),
      });
      success('Settings saved successfully');
      setHasChanges(false);
      await refresh();
    } catch (err) {
      showError(`Failed to save settings: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    setFormValues(initialValues);
    setHasChanges(false);
  };

  const isHttps = window.location.protocol === 'https:';

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faGear} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Application</CardTitle>
              <CardDescription>Set the basics that users see across the app</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="app_name">
              Application Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="app_name"
              type="text"
              value={formValues.app_name}
              onChange={(e) => handleChange('app_name', e.target.value)}
              required
              placeholder="Multimedia User Manager"
            />
            <p className="text-xs text-muted-foreground">
              Displayed in the header and page titles
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="app_base_url">
              Application Base URL <span className="text-destructive">*</span>
            </Label>
            <Input
              id="app_base_url"
              type="url"
              value={formValues.app_base_url}
              onChange={(e) => handleChange('app_base_url', e.target.value)}
              required
              placeholder="https://mum.example.com"
            />
            <p className="text-xs text-muted-foreground">
              Public URL for generating invite links and OAuth redirects
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="app_local_url">
              Application Local URL (Optional)
            </Label>
            <Input
              id="app_local_url"
              type="url"
              value={formValues.app_local_url || ''}
              onChange={(e) => handleChange('app_local_url', e.target.value)}
              placeholder="http://192.168.1.100:5696"
            />
            <p className="text-xs text-muted-foreground">
              Internal network URL for local access (optional)
            </p>
          </div>

        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
              <FontAwesomeIcon icon={faShieldHalved} className="size-5 text-primary" />
            </div>
            <div>
              <CardTitle className="mb-1 text-xl font-semibold">Security</CardTitle>
              <CardDescription>Authentication and session security settings</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isHttps && !formValues.jwt_cookie_secure && (
            <Alert variant="destructive">
              <AlertDescription>
                <strong>Warning:</strong> You are accessing this application over HTTPS but the Secure Cookie flag is disabled.
                This will cause authentication issues on page refresh. Enable the setting below to fix this.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Label htmlFor="jwt_cookie_secure">JWT Refresh Cookie Security</Label>
            <div className="flex items-center gap-3">
              <Switch
                id="jwt_cookie_secure"
                checked={formValues.jwt_cookie_secure}
                onCheckedChange={(checked) => handleChange('jwt_cookie_secure', checked)}
              />
              <Label htmlFor="jwt_cookie_secure" className="font-normal cursor-pointer">
                Enable Secure flag for refresh tokens (required for HTTPS)
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {isHttps ? (
                <span className="text-warning">
                  <strong>Recommended:</strong> Your site uses HTTPS. Enable this to prevent authentication errors on page refresh.
                </span>
              ) : (
                <span>
                  Enable this only if accessing the application over HTTPS. Leave disabled for local HTTP development.
                </span>
              )}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="jwt_access_token_expires_minutes">Access Token Expiration (minutes)</Label>
              <Input
                id="jwt_access_token_expires_minutes"
                type="number"
                min={1}
                max={1440}
                value={formValues.jwt_access_token_expires_minutes}
                onChange={(e) => handleChange('jwt_access_token_expires_minutes', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Shorter values require more frequent refreshes. Range: 1-1440 minutes.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="jwt_refresh_token_expires_days">Refresh Token Expiration (days)</Label>
              <Input
                id="jwt_refresh_token_expires_days"
                type="number"
                min={1}
                max={365}
                value={formValues.jwt_refresh_token_expires_days}
                onChange={(e) => handleChange('jwt_refresh_token_expires_days', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Controls how long users stay signed in without logging in again. Range: 1-365 days.
              </p>
            </div>
          </div>
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
  );
};

export const AdminSettingsGeneralPage = () => {
  const { settings, loading, error, refresh } = useGeneralSettings();

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />
        Loading settings...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load settings: {(error as Error).message}
      </div>
    );
  }

  const settingsKey = settings ? JSON.stringify(settings) : 'empty';
  const initialValues = buildGeneralFormValues(settings);

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Settings"
        description="Configure application-wide settings"
      />
      <GeneralSettingsForm key={settingsKey} initialValues={initialValues} refresh={refresh} />
    </div>
  );
};

export default AdminSettingsGeneralPage;
