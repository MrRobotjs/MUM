import { useState, useEffect } from 'react';
import { IconSettings, IconUserPlus } from '@tabler/icons-react';

import { useGeneralSettings, type GeneralSettings } from '../hooks/useSettings';
import { PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { useAlerts } from '../contexts';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';

export const AdminSettingsGeneralPage = () => {
  const { settings, loading, error, refresh } = useGeneralSettings();
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<GeneralSettings>({
    app_name: '',
    app_url: '',
    require_email: false,
    auto_approve_invites: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  }, [settings]);

  const handleChange = (field: keyof GeneralSettings, value: string | boolean) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
    setHasChanges(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      await requestJson('/admin/api/v2/settings/general', {
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
    if (settings) {
      setFormValues(settings);
      setHasChanges(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="General Settings"
        description="Configure application-wide settings"
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                <IconSettings className="size-5 text-primary" />
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
              <Label htmlFor="app_url">
                Application URL <span className="text-destructive">*</span>
              </Label>
              <Input
                id="app_url"
                type="url"
                value={formValues.app_url}
                onChange={(e) => handleChange('app_url', e.target.value)}
                required
                placeholder="https://mum.example.com"
              />
              <p className="text-xs text-muted-foreground">
                Base URL for generating invite links and OAuth redirects
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/20">
                <IconUserPlus className="size-5 text-primary" />
              </div>
              <div>
                <CardTitle className="mb-1 text-xl font-semibold">User Registration</CardTitle>
                <CardDescription>Manage invite flows and required details</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="require_email">Email Requirements</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="require_email"
                  checked={formValues.require_email}
                  onCheckedChange={(checked) => handleChange('require_email', checked)}
                />
                <Label htmlFor="require_email" className="font-normal cursor-pointer">
                  Require email address during registration
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, users must provide an email address when using invites
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="auto_approve_invites">Invite Approval</Label>
              <div className="flex items-center gap-3">
                <Switch
                  id="auto_approve_invites"
                  checked={formValues.auto_approve_invites}
                  onCheckedChange={(checked) => handleChange('auto_approve_invites', checked)}
                />
                <Label htmlFor="auto_approve_invites" className="font-normal cursor-pointer">
                  Auto-approve new invite requests
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                When enabled, new accounts created via invites are automatically approved
              </p>
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
    </div>
  );
};

export default AdminSettingsGeneralPage;
