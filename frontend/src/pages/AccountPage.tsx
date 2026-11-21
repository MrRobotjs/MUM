import { UsernameChangeCard } from '../components/users/UsernameChangeCard';
import { CardActions } from '../components/common/CardActions';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingHeader, TabHeading } from '../components/users/AccountSettings';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, requestJson } from '@/util/apiClient';
import { useAuth } from '../contexts/AuthContext';
import { AccountEmailCard } from '../components/users/AccountEmailCard';
import { PasswordChangeCard } from '../components/users/PasswordChangeCard';
import { PlexConnectionCard } from '../components/users/PlexConnectionCard';
import { ServiceLinksCard } from '../components/users/ServiceLinksCard';
import { DiscordLinkCard } from '../components/users/DiscordLinkCard';
import { getServiceLinks, type SignInServer } from '../lib/serviceSignIn';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchPersonalProfile } from '../lib/plexConnection';
import { useAlerts } from '../contexts/AlertContext';
import { AccountDisplayCard } from '../components/users/AccountDisplayCard';
import { useAccountDisplay } from '../hooks/useAccountDisplay';
import { UserPreferencesCard } from '../components/users/UserPreferencesCard';
import { faKey, faLink, faSliders, faUser } from '@fortawesome/free-solid-svg-icons';
import './AccountPage.css';

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

