import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faGear, faShieldHalved } from '@fortawesome/free-solid-svg-icons';

import { useGeneralSettings, type GeneralSettings } from '../hooks/useSettings';
import { PageHeader } from '../components';
import { requestJson } from '../util/apiClient';
import { generalSettingsPayload } from '../lib/generalSettings';
import { useAlerts } from '../contexts';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Switch } from '../components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card';
import { Spinner } from '@/components/ui/spinner'
import { SignInSettingsCard, useSignInSettingsForm, type SignInSettingsForm } from '../components/settings/SignInSettingsCard';
import { UnsavedChangesBar } from '../components/common/UnsavedChangesBar';
import { Button } from '../components/ui/button';
import { addressReach, publicAddressNotes } from '../lib/publicAddress';

const buildGeneralFormValues = (settings: GeneralSettings | null): GeneralSettings => ({
  app_name: '',
  public_address: '',
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
  signIn: SignInSettingsForm;
};

// The General page is one form: the application, session and sign-in
// settings, saved together from the save bar.
const GeneralSettingsForm = ({ initialValues, refresh, signIn }: GeneralSettingsFormProps) => {
  const { success, error: showError } = useAlerts();
  const [formValues, setFormValues] = useState<GeneralSettings>(initialValues);
  const [submitting, setSubmitting] = useState(false);
  // Changed when the form differs from what's saved; changing a field back clears it.
  const generalChanged = (Object.keys(initialValues) as (keyof GeneralSettings)[]).some(key => String(formValues[key]) !== String(initialValues[key]));
  const hasChanges = generalChanged || signIn.changed;

  const handleChange = (field: keyof GeneralSettings, value: string | boolean | number) => {
    setFormValues((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    // Each part saves on its own; a failure names its part and leaves the other saved.
    let saved = 0, failed = false;
    try {
      if (signIn.changed) {
        try {
          await signIn.save();
          saved++;
        } catch (err) {
          failed = true;
          showError(`Couldn’t save the sign-in settings: ${(err as Error).message}`);
        }
      }
      if (generalChanged) {
        try {
          await requestJson('/api/settings/general', {
            method: 'PATCH',
            body: JSON.stringify(generalSettingsPayload(formValues)),
          });
          saved++;
          await refresh();
        } catch (err) {
          failed = true;
          showError(`Couldn’t save the general settings: ${(err as Error).message}`);
        }
      }
      if (saved && !failed) success('Settings saved');
    } finally {
      setSubmitting(false);
    }
  };

  // The address this page is open on, offered when it's an https:// address
  // people outside could reach and differs from the saved one.
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const currentAddress = origin.startsWith('https://') && addressReach(origin) !== 'local' ? origin : '';

  const handleReset = () => {
    setFormValues(initialValues);
    signIn.reset();
  };

  return (
    <form id="general-settings-form" onSubmit={handleSubmit} className="space-y-6">
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
            <Label htmlFor="public_address">Public Address</Label>
            <Input
              id="public_address"
              type="url"
              value={formValues.public_address}
              onChange={(e) => handleChange('public_address', e.target.value)}
              placeholder="https://mum.example.com"
            />
            <p className="text-xs text-muted-foreground">
              The address people outside your network use to reach MUM. Invite links and Discord sign-in use it. Optional: without it, invite links use the address you're browsing on, and Discord sign-in stays off.
            </p>
            {currentAddress && currentAddress !== formValues.public_address.trim().replace(/\/+$/, '') ? (
              <Button type="button" variant="outline" size="sm" onClick={() => handleChange('public_address', currentAddress)}>
                Use {currentAddress} (this address)
              </Button>
            ) : null}
            {publicAddressNotes(formValues.public_address).map(note => (
              <p key={note} className="text-xs text-amber-600 dark:text-amber-400">{note}</p>
            ))}
            <div className="space-y-1 rounded-lg border border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Making MUM reachable from outside</p>
              <p>A domain name such as https://mum.example.com is the best choice. It usually points to a reverse proxy (Caddy, Nginx, Traefik and the like), which forwards visitors to MUM and gives you the https:// address Discord sign-in needs.</p>
              <p>Without a domain, people outside your network can only reach MUM if your router forwards MUM's port to this computer (port forwarding). Your internet provider may change your IP address, and sharing it shows it to everyone you invite.</p>
            </div>
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
          <p className="text-xs text-muted-foreground">
            These session settings are fixed by this MUM build and cannot be changed here: access tokens last 15 minutes and sign-in sessions 14 days. The Secure cookie flag is set automatically over direct HTTPS; behind an HTTPS reverse proxy, start MUM with --secure-cookies.
          </p>

          <div className="space-y-2">
            <Label htmlFor="jwt_cookie_secure">JWT Refresh Cookie Security</Label>
            <div className="flex items-center gap-3">
              <Switch
                id="jwt_cookie_secure"
                checked={formValues.jwt_cookie_secure}
                disabled
                onCheckedChange={(checked) => handleChange('jwt_cookie_secure', checked)}
              />
              <Label htmlFor="jwt_cookie_secure" className="font-normal cursor-pointer">
                Enable Secure flag for refresh tokens (required for HTTPS)
              </Label>
            </div>
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
                disabled
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
                disabled
                onChange={(e) => handleChange('jwt_refresh_token_expires_days', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Controls how long users stay signed in without logging in again. Range: 1-365 days.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <SignInSettingsCard form={signIn} disabled={submitting} />

      <UnsavedChangesBar dirty={hasChanges} saving={submitting} onReset={handleReset} formId="general-settings-form" />
    </form>
  );
};

export const AdminSettingsGeneralPage = () => {
  const { settings, loading, error, refresh } = useGeneralSettings();
  // Held by the page so a refresh of the general settings keeps the sign-in choice.
  const signIn = useSignInSettingsForm();

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
      <GeneralSettingsForm key={settingsKey} initialValues={initialValues} refresh={refresh} signIn={signIn} />
    </div>
  );
};

export default AdminSettingsGeneralPage;
