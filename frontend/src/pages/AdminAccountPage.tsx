import { UsernameChangeCard } from '../components/users/UsernameChangeCard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, requestJson } from '@/util/apiClient';
import { useAuth } from '../contexts/AuthContext';
import { AccountEmailCard } from '../components/users/AccountEmailCard';
import { PasswordChangeCard } from '../components/users/PasswordChangeCard';
import { PlexConnectionCard } from '../components/users/PlexConnectionCard';
import { fetchPersonalProfile } from '../lib/plexConnection';
import { useAlerts } from '../contexts/AlertContext';
import { AccountDisplayCard } from '../components/users/AccountDisplayCard';
import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { UserPreferencesCard } from '../components/users/UserPreferencesCard';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowRightArrowLeft, faUserShield, faCircleInfo, faKey, faClock } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

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

type AccountCapabilities = {
  can_set_initial_credentials: boolean;
  can_change_password: boolean;
};

type AccountResponse = {
  data: {
    user: AccountUser;
    capabilities: AccountCapabilities;
  };
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
      const response = await requestJson<AccountResponse>('/api/account/initial-credentials', {
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

// --- Main Page Component ---

const AdminAccountPage = () => {
  const { user } = useAuth();
  const { formatTimestamp: formatIsoDate } = useAccountDisplay();
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();

  // Use TanStack Router search for tab state
  const search = useSearch({ strict: false }) as { tab?: TabType };
  const activeTab: TabType = search.tab ?? 'overview';

  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<AccountResponse['data'] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const accountLoad = useRef(0);


  const refreshAccount = useCallback(async () => {
    const run = ++accountLoad.current;
    setLoading(true);
    setAccount(null);
    setFetchError(null);
    try {
      const profile = await fetchPersonalProfile();
      if (run !== accountLoad.current) return;
      if (profile.uuid !== user?.uuid) throw new Error('The signed-in account changed. Reload your profile.');
      setAccount({user:{uuid:profile.uuid,username:profile.username,email:profile.email,display_name:profile.username,user_type:profile.user_type,has_password:profile.has_password,force_password_change:profile.force_password_change,last_login_at:profile.last_login_at},capabilities:{can_set_initial_credentials:false,can_change_password:profile.password_change_available}});
    } catch (error) {
      const message = getApiErrorMessage(error);
      if (run === accountLoad.current) setFetchError(message);
    } finally {
      if (run === accountLoad.current) setLoading(false);
    }
  }, [user?.uuid]);

  // Fetch account data on mount only
  useEffect(() => {
    void refreshAccount();
    return () => {accountLoad.current++;};
  }, [refreshAccount]);

  const showInitialCredentialsCard = useMemo(() => {
    if (!account) return false;
    return account.capabilities.can_set_initial_credentials;
  }, [account]);

  const setTab = (tab: TabType) => {
    void navigate({href:`/admin/account?tab=${encodeURIComponent(tab)}`,replace:true});
  };

  const handleCredentialsSuccess = (response: AccountResponse) => {
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
          <p className="text-sm text-muted-foreground">Local password and username changes sign out all sessions. Contact email changes require your current local password.</p>
          <fieldset className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            {showInitialCredentialsCard && (
              <InitialCredentialsForm
                key={`credentials-${accountKey}`}
                initialUsername={account.user.username ?? ''}
                onSuccess={handleCredentialsSuccess}
              />
            )}
            <PasswordChangeCard key={`password-${accountKey}`} />
            <UsernameChangeCard key={`username-${accountKey}`} />
          </div>

          <AccountEmailCard key={`email-${accountKey}`} onChanged={refreshAccount} />

          </fieldset>
          <PlexConnectionCard />
        </TabsContent>

        <TabsContent value="preferences" className="space-y-6">
          <AccountDisplayCard />
          <UserPreferencesCard />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminAccountPage;
