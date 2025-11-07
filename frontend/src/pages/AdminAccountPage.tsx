import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ApiError, requestJson } from '@/util/apiClient';
import { useToast } from '@/util/toast';
import { IconUserShield } from '@tabler/icons-react';

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

const AdminAccountPage = () => {
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AccountResponse['data'] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [credentialsForm, setCredentialsForm] = useState({
    username: '',
    password: '',
    confirmPassword: '',
  });
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [credentialsSubmitting, setCredentialsSubmitting] = useState(false);

  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  const [timezoneForm, setTimezoneForm] = useState<TimezoneSettings>({
    preference: 'local',
    local_timezone: detectedTimezone,
    time_format: '12',
  });
  const [timezoneError, setTimezoneError] = useState<string | null>(null);
  const [timezoneSubmitting, setTimezoneSubmitting] = useState(false);

  const refreshAccount = async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account');
      setAccount(response.data);
      const tz = response.data.timezone;
      setTimezoneForm({
        preference: tz.preference ?? 'local',
        time_format: tz.time_format ?? '12',
        local_timezone: tz.local_timezone ?? detectedTimezone,
      });
      setCredentialsForm((prev) => ({
        ...prev,
        username: response.data.user.username ?? '',
        password: '',
        confirmPassword: '',
      }));
      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    } catch (error) {
      const message = getApiErrorMessage(error);
      setFetchError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshAccount();
  }, []);

  const showInitialCredentialsCard = useMemo(() => {
    if (!account) return false;
    return account.capabilities.can_set_initial_credentials;
  }, [account]);

  const handleSetInitialCredentials = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCredentialsError(null);

    if (credentialsForm.password !== credentialsForm.confirmPassword) {
      setCredentialsError('Passwords do not match.');
      return;
    }

    setCredentialsSubmitting(true);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account/initial-credentials', {
        method: 'POST',
        body: JSON.stringify({
          username: credentialsForm.username,
          password: credentialsForm.password,
        }),
      });
      setAccount(response.data);
      toast.showToast({
        type: 'success',
        title: 'Credentials saved',
        description: 'Local credentials are now configured for your account.',
      });
      setCredentialsForm({
        username: response.data.user.username ?? '',
        password: '',
        confirmPassword: '',
      });
    } catch (error) {
      setCredentialsError(getApiErrorMessage(error));
    } finally {
      setCredentialsSubmitting(false);
    }
  };

  const handleChangePassword = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError(null);

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }

    setPasswordSubmitting(true);
    try {
      await requestJson('/admin/api/v2/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: passwordForm.currentPassword,
          new_password: passwordForm.newPassword,
        }),
      });
      toast.showToast({
        type: 'success',
        title: 'Password updated',
        description: 'Your password was changed successfully.',
      });
      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    } catch (error) {
      setPasswordError(getApiErrorMessage(error));
    } finally {
      setPasswordSubmitting(false);
    }
  };

  const handleTimezoneSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setTimezoneError(null);

    setTimezoneSubmitting(true);
    try {
      const response = await requestJson<AccountResponse>('/admin/api/v2/account/timezone', {
        method: 'PUT',
        body: JSON.stringify({
          preference: timezoneForm.preference,
          time_format: timezoneForm.time_format,
          local_timezone: timezoneForm.preference === 'local' ? timezoneForm.local_timezone : null,
        }),
      });
      setAccount(response.data);
      setTimezoneForm({
        preference: response.data.timezone.preference,
        time_format: response.data.timezone.time_format,
        local_timezone: response.data.timezone.local_timezone,
      });
      toast.showToast({
        type: 'success',
        title: 'Timezone updated',
        description: 'Display preferences saved.',
      });
    } catch (error) {
      setTimezoneError(getApiErrorMessage(error));
    } finally {
      setTimezoneSubmitting(false);
    }
  };

  if (loading && !account) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="overflow-hidden rounded-xl border bg-card shadow-lg">
          <div className="bg-gradient-to-r from-primary/10 to-primary/20 p-8 text-center">
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="h-24 w-24 rounded-full" />
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-32" />
            </div>
          </div>
          <div className="border-b bg-muted/40 px-6">
            <div className="flex h-12 items-center text-sm font-medium">
              <span className="inline-flex h-full items-center border-b-2 border-primary px-4 text-primary">
                Account Settings
              </span>
            </div>
          </div>
          <div className="space-y-6 p-6">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
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

  const displayName = account.user.display_name || account.user.username || 'Administrator';

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="overflow-hidden rounded-xl border bg-card shadow-lg">
        <div className="bg-gradient-to-r from-primary/10 to-primary/20 px-6 py-8 text-center sm:px-10">
          <div className="flex flex-col items-center gap-4">
            <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-primary/30 bg-primary text-primary-foreground shadow-lg">
              <IconUserShield className="h-10 w-10" />
            </div>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold text-foreground md:text-4xl">{displayName}</h1>
              <p className="text-sm text-muted-foreground">{account.user.email || account.user.username || 'Administrator'}</p>
            </div>
            <Badge variant="outline" className="gap-2 uppercase tracking-wide">
              <IconUserShield className="h-3.5 w-3.5" />
              System Administrator
            </Badge>
          </div>
        </div>

        <div className="border-b bg-muted/40 px-6">
          <div className="flex h-12 items-center text-sm font-medium">
            <span className="inline-flex h-full items-center border-b-2 border-primary px-4 text-primary">
              Account Settings
            </span>
          </div>
        </div>

        <div className="space-y-6 p-6">
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

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-6">
              {showInitialCredentialsCard ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Set Local Credentials</CardTitle>
                    <CardDescription>
                      Configure a local username and password to sign in without Plex SSO.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form className="space-y-4" onSubmit={handleSetInitialCredentials}>
                      <div className="space-y-2">
                        <Label htmlFor="initial-username">Username</Label>
                        <Input
                          id="initial-username"
                          value={credentialsForm.username}
                          onChange={(event) =>
                            setCredentialsForm((prev) => ({ ...prev, username: event.target.value }))
                          }
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
                          value={credentialsForm.password}
                          onChange={(event) =>
                            setCredentialsForm((prev) => ({ ...prev, password: event.target.value }))
                          }
                          required
                          minLength={8}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="initial-confirm-password">Confirm Password</Label>
                        <Input
                          id="initial-confirm-password"
                          type="password"
                          value={credentialsForm.confirmPassword}
                          onChange={(event) =>
                            setCredentialsForm((prev) => ({
                              ...prev,
                              confirmPassword: event.target.value,
                            }))
                          }
                          required
                          minLength={8}
                        />
                      </div>
                      {credentialsError ? (
                        <Alert variant="destructive">
                          <AlertDescription>{credentialsError}</AlertDescription>
                        </Alert>
                      ) : null}
                      <Button type="submit" disabled={credentialsSubmitting} className="w-full sm:w-auto">
                        {credentialsSubmitting ? 'Saving…' : 'Save Credentials'}
                      </Button>
                    </form>
                  </CardContent>
                </Card>
              ) : null}

              <Card>
                <CardHeader>
                  <CardTitle>Change Password</CardTitle>
                  <CardDescription>Update your password for this admin account.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-4" onSubmit={handleChangePassword}>
                    <div className="space-y-2">
                      <Label htmlFor="current-password">Current Password</Label>
                      <Input
                        id="current-password"
                        type="password"
                        value={passwordForm.currentPassword}
                        onChange={(event) =>
                          setPasswordForm((prev) => ({
                            ...prev,
                            currentPassword: event.target.value,
                          }))
                        }
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="new-password">New Password</Label>
                      <Input
                        id="new-password"
                        type="password"
                        value={passwordForm.newPassword}
                        onChange={(event) =>
                          setPasswordForm((prev) => ({
                            ...prev,
                            newPassword: event.target.value,
                          }))
                        }
                        minLength={8}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="confirm-new-password">Confirm New Password</Label>
                      <Input
                        id="confirm-new-password"
                        type="password"
                        value={passwordForm.confirmPassword}
                        onChange={(event) =>
                          setPasswordForm((prev) => ({
                            ...prev,
                            confirmPassword: event.target.value,
                          }))
                        }
                        minLength={8}
                        required
                      />
                    </div>
                    {passwordError ? (
                      <Alert variant="destructive">
                        <AlertDescription>{passwordError}</AlertDescription>
                      </Alert>
                    ) : null}
                    <Button type="submit" disabled={passwordSubmitting} className="w-full sm:w-auto">
                      {passwordSubmitting ? 'Updating…' : 'Update Password'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </div>

            <div>
              <Card>
                <CardHeader>
                  <CardTitle>Timezone Settings</CardTitle>
                  <CardDescription>
                    Choose how timestamps are displayed throughout the application.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form className="space-y-4" onSubmit={handleTimezoneSubmit}>
                    <div className="space-y-2">
                      <Label>Display Time In</Label>
                      <Select
                        value={timezoneForm.preference}
                        onValueChange={(value: 'local' | 'utc') =>
                          setTimezoneForm((prev) => ({
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
                            My Timezone {timezoneForm.local_timezone ? `(${timezoneForm.local_timezone})` : ''}
                          </SelectItem>
                          <SelectItem value="utc">UTC</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {timezoneForm.preference === 'local' ? (
                      <div className="space-y-2">
                        <Label htmlFor="local-timezone">Local Timezone</Label>
                        <Input
                          id="local-timezone"
                          placeholder="e.g. America/New_York"
                          value={timezoneForm.local_timezone ?? ''}
                          onChange={(event) =>
                            setTimezoneForm((prev) => ({
                              ...prev,
                              local_timezone: event.target.value,
                            }))
                          }
                          required
                        />
                        {detectedTimezone ? (
                          <button
                            type="button"
                            className="text-sm text-primary underline-offset-4 hover:underline"
                            onClick={() =>
                              setTimezoneForm((prev) => ({
                                ...prev,
                                local_timezone: detectedTimezone,
                              }))
                            }
                          >
                            Use detected timezone ({detectedTimezone})
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="space-y-2">
                      <Label>Time Format</Label>
                      <Select
                        value={timezoneForm.time_format}
                        onValueChange={(value: '12' | '24') =>
                          setTimezoneForm((prev) => ({
                            ...prev,
                            time_format: value,
                          }))
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
                    {timezoneError ? (
                      <Alert variant="destructive">
                        <AlertDescription>{timezoneError}</AlertDescription>
                      </Alert>
                    ) : null}
                    <Button type="submit" disabled={timezoneSubmitting} className="w-full sm:w-auto">
                      {timezoneSubmitting ? 'Saving…' : 'Save Preferences'}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminAccountPage;