type TabType = 'overview' | 'credentials' | 'linked-accounts' | 'preferences';

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
  // Setting the first MUM password proves a linked server login again.
  const [verifyServers, setVerifyServers] = useState<SignInServer[] | null>(null);
  const [verification, setVerification] = useState({ server: '', username: '', password: '' });

  useEffect(() => {
    let current = true;
    getServiceLinks().then((value) => {
      if (!current) return;
      const linked = new Set(value.links.map((link) => link.serverId));
      setVerifyServers(value.servers.filter((server) => linked.has(server.id)));
    }, () => { if (current) setVerifyServers([]); });
    return () => { current = false; };
  }, []);
  const verifyServer = verifyServers?.find((server) => String(server.id) === verification.server);

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
          ...(verifyServer ? { verification: { server_id: verifyServer.id, username: verification.username, password: verification.password } } : {}),
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
      <SettingHeader title="MUM username & password" summary="Not set" info={<>
        <p>Add a MUM username and password, so you can also sign in without your media server login.</p>
        <p>To confirm it is you, sign in to one of your linked server accounts below. If you signed in with Plex, sign in again within five minutes before saving.</p>
      </>} />
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
              minLength={12}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="initial-confirm-password">Confirm password</Label>
            <Input
              id="initial-confirm-password"
              type="password"
              value={form.confirmPassword}
              onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
              required
              minLength={12}
            />
          </div>
          {verifyServers && verifyServers.length > 0 ? (
            <div className="space-y-4 rounded-md border p-4">
              <div className="space-y-2">
                <Label htmlFor="verify-server">Server</Label>
                <Select value={verification.server} onValueChange={(value) => setVerification((prev) => ({ ...prev, server: value }))}>
                  <SelectTrigger id="verify-server" className="w-full">
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {verifyServers.map((server) => (
                      <SelectItem key={server.id} value={String(server.id)}>{server.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="verify-username">Server username</Label>
                <Input id="verify-username" autoComplete="off" value={verification.username} required onChange={(event) => setVerification((prev) => ({ ...prev, username: event.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="verify-password">Server password</Label>
                <Input id="verify-password" type="password" autoComplete="off" value={verification.password} required onChange={(event) => setVerification((prev) => ({ ...prev, password: event.target.value }))} />
              </div>
            </div>
          ) : verifyServers ? (
            <p className="text-sm text-muted-foreground">If you signed in with Plex, sign in again within five minutes before saving.</p>
          ) : null}
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <CardActions>
            <Button type="submit" disabled={submitting || (verifyServers !== null && verifyServers.length > 0 && !verifyServer)}>
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </CardActions>
        </form>
      </CardContent>
    </Card>
  );
};

// --- Main Page Component ---

const AccountPage = () => {
  const { user, isOwner, hasAdminAccess } = useAuth();
  const { formatTimestamp: formatIsoDate } = useAccountDisplay();
  const { success, error: showError } = useAlerts();
  const navigate = useNavigate();

  // Use TanStack Router search for tab state
  const search = useSearch({ strict: false }) as { tab?: TabType };
  const activeTab: TabType = search.tab ?? 'overview';
  const tabsRef = useRef<HTMLDivElement>(null);

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
      setAccount({user:{uuid:profile.uuid,username:profile.username,email:profile.email,display_name:profile.display_name||profile.username,user_type:profile.user_type,has_password:profile.has_password,force_password_change:profile.force_password_change,last_login_at:profile.last_login_at},capabilities:{can_set_initial_credentials:profile.initial_credentials_available===true,can_change_password:profile.password_change_available}});
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

  useEffect(() => {
    const list = tabsRef.current;
    const selected = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !selected) return;
    const left = selected.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + selected.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + selected.offsetWidth - list.clientWidth;
  }, [activeTab, loading]);

  const showInitialCredentialsCard = useMemo(() => {
    if (!account) return false;
    return account.capabilities.can_set_initial_credentials;
  }, [account]);

  const setTab = (tab: TabType) => {
    void navigate({href:`/account?tab=${encodeURIComponent(tab)}`,replace:true});
  };

  const handleCredentialsSuccess = (response: AccountResponse) => {
    setAccount(response.data);
  };

  if (loading && !account) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-8" aria-label="Loading account settings">
        <div className="flex items-center gap-6 py-4"><Skeleton className="size-20 rounded-full" /><div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-4 w-56" /></div></div>
        <Skeleton className="h-12 w-full" />
        <div className="space-y-6"><Skeleton className="h-6 w-40" /><Skeleton className="h-32 w-full" /><Skeleton className="h-48 w-full" /></div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="mx-auto w-full max-w-6xl space-y-6">
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

  const displayName = account.user.display_name || account.user.username || 'MUM User';
  const accountRole = isOwner ? 'Owner' : hasAdminAccess ? 'Administrator' : 'User';
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase();

  return (
    <div className="account-settings mx-auto w-full max-w-6xl space-y-8">
      <header className="flex min-w-0 items-center gap-4 py-4 sm:gap-6">
        <div aria-hidden="true" className="flex size-16 shrink-0 items-center justify-center rounded-full bg-primary/15 text-2xl font-semibold text-primary sm:size-20 sm:text-3xl">{initials}</div>
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="max-w-full break-words text-xl font-semibold text-primary sm:text-2xl">{displayName}</h1>
            {account.user.email && <p className="break-all text-base text-muted-foreground">({account.user.email})</p>}
          </div>
          <p className="text-sm text-muted-foreground">Last signed in {formatIsoDate(account.user.last_login_at)}</p>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as TabType)} className="gap-8">
        <TabsList ref={tabsRef} aria-label="Account settings" className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="credentials">Credentials</TabsTrigger>
          <TabsTrigger value="linked-accounts">Linked accounts</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <TabHeading icon={faUser} title="General settings" description="Your profile and contact details" />
          <dl className="account-settings-details">
            <div><dt>Username</dt><dd>{account.user.username || 'Not configured'}</dd></div>
            <div><dt>Role</dt><dd>{accountRole}</dd></div>
            <div><dt>MUM password</dt><dd>{account.user.has_password ? 'Configured' : 'Not configured'}</dd></div>
          </dl>
          <div className="account-settings-panels border-t pt-8">
            <AccountEmailCard key={`email-${accountKey}`} onChanged={refreshAccount} />
          </div>
        </TabsContent>

        <TabsContent value="credentials" className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <TabHeading icon={faKey} title="Credentials" description="How you sign in to MUM" />
          <div className="account-settings-panels">
            {showInitialCredentialsCard && <InitialCredentialsForm key={`credentials-${accountKey}`} initialUsername={account.user.username ?? ''} onSuccess={handleCredentialsSuccess} />}
            <PasswordChangeCard key={`password-${accountKey}`} />
            <UsernameChangeCard key={`username-${accountKey}`} />
          </div>
        </TabsContent>

        <TabsContent value="linked-accounts" className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <TabHeading icon={faLink} title="Linked accounts" description="Other accounts you can sign in with" />
          <div className="account-settings-panels account-settings-linked">
            <PlexConnectionCard />
            <DiscordLinkCard />
            <ServiceLinksCard />
          </div>
        </TabsContent>

        <TabsContent value="preferences" className="space-y-8 rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
          <TabHeading icon={faSliders} title="Preferences" description="How dates, times and badges appear for you" />
          <div className="account-settings-panels">
            <AccountDisplayCard />
            <UserPreferencesCard />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AccountPage;
