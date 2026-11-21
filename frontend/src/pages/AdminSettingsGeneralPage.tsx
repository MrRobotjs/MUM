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
  session_idle_days: 7,
  session_max_days: 30,
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
    if (sessionLengthProblem) {
      showError(sessionLengthProblem);
      return;
    }
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

  // The session limits as entered: whole days in range, inactivity no longer than the maximum.
  const idleDays = Number(formValues.session_idle_days), maxDays = Number(formValues.session_max_days);
  const sessionLengthProblem = !Number.isInteger(idleDays) || idleDays < 1 || idleDays > 90 ? 'Use 1 to 90 whole days for inactivity.'
    : !Number.isInteger(maxDays) || maxDays < 1 || maxDays > 365 ? 'Use 1 to 365 whole days for the maximum length.'
    : idleDays > maxDays ? 'The inactivity limit can’t be longer than the maximum length.' : null;
  // Whether sign-in cookies are marked secure for this visit, and what to do when they should be but aren't.
  const status = initialValues.sessions;
  const pageHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const secureStatus = status?.https_detected || status?.secure_cookies_forced
    ? { ok: true, text: 'Sign-in cookies are marked secure: this visit uses HTTPS.' }
    : pageHttps
      ? { ok: false, text: 'You opened MUM with https://, but MUM sees this visit as plain http, so sign-in cookies aren’t marked secure. If MUM is behind a reverse proxy, start it with --trusted-proxies set to the proxy’s address (or MUM_TRUSTED_PROXIES), or with --secure-cookies.' }
      : { ok: true, text: 'This visit uses plain http (fine on your own network), so sign-in cookies can’t be marked secure. Visits over https:// mark them secure automatically.' };

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
              <CardTitle className="mb-1 text-xl font-semibold">Sessions</CardTitle>
              <CardDescription>How long people stay signed in</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="session_idle_days">Sign out after inactivity (days)</Label>
              <Input
                id="session_idle_days"
                type="number"
                min={1}
                max={90}
                value={formValues.session_idle_days}
                onChange={(e) => handleChange('session_idle_days', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                A device that isn't used for this long is signed out. 1 to 90 days.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="session_max_days">Maximum sign-in length (days)</Label>
              <Input
                id="session_max_days"
                type="number"
                min={1}
                max={365}
                value={formValues.session_max_days}
                onChange={(e) => handleChange('session_max_days', Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">
                Even an active device signs in again after this long. 1 to 365 days, and at least the inactivity limit.
              </p>
            </div>
          </div>
          {sessionLengthProblem ? <p className="text-xs text-destructive">{sessionLengthProblem}</p> : null}
          <p className="text-xs text-muted-foreground">
            Changes apply to devices already signed in. People can see and sign out their devices on their Account page, and administrators can sign a user out from the user's Settings tab.
          </p>
          <div className={secureStatus.ok ? 'rounded-lg border border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground' : 'rounded-lg border border-border/70 bg-muted/40 p-3 text-xs text-amber-600 dark:text-amber-400'} role="status">
            {secureStatus.text}
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
