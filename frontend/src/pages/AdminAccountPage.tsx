import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, requestJson } from '@/util/apiClient';
import { useAlerts } from '../contexts/AlertContext';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightArrowLeft, faUserShield, faCircleInfo, faKey, faClock } from '@fortawesome/free-solid-svg-icons';

type AccountUser = {
  uuid: string;
  username: string | null;
  email: string | null;
  display_name: string | null;
  user_type: string;
  has_password: boolean;
  force_password_change: boolean;
  last_login_at: string | null;
};

type TimezoneSettings = {
  preference: 'local' | 'utc';
  local_timezone: string | null;
  time_format: '12' | '24';
};

type AccountCapabilities = {
  can_set_initial_credentials: boolean;
  can_change_password: boolean;
};

type AccountResponse = {
  data: {
    user: AccountUser;
    timezone: TimezoneSettings;
    capabilities: AccountCapabilities;
  };
};

const detectedTimezone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
})();

const formatIsoDate = (value: string | null) => {
  if (!value) return '—';
  try {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return parsed.toLocaleString();
  } catch {
    return value;
  }
};

const getApiErrorMessage = (error: unknown) => {
  if (error instanceof ApiError) {
    const payloadError =
      error.payload && typeof error.payload === 'object' && 'error' in error.payload
        ? (error.payload.error as { message?: string })?.message
        : undefined;
    return payloadError || error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error';
};

type TabType = 'overview' | 'credentials' | 'preferences';

type SyncPreferencesCardProps = {
  syncEnabled: boolean | undefined;
  toggleSync: (value: boolean) => Promise<void>;
  prefsLoading: boolean;
  success: (message: string) => void;
  showError: (message: string) => void;
};

const SyncPreferencesCard = ({
  syncEnabled,
  toggleSync,
  prefsLoading,
  success,
  showError,
}: SyncPreferencesCardProps) => {
  const [pendingSyncEnabled, setPendingSyncEnabled] = useState<boolean>(() => syncEnabled ?? false);
  const [syncSubmitting, setSyncSubmitting] = useState(false);
  const syncDirty = syncEnabled !== undefined && pendingSyncEnabled !== syncEnabled;

  const handleSyncToggle = (checked: boolean) => {
    setPendingSyncEnabled(checked);
  };

  const handleSyncSave = async () => {
    if (syncEnabled === undefined || pendingSyncEnabled === syncEnabled) return;
    setSyncSubmitting(true);
    try {
      await toggleSync(pendingSyncEnabled);
      success(pendingSyncEnabled ? 'Preference sync enabled' : 'Preference sync disabled');
    } catch (err) {
      showError('Failed to save sync setting: ' + getApiErrorMessage(err));
      setPendingSyncEnabled(syncEnabled ?? false);
    } finally {
      setSyncSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>User Preferences</CardTitle>
        <CardDescription>
          Manage your personal preferences and cross-device synchronization. Settings marked with
          <FontAwesomeIcon icon={faArrowRightArrowLeft} className="mx-1" aria-hidden="true" /> can be synced across devices.
          When a syncable setting is enabled, that icon turns green to indicate it will follow you everywhere.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border bg-muted/50 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="sync-preferences" className="text-base font-medium cursor-pointer flex items-center gap-2">
                <span>Sync settings across devices</span>
                <FontAwesomeIcon
                  icon={faArrowRightArrowLeft}
                  className={`text-sm ${pendingSyncEnabled ? 'text-emerald-500' : 'text-muted-foreground'}`}
                  aria-hidden="true"
                />
              </Label>
              <p className="text-sm text-muted-foreground">
                {pendingSyncEnabled
                  ? 'Your preferences are synced to the database and will be available on all devices.'
                  : 'Your preferences are stored locally on this device only.'}
              </p>
            </div>
            <Switch
              id="sync-preferences"
              checked={pendingSyncEnabled}
              onCheckedChange={handleSyncToggle}
              disabled={prefsLoading || syncSubmitting}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              size="sm"
              onClick={handleSyncSave}
              disabled={!syncDirty || prefsLoading || syncSubmitting}
            >
              {syncSubmitting ? 'Saving.' : 'Save Sync Setting'}
            </Button>
            {syncDirty ? <span className="text-sm text-muted-foreground">Unsaved change</span> : null}
          </div>
          {pendingSyncEnabled && (
              <Alert>
                <FontAwesomeIcon icon={faCircleInfo} className="h-4 w-4" />
                <AlertDescription>
                When sync is enabled, your preferences are saved to the database and will apply across all devices where you sign in.
                When disabled, preferences are stored locally in your browser only.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

// --- Extracted Form Components ---

type InitialCredentialsFormProps = {
  initialUsername: string;
  onSuccess: (response: AccountResponse) => void;
};

const InitialCredentialsForm = ({ initialUsername, onSuccess }: InitialCredentialsFormProps) => {
  const { success } = useAlerts();
  const [form, setForm] = useState({
    username: initialUsername,
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account/initial-credentials', {
        method: 'POST',
        body: JSON.stringify({
          username: form.username,
          password: form.password,
        }),
      });
      onSuccess(response);
      success('Local credentials are now configured for your account.');
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set Local Credentials</CardTitle>
        <CardDescription>
          Configure a local username and password to sign in without Plex SSO.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="initial-username">Username</Label>
            <Input
              id="initial-username"
              value={form.username}
              onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
              required
              minLength={3}
              maxLength={80}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="initial-password">Password</Label>
            <Input
              id="initial-password"
              type="password"
              value={form.password}
              onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
              required
              minLength={8}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="initial-confirm-password">Confirm Password</Label>
            <Input
              id="initial-confirm-password"
              type="password"
              value={form.confirmPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
              required
              minLength={8}
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? 'Saving…' : 'Save Credentials'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

type PasswordFormProps = {
  onSuccess: () => void;
};

const PasswordForm = ({ onSuccess }: PasswordFormProps) => {
  const { success } = useAlerts();
  const [form, setForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (form.newPassword !== form.confirmPassword) {
      setError('New passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await requestJson('/admin/api/v2/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: form.currentPassword,
          new_password: form.newPassword,
        }),
      });
      success('Your password was changed successfully.');
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
      onSuccess();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change Password</CardTitle>
        <CardDescription>Update your password for this admin account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              value={form.currentPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, currentPassword: event.target.value }))}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              value={form.newPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, newPassword: event.target.value }))}
              minLength={8}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-new-password">Confirm New Password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              value={form.confirmPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
              minLength={8}
              required
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? 'Updating…' : 'Update Password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

type EmailFormProps = {
  initialEmail: string;
  onSuccess: () => void;
};

const EmailForm = ({ initialEmail, onSuccess }: EmailFormProps) => {
  const { success } = useAlerts();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestJson('/admin/api/v2/account/email', {
        method: 'PATCH',
        body: JSON.stringify({ email }),
      });
      success('Email updated.');
      onSuccess();
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account Email</CardTitle>
        <CardDescription>View or update the email associated with this account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="account-email">Email</Label>
            <Input
              id="account-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? 'Saving.' : 'Save Email'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

type TimezoneFormProps = {
  initialValues: TimezoneSettings;
  onSuccess: (response: AccountResponse) => void;
};

const TimezoneForm = ({ initialValues, onSuccess }: TimezoneFormProps) => {
  const { success } = useAlerts();
  const [form, setForm] = useState<TimezoneSettings>(initialValues);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account/timezone', {
        method: 'PUT',
        body: JSON.stringify({
          preference: form.preference,
          time_format: form.time_format,
          local_timezone: form.preference === 'local' ? form.local_timezone : null,
        }),
      });
      onSuccess(response);
      success('Display preferences saved.');
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timezone Settings</CardTitle>
        <CardDescription>
          Choose how timestamps are displayed throughout the application.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label>Display Time In</Label>
            <Select
              value={form.preference}
              onValueChange={(value: 'local' | 'utc') =>
                setForm((prev) => ({
                  ...prev,
                  preference: value,
                  local_timezone: value === 'local' ? (prev.local_timezone ?? detectedTimezone) : null,
                }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">
                  My Timezone {form.local_timezone ? `(${form.local_timezone})` : ''}
                </SelectItem>
                <SelectItem value="utc">UTC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.preference === 'local' ? (
            <div className="space-y-2">
              <Label htmlFor="local-timezone">Local Timezone</Label>
              <Input
                id="local-timezone"
                placeholder="e.g. America/New_York"
                value={form.local_timezone ?? ''}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, local_timezone: event.target.value }))
                }
                required
              />
              {detectedTimezone ? (
                <button
                  type="button"
                  className="text-sm text-primary underline-offset-4 hover:underline"
                  onClick={() => setForm((prev) => ({ ...prev, local_timezone: detectedTimezone }))}
                >
                  Use detected timezone ({detectedTimezone})
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>Time Format</Label>
            <Select
              value={form.time_format}
              onValueChange={(value: '12' | '24') =>
                setForm((prev) => ({ ...prev, time_format: value }))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="12">12-hour (AM/PM)</SelectItem>
                <SelectItem value="24">24-hour</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
            {submitting ? 'Saving…' : 'Save Preferences'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

type PlexSSOCardProps = {
  initialError: string | null;
};

const PlexSSOCard = ({ initialError }: PlexSSOCardProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const handlePlexSSO = async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await requestJson<{
        data?: { redirect_url?: string };
      }>('/admin/api/v2/auth/plex/start', {
        method: 'POST',
        body: JSON.stringify({ next: '/admin/account?tab=credentials' }),
      });

      const redirectUrl = response?.data?.redirect_url;
      if (redirectUrl) {
        window.location.href = redirectUrl;
      } else {
        setError('Failed to initiate Plex login');
        setLoading(false);
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plex SSO Link</CardTitle>
        <CardDescription>
          Link your Plex account to enable single sign-on authentication.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={handlePlexSSO}
            className="w-full text-lg h-12 hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200 ease-in-out border-orange-600 text-orange-700 dark:text-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950 hover:border-orange-600"
            disabled={loading}
          >
            {loading ? (
              <>
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-current mr-2" />
                Connecting...
              </>
            ) : (
              <>
                <svg className="w-5 h-5 mr-3" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor" stroke="transparent" strokeLinejoin="round" strokeWidth="12">
                  <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z"/>
                </svg>
                Link Plex Account
              </>
            )}
          </Button>
          <p className="text-sm text-muted-foreground">
            After linking, you'll be able to sign in using your Plex credentials. You'll be redirected back to this page after authentication.
          </p>
        </div>
      </CardContent>
    </Card>
  );
};

// --- Main Page Component ---

const AdminAccountPage = () => {
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();

  // Use TanStack Router search for tab state
  const search = useSearch({ from: '/admin/account', strict: false }) as { tab?: TabType; error?: string };
  const activeTab: TabType = search.tab ?? 'overview';

  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AccountResponse['data'] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [plexSSOError, setPlexSSOError] = useState<string | null>(null);

  // User preferences hook
  const { syncEnabled, toggleSync, loading: prefsLoading } = useUserPreferences();

  const refreshAccount = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account');
      setAccount(response.data);
    } catch (error) {
      const message = getApiErrorMessage(error);
      setFetchError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch account data on mount only
  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // Handle Plex SSO error from URL (separate effect)
  useEffect(() => {
    if (search.error && activeTab === 'credentials') {
      setPlexSSOError(search.error);
      navigate({ from: '/admin/account', search: (prev) => ({ ...prev, error: undefined, tab: 'credentials' }), replace: true });
    }
  }, [search.error, activeTab, navigate]);

  const showInitialCredentialsCard = useMemo(() => {
    if (!account) return false;
    return account.capabilities.can_set_initial_credentials;
  }, [account]);

  const setTab = (tab: TabType) => {
    navigate({
      search: (prev) => ({
        ...prev,
        tab,
      }),
      replace: true,
    });
  };

  const handleCredentialsSuccess = (response: AccountResponse) => {
    setAccount(response.data);
  };

  const handleTimezoneSuccess = (response: AccountResponse) => {
    setAccount(response.data);
  };

  if (loading && !account) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Card className="bg-gradient-to-r from-primary/10 to-primary/20">
          <CardContent className="p-8">
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="h-24 w-24 rounded-full" />
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-32" />
            </div>
          </CardContent>
        </Card>
        <div className="space-y-6">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-48 w-full rounded-lg" />
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <Alert variant="destructive" className="rounded-xl">
          <AlertTitle>Unable to load account details</AlertTitle>
          <AlertDescription>{fetchError}</AlertDescription>
          <Button className="mt-4" onClick={() => void refreshAccount()}>
            Retry
          </Button>
        </Alert>
      </div>
    );
  }

  if (!account) {
    return null;
  }

  // Generate keys for form components to reset when account data changes
  const accountKey = `${account.user.uuid}-${account.user.username}-${account.user.email}`;
  const timezoneKey = `${account.timezone.preference}-${account.timezone.time_format}-${account.timezone.local_timezone}`;
  const syncKey = syncEnabled === undefined ? 'unset' : String(syncEnabled);
  const plexSSOKey = plexSSOError ?? 'no-error';

  const displayName = account.user.display_name || account.user.username || 'Administrator';

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      {/* Header Section */}
      <Card className="bg-gradient-to-r from-primary/10 to-primary/20">
        <CardContent className="p-8">
          <div className="flex flex-col items-center space-y-4">
            <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-primary/30 bg-primary text-primary-foreground shadow-lg">
              <FontAwesomeIcon icon={faUserShield} className="h-10 w-10" />
            </div>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold text-foreground md:text-4xl text-center">{displayName}</h1>
              <p className="text-sm text-muted-foreground">{account.user.email || account.user.username || 'Administrator'}</p>
            </div>
            <Badge variant="outline" className="gap-2 uppercase tracking-wide">
              <FontAwesomeIcon icon={faUserShield} className="h-3.5 w-3.5" />
              System Administrator
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabType)}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">
            <FontAwesomeIcon icon={faCircleInfo} className="mr-2 h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="credentials">
            <FontAwesomeIcon icon={faKey} className="mr-2 h-4 w-4" />
            Credentials
          </TabsTrigger>
          <TabsTrigger value="preferences">
            <FontAwesomeIcon icon={faClock} className="mr-2 h-4 w-4" />
            Preferences
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle className="text-sm">Account Details</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="space-y-2 text-sm text-muted-foreground">
                  <div className="flex justify-between gap-4">
                    <dt className="font-medium text-foreground/60">Username</dt>
                    <dd className="text-foreground">{account.user.username || 'Not configured'}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="font-medium text-foreground/60">Email</dt>
                    <dd className="text-right text-foreground">{account.user.email || '—'}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="font-medium text-foreground/60">Last Login</dt>
                    <dd className="text-right text-foreground">{formatIsoDate(account.user.last_login_at)}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">Session Status</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  You are signed in as an administrator with full access to system settings and user
                  management features.
                </p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="credentials" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            {showInitialCredentialsCard && (
              <InitialCredentialsForm
                key={`credentials-${accountKey}`}
                initialUsername={account.user.username ?? ''}
                onSuccess={handleCredentialsSuccess}
              />
            )}
            <PasswordForm
              key={`password-${accountKey}`}
              onSuccess={() => void refreshAccount()}
            />
          </div>

          <EmailForm
            key={`email-${accountKey}`}
            initialEmail={account.user.email ?? ''}
            onSuccess={() => void refreshAccount()}
          />

          <PlexSSOCard
            key={`plex-${plexSSOKey}`}
            initialError={plexSSOError}
          />
        </TabsContent>

        <TabsContent value="preferences" className="space-y-6">
          <TimezoneForm
            key={`timezone-${timezoneKey}`}
            initialValues={{
              preference: account.timezone.preference ?? 'local',
              time_format: account.timezone.time_format ?? '12',
              local_timezone: account.timezone.local_timezone ?? detectedTimezone,
            }}
            onSuccess={handleTimezoneSuccess}
          />

          <SyncPreferencesCard
            key={syncKey}
            syncEnabled={syncEnabled}
            toggleSync={toggleSync}
            prefsLoading={prefsLoading}
            success={success}
            showError={showError}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminAccountPage;
