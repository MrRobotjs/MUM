import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import clsx from 'clsx';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { useAlerts } from '../contexts/AlertContext';

type WizardStep = {
  id: string;
  name: string;
  icon: string;
  required: boolean;
  completed: boolean;
  server_id?: number;
  server_name?: string;
  server_type?: string;
  username_conflict?: boolean;
};

type PlexUser = {
  username?: string;
  email?: string;
  uuid?: string;
  thumb?: string;
};

type PlexConflict = {
  type?: 'can_link' | 'already_linked' | 'already_exists_no_linking' | string;
  plex_username?: string;
  plex_email?: string;
  message?: string;
};

type WizardServerCredentials = {
  username?: string;
  email?: string;
  password?: string;
};

type WizardServer = {
  id: number;
  name: string;
  service_type: string;
  completed: boolean;
  credentials: WizardServerCredentials | null;
  libraries: { id: string; name: string }[];
  username_conflict?: boolean;
  access_url?: string | null;
};

type WizardAccount = {
  allowed: boolean;
  completed: boolean;
  data: {
    username?: string | null;
    email?: string | null;
    password?: string | null;
  } | null;
  preferences: {
    use_same_username: boolean;
    use_same_email: boolean;
    use_same_password: boolean;
  };
};

type WizardState = {
  invite: {
    id: number;
    token: string;
    custom_path: string | null;
    expires_at: string | null;
    max_uses: number | null;
    current_uses: number;
    is_active: boolean;
    allow_downloads: boolean;
    grant_library_ids: string[] | null;
    require_discord_auth: boolean;
    require_discord_guild_membership: boolean;
    server_count: number;
  };
  steps: WizardStep[];
  next_step_id: string | null;
  plex: {
    has_plex_servers: boolean;
    authenticated: boolean;
    user: PlexUser | null;
    conflict: PlexConflict | null;
  };
  discord: {
    oauth_enabled: boolean;
    requires_auth: boolean;
    requires_guild: boolean;
    authenticated: boolean;
    user: {
      username?: string;
      email?: string;
      id?: string;
      discriminator?: string;
    } | null;
    guild_id?: string | null;
    invite_url?: string | null;
  };
  account: WizardAccount;
  servers: WizardServer[];
  meta: {
    server_label: string;
    has_multiple_servers: boolean;
  };
};

type WizardResponse = {
  data: WizardState;
};

type CompletionResponse = {
  data: {
    username: string;
    servers: {
      name: string;
      service_type: string;
      access_url?: string | null;
    }[];
    state: WizardState;
  };
};

type ApiError = Error & {
  details?: Record<string, string[]>;
};

const fetchJson = async <T = unknown>(endpoint: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(endpoint, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {})
    },
    ...init
  });

  const contentType = response.headers.get('Content-Type') || '';
  const isJson = contentType.includes('application/json');
  const data = (isJson ? await response.json() : null) as T | { error?: { message?: string; details?: Record<string, string[]> } };

  if (!response.ok) {
    const errorMessage =
      (data && typeof data === 'object' && 'error' in data && data.error?.message) || response.statusText || 'Request failed';
    const error = new Error(errorMessage) as ApiError;
    if (data && typeof data === 'object' && 'error' in data && data.error?.details) {
      error.details = data.error.details;
    }
    throw error;
  }

  return data as T;
};

type AccountFormState = {
  username: string;
  email: string;
  password: string;
  confirm_password: string;
  use_same_username: boolean;
  use_same_email: boolean;
  use_same_password: boolean;
};

type ServerFormState = {
  username: string;
  email: string;
  password: string;
  password_confirm: string;
};

const defaultAccountFormState: AccountFormState = {
  username: '',
  email: '',
  password: '',
  confirm_password: '',
  use_same_username: true,
  use_same_email: true,
  use_same_password: true
};

export const InviteWizardPage = () => {
  const { token = '' } = useParams<{ token: string }>();
  const { success, error: showError } = useAlerts();

  const [state, setState] = useState<WizardState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountForm, setAccountForm] = useState<AccountFormState>(defaultAccountFormState);
  const [accountErrors, setAccountErrors] = useState<Record<string, string[]>>({});
  const [serverForms, setServerForms] = useState<Record<number, ServerFormState>>({});
  const [savingAccount, setSavingAccount] = useState(false);
  const [savingServerId, setSavingServerId] = useState<number | null>(null);
  const [startingPlex, setStartingPlex] = useState(false);
  const [startingDiscord, setStartingDiscord] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completion, setCompletion] = useState<CompletionResponse['data'] | null>(null);

  const loadState = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJson<WizardResponse>(`/api/v2/public/invite/${encodeURIComponent(token)}/wizard`);
      setState(response.data);
    } catch (err) {
      setError((err as Error).message || 'Failed to load invite');
      setState(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state) return;
    const nextAccount: AccountFormState = {
      username: state.account.data?.username ?? '',
      email: state.account.data?.email ?? '',
      password: '',
      confirm_password: '',
      use_same_username: state.account.preferences.use_same_username,
      use_same_email: state.account.preferences.use_same_email,
      use_same_password: state.account.preferences.use_same_password
    };
    setAccountForm(nextAccount);

    const nextServerForms: Record<number, ServerFormState> = {};
    state.servers.forEach((server) => {
      nextServerForms[server.id] = {
        username: server.credentials?.username ?? '',
        email: server.credentials?.email ?? '',
        password: server.credentials?.password ?? '',
        password_confirm: ''
      };
    });
    setServerForms(nextServerForms);
  }, [state]);

  const handleAccountSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state) return;

    if (accountForm.password !== accountForm.confirm_password) {
      setAccountErrors({ confirm_password: ['Passwords do not match'] });
      return;
    }

    setSavingAccount(true);
    setAccountErrors({});
    try {
      const payload = {
        username: accountForm.username,
        email: accountForm.email,
        password: accountForm.password,
        confirm_password: accountForm.confirm_password,
        use_same_username: accountForm.use_same_username,
        use_same_email: accountForm.use_same_email,
        use_same_password: accountForm.use_same_password
      };
      const response = await fetchJson<WizardResponse>(`/api/v2/public/invite/${encodeURIComponent(token)}/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      setState(response.data);
      success('Account details saved');
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.details) {
        setAccountErrors(apiError.details);
      }
      showError('Failed to save account: ' + apiError.message);
    } finally {
      setSavingAccount(false);
    }
  };

  const handleStartPlex = async () => {
    if (!state) return;
    setStartingPlex(true);
    try {
      const response = await fetchJson<{ data: { redirect_url?: string; state: WizardState } }>(
        `/api/v2/public/invite/${encodeURIComponent(token)}/plex/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ return_path: `/invite/${token}` })
        }
      );
      if (response.data.state) {
        setState(response.data.state);
      }
      const redirect = response.data.redirect_url;
      if (redirect) {
        window.location.href = redirect;
      }
    } catch (err) {
      showError('Plex login failed: ' + (err as Error).message);
    } finally {
      setStartingPlex(false);
    }
  };

  const handleResolvePlex = async (action: 'link_existing' | 'use_different') => {
    try {
      const response = await fetchJson<WizardResponse>(`/api/v2/public/invite/${encodeURIComponent(token)}/plex/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      });
      setState(response.data);
      success('Plex account updated');
    } catch (err) {
      showError('Unable to update Plex account: ' + (err as Error).message);
    }
  };

  const handleStartDiscord = async () => {
    if (!state) return;
    setStartingDiscord(true);
    try {
      const response = await fetchJson<{ data: { redirect_url?: string; state: WizardState } }>(
        `/api/v2/public/invite/${encodeURIComponent(token)}/discord/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ return_path: `/invite/${token}` })
        }
      );
      if (response.data.state) {
        setState(response.data.state);
      }
      const redirect = response.data.redirect_url;
      if (redirect) {
        window.location.href = redirect;
      }
    } catch (err) {
      showError('Discord login failed: ' + (err as Error).message);
    } finally {
      setStartingDiscord(false);
    }
  };

  const updateServerForm = (serverId: number, field: keyof ServerFormState, value: string) => {
    setServerForms((prev) => ({
      ...prev,
      [serverId]: {
        ...prev[serverId],
        [field]: value
      }
    }));
  };

  const handleSaveServer = async (serverId: number) => {
    const form = serverForms[serverId];
    if (!form) return;

    if (form.password !== form.password_confirm) {
      showError('Passwords do not match');
      return;
    }

    setSavingServerId(serverId);
    try {
      const response = await fetchJson<WizardResponse>(
        `/api/v2/public/invite/${encodeURIComponent(token)}/server/${serverId}/credentials`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username,
            email: form.email,
            password: form.password,
            completed: true
          })
        }
      );
      setState(response.data);
      success('Server saved');
    } catch (err) {
      showError('Failed to save server: ' + (err as Error).message);
    } finally {
      setSavingServerId(null);
    }
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      const response = await fetchJson<CompletionResponse>(`/api/v2/public/invite/${encodeURIComponent(token)}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      setState(response.data.state);
      setCompletion(response.data);
    } catch (err) {
      showError('Invite not ready: ' + (err as Error).message);
    } finally {
      setCompleting(false);
    }
  };

  const activeStepIndex = useMemo(() => {
    if (!state?.steps) return -1;
    const firstIncomplete = state.steps.findIndex((step) => !step.completed);
    return firstIncomplete >= 0 ? firstIncomplete : state.steps.length;
  }, [state]);

  const completedCount = useMemo(() => {
    if (!state?.steps) return 0;
    return state.steps.filter((step) => step.completed).length;
  }, [state]);

  const allStepsComplete = useMemo(() => {
    if (!state?.steps) return false;
    return state.steps.every((step) => step.completed || !step.required);
  }, [state]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-3">
          <span className="loading loading-spinner loading-md" />
          <span className="text-lg">Loading invite…</span>
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="bg-card border border-destructive/30 rounded-xl shadow-lg overflow-hidden max-w-md w-full">
          <div className="bg-error/10 border-b border-error/20 p-6 text-center">
            <div className="w-16 h-16 rounded-full bg-error/20 flex items-center justify-center mx-auto mb-4">
              <i className="fa-solid fa-circle-xmark text-error text-2xl" />
            </div>
            <h1 className="text-2xl font-bold text-error mb-2">Invite Problem</h1>
            <p className="text-muted-foreground text-sm">There was an issue with your invite</p>
          </div>
          <div className="p-6 text-center">
            <p className="text-foreground mb-6">{error ?? 'Unable to load this invite link.'}</p>
            <Button onClick={() => loadState()} variant="outline">
              <i className="fa-solid fa-rotate-right mr-2" />
              Try Again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (completion) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-2xl">
          <div className="bg-gradient-to-br from-success/10 to-primary/10 border border-success/20 rounded-xl p-8 shadow-lg">
            <div className="text-center mb-8">
              <div className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-6">
                <i className="fa-solid fa-check-circle text-success text-3xl" />
              </div>
              <h2 className="text-3xl font-bold text-success mb-3">Welcome, {completion.username}!</h2>
              <p className="text-muted-foreground text-lg">Your invitation has been completed successfully</p>
            </div>

            {state.plex.authenticated || state.discord.authenticated ? (
              <div className="space-y-3 mb-8">
                {state.plex.authenticated && state.plex.user && (
                  <div className="bg-[#e5a00d]/10 border border-[#e5a00d]/20 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-[#e5a00d]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <i className="fa-solid fa-right-to-bracket text-[#e5a00d] text-xs" />
                      </div>
                      <div>
                        <h4 className="font-medium text-[#e5a00d] mb-1">Plex Account Connected</h4>
                        <p className="text-sm text-foreground/80">
                          Authenticated as <strong>{state.plex.user.username}</strong>
                        </p>
                      </div>
                    </div>
                  </div>
                )}
                {state.discord.authenticated && state.discord.user && (
                  <div className="bg-[#5865F2]/10 border border-[#5865F2]/20 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <i className="fa-brands fa-discord text-[#5865F2] text-xs" />
                      </div>
                      <div>
                        <h4 className="font-medium text-[#5865F2] mb-1">Discord Account Connected</h4>
                        <p className="text-sm text-foreground/80">
                          Linked as <strong>{state.discord.user.username}</strong>
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="bg-muted/50 border border rounded-lg p-6 mb-8">
              <div className="flex items-center justify-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-success/20 flex items-center justify-center">
                  <i className="fa-solid fa-server text-success text-sm" />
                </div>
                <h3 className="font-medium text-foreground text-lg">Media Server Access</h3>
              </div>
              <div className="space-y-2">
                {completion.servers.map((server) => (
                  <div key={server.name} className="flex items-center justify-between gap-2 text-sm bg-card rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full bg-success/20 flex items-center justify-center">
                        <i className="fa-solid fa-check text-success text-xs" />
                      </div>
                      <span className="font-medium">{server.name}</span>
                      <span className="text-xs text-muted-foreground">({server.service_type})</span>
                    </div>
                    {server.access_url && (
                      <Button asChild variant="ghost" size="sm">
                        <a href={server.access_url} target="_blank" rel="noreferrer" className="gap-1">
                          Open
                          <i className="fa-solid fa-external-link-alt text-xs" />
                        </a>
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="text-center text-sm text-muted-foreground">
              <p>You can now access all the servers listed above with your credentials</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        <div className="bg-card border border rounded-xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 text-center border-b border">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4">
              <i className="fa-solid fa-envelope-open-text text-primary text-2xl" />
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">You're Invited!</h1>
            <p className="text-muted-foreground text-sm">
              Join <strong className="text-primary">{state.meta.server_label}</strong> and start streaming
            </p>
          </div>

          {/* Content */}
          <div className="p-6 sm:p-8">
            {/* Progress Steps */}
            {state.steps.length > 0 && (
              <div className="mb-8">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-medium text-foreground">Setup Progress</h2>
                  <span className="text-sm text-muted-foreground">
                    {completedCount} of {state.steps.length} completed
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {state.steps.map((step, index) => {
                    const isActive = index === activeStepIndex;
                    return (
                      <div key={step.id} className="flex items-center flex-1">
                        <div
                          className={clsx(
                            'flex items-center gap-2 p-3 rounded-lg transition-colors flex-1',
                            step.completed
                              ? 'bg-primary/10 border border-primary/20'
                              : isActive
                              ? 'bg-warning/10 border border-warning/20'
                              : 'bg-muted/50 border border'
                          )}
                        >
                          <div
                            className={clsx(
                              'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
                              step.completed
                                ? 'bg-primary text-primary-content'
                                : isActive
                                ? 'bg-warning text-warning-content'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            {step.completed ? (
                              <i className="fa-solid fa-check text-xs" />
                            ) : isActive ? (
                              <i className="fa-solid fa-circle text-xs" />
                            ) : (
                              <i className={`${step.icon} text-xs`} />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span
                              className={clsx(
                                'text-xs font-medium block truncate',
                                step.completed
                                  ? 'text-primary'
                                  : isActive
                                  ? 'text-warning'
                                  : 'text-muted-foreground'
                              )}
                            >
                              {step.name}
                            </span>
                            {!step.required && (
                              <span className="text-xs text-muted-foreground">Optional</span>
                            )}
                          </div>
                        </div>
                        {index < state.steps.length - 1 && (
                          <div
                            className={clsx(
                              'w-3 h-0.5 mx-1',
                              step.completed ? 'bg-primary' : 'bg-muted'
                            )}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Step Content */}
            <div className="step-content space-y-6">
              {/* User Account Step */}
              {state.account.allowed && !state.account.completed && (
                <div className="bg-muted/50 border border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <i className="fa-solid fa-user-plus text-primary text-lg" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">Set Up Your Account</h2>
                      <p className="text-sm text-muted-foreground">
                        Configure your account details - your account will be created when you complete all steps
                      </p>
                    </div>
                  </div>

                  <form onSubmit={handleAccountSubmit} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="username">Username</Label>
                        <Input
                          id="username"
                          value={accountForm.username}
                          onChange={(e) => setAccountForm((prev) => ({ ...prev, username: e.target.value }))}
                          required
                          className={accountErrors.username ? 'border-error' : ''}
                        />
                        {accountErrors.username && (
                          <p className="text-xs text-error">{accountErrors.username.join(', ')}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="email">Email</Label>
                        <Input
                          id="email"
                          type="email"
                          value={accountForm.email}
                          onChange={(e) => setAccountForm((prev) => ({ ...prev, email: e.target.value }))}
                          required
                          className={accountErrors.email ? 'border-error' : ''}
                        />
                        {accountErrors.email && (
                          <p className="text-xs text-error">{accountErrors.email.join(', ')}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="password">Password</Label>
                        <Input
                          id="password"
                          type="password"
                          value={accountForm.password}
                          onChange={(e) => setAccountForm((prev) => ({ ...prev, password: e.target.value }))}
                          required
                          className={accountErrors.password ? 'border-error' : ''}
                        />
                        {accountErrors.password && (
                          <p className="text-xs text-error">{accountErrors.password.join(', ')}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="confirm_password">Confirm Password</Label>
                        <Input
                          id="confirm_password"
                          type="password"
                          value={accountForm.confirm_password}
                          onChange={(e) => setAccountForm((prev) => ({ ...prev, confirm_password: e.target.value }))}
                          required
                          className={accountErrors.confirm_password ? 'border-error' : ''}
                        />
                        {accountErrors.confirm_password && (
                          <p className="text-xs text-error">{accountErrors.confirm_password.join(', ')}</p>
                        )}
                      </div>
                    </div>

                    <div className="bg-info/10 border border-info/20 rounded-lg p-4 mt-6">
                      <div className="flex items-start gap-3 mb-4">
                        <div className="w-6 h-6 rounded-full bg-info/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <i className="fa-solid fa-link text-info text-xs" />
                        </div>
                        <div>
                          <h4 className="font-medium text-info mb-1">Cross-Server Convenience</h4>
                          <p className="text-sm text-foreground/80">
                            Use the same credentials across all media servers for easier access
                          </p>
                        </div>
                      </div>

                      <div className="space-y-3">
                        <label className="flex items-center gap-3 cursor-pointer">
                          <Checkbox
                            checked={accountForm.use_same_username}
                            onCheckedChange={(checked) =>
                              setAccountForm((prev) => ({ ...prev, use_same_username: checked === true }))
                            }
                          />
                          <div>
                            <span className="text-sm font-medium">Use same username across servers</span>
                            <p className="text-xs text-muted-foreground">
                              Your local account username will be used for all media servers (if available)
                            </p>
                          </div>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <Checkbox
                            checked={accountForm.use_same_email}
                            onCheckedChange={(checked) =>
                              setAccountForm((prev) => ({ ...prev, use_same_email: checked === true }))
                            }
                          />
                          <div>
                            <span className="text-sm font-medium">Use same email across servers</span>
                            <p className="text-xs text-muted-foreground">
                              Your local account email will be used for all media servers
                            </p>
                          </div>
                        </label>

                        <label className="flex items-center gap-3 cursor-pointer">
                          <Checkbox
                            checked={accountForm.use_same_password}
                            onCheckedChange={(checked) =>
                              setAccountForm((prev) => ({ ...prev, use_same_password: checked === true }))
                            }
                          />
                          <div>
                            <span className="text-sm font-medium">Use same password across servers</span>
                            <p className="text-xs text-muted-foreground">
                              Your local account password will be used for all media servers
                            </p>
                          </div>
                        </label>
                      </div>
                    </div>

                    <div className="pt-4">
                      <Button type="submit" className="w-full h-12" disabled={savingAccount}>
                        {savingAccount ? (
                          <>
                            <span className="loading loading-spinner loading-xs mr-2" />
                            Saving...
                          </>
                        ) : (
                          <>
                            <i className="fa-solid fa-save mr-2" />
                            Save Account Details & Continue
                          </>
                        )}
                      </Button>
                    </div>
                  </form>
                </div>
              )}

              {/* Discord Step */}
              {state.discord.oauth_enabled && !state.discord.authenticated && state.account.completed && (
                <div className="bg-muted/50 border border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0">
                      <i className="fa-brands fa-discord text-[#5865F2] text-lg" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">Discord Authentication</h2>
                      <p className="text-sm text-muted-foreground">
                        {state.discord.requires_auth ? 'Required to continue with your invite' : 'Optional - Connect your Discord account'}
                      </p>
                      {!state.discord.requires_auth && (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-muted/50 text-muted-foreground mt-1">
                          Optional
                        </span>
                      )}
                    </div>
                  </div>

                  {state.discord.requires_guild && (
                    <div className="bg-[#5865F2]/10 border border-[#5865F2]/20 rounded-lg p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="w-6 h-6 rounded-full bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <i className="fa-solid fa-info text-[#5865F2] text-xs" />
                        </div>
                        <div>
                          <h4 className="font-medium text-[#5865F2] mb-1">Discord Server Required</h4>
                          <p className="text-sm text-foreground/80 mb-3">
                            You must be a member of our Discord server to accept this invite.
                          </p>
                          {state.discord.invite_url && (
                            <Button
                              asChild
                              size="sm"
                              className="bg-[#5865F2] text-white hover:bg-[#4752C4]"
                            >
                              <a href={state.discord.invite_url} target="_blank" rel="noopener noreferrer" className="gap-2">
                                <i className="fa-brands fa-discord" />
                                Join Discord Server First
                                <i className="fa-solid fa-external-link-alt text-xs" />
                              </a>
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

          <Button
            onClick={handleStartDiscord}
            disabled={startingDiscord}
            className="w-full h-12 bg-[#5865F2] hover:bg-[#4752C4] text-white"
          >
            {startingDiscord ? (
              <>
                <span className="loading loading-spinner loading-xs mr-2" />
                Preparing...
              </>
                    ) : (
                      <>
                        <i className="fa-brands fa-discord mr-2" />
                        Continue with Discord
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* Plex Step */}
              {state.plex.has_plex_servers && !state.plex.authenticated && (state.discord.authenticated || !state.discord.oauth_enabled) && state.account.completed && (
                <div className="bg-muted/50 border border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-[#e5a00d]/20 flex items-center justify-center flex-shrink-0">
                      <svg className="w-5 h-5 text-[#e5a00d]" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                        <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">Plex Authentication</h2>
                      <p className="text-sm text-muted-foreground">
                        Sign in with Plex to get access to shared libraries
                      </p>
                    </div>
                  </div>

                  {state.plex.conflict && (
                    <div className="bg-warning/10 border border-warning/20 rounded-lg p-4 mb-6">
                      {state.plex.conflict.type === 'can_link' ? (
                        <div className="space-y-3">
                          <div className="flex items-start gap-3">
                            <i className="fa-solid fa-exclamation-triangle text-warning mt-0.5" />
                            <div>
                              <p className="text-sm">
                                We found an existing local account for <strong>{state.plex.conflict.plex_username}</strong>.
                                You can link it or use a different Plex account.
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => handleResolvePlex('link_existing')}
                            >
                              Link Existing
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleResolvePlex('use_different')}
                            >
                              Use Different Account
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm">
                          {state.plex.conflict.message ?? 'Plex account conflict detected. Please try a different account.'}
                        </p>
                      )}
                    </div>
                  )}

                  <Button
                    onClick={handleStartPlex}
                    disabled={startingPlex}
                    className="w-full h-12 bg-[#e5a00d] hover:bg-[#cc8f0a] text-white"
                  >
                    {startingPlex ? (
                      <>
                        <span className="loading loading-spinner loading-xs mr-2" />
                        Preparing...
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4 mr-2" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
                        </svg>
                        Continue with Plex
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* Server Credentials */}
              {state.servers.filter((s) => !s.completed && s.service_type !== 'PLEX').map((server) => (
                <div key={server.id} className="bg-muted/50 border border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <i className="fa-solid fa-server text-primary text-lg" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">
                        {server.name}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Setting up access to {server.service_type}
                      </p>
                    </div>
                  </div>

                  {server.username_conflict && (
                    <div className="bg-warning/10 border border-warning/20 rounded-lg p-3 mb-4">
                      <div className="flex items-start gap-2">
                        <i className="fa-solid fa-exclamation-triangle text-warning text-sm mt-0.5" />
                        <div className="text-sm">
                          <p className="font-medium text-warning mb-1">Username Not Available</p>
                          <p className="text-foreground/80">
                            The username is already taken on {server.name}. Please choose a different username.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor={`server-${server.id}-username`}>Username</Label>
                      <Input
                        id={`server-${server.id}-username`}
                        value={serverForms[server.id]?.username ?? ''}
                        onChange={(e) => updateServerForm(server.id, 'username', e.target.value)}
                        required
                      />
                    </div>

                    {server.service_type === 'KAVITA' && (
                      <div className="space-y-2">
                        <Label htmlFor={`server-${server.id}-email`}>Email</Label>
                        <Input
                          id={`server-${server.id}-email`}
                          type="email"
                          value={serverForms[server.id]?.email ?? ''}
                          onChange={(e) => updateServerForm(server.id, 'email', e.target.value)}
                          required
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor={`server-${server.id}-password`}>Password</Label>
                      <Input
                        id={`server-${server.id}-password`}
                        type="password"
                        value={serverForms[server.id]?.password ?? ''}
                        onChange={(e) => updateServerForm(server.id, 'password', e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`server-${server.id}-password-confirm`}>Confirm Password</Label>
                      <Input
                        id={`server-${server.id}-password-confirm`}
                        type="password"
                        value={serverForms[server.id]?.password_confirm ?? ''}
                        onChange={(e) => updateServerForm(server.id, 'password_confirm', e.target.value)}
                        required
                      />
                    </div>

                    <Button
                      onClick={() => handleSaveServer(server.id)}
                      disabled={savingServerId === server.id}
                      className="w-full h-12"
                    >
                      {savingServerId === server.id ? (
                        <>
                          <span className="loading loading-spinner loading-xs mr-2" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <i className="fa-solid fa-user-plus mr-2" />
                          Create Account on {server.name}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              ))}

              {/* Complete Button */}
              {allStepsComplete && (
                <div className="bg-gradient-to-br from-success/10 to-primary/10 border border-success/20 rounded-lg p-8">
                  <div className="text-center mb-8">
                    <div className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-6">
                      <i className="fa-solid fa-check-circle text-success text-3xl" />
                    </div>
                    <h2 className="text-2xl font-bold text-success mb-3">Ready to Complete Setup!</h2>
                    <p className="text-muted-foreground text-lg">
                      All steps completed - ready to create your accounts and grant access
                    </p>
                  </div>

                  <Button
                    onClick={handleComplete}
                    disabled={completing}
                    className="w-full h-14 text-lg"
                  >
                    {completing ? (
                      <>
                        <span className="loading loading-spinner loading-sm mr-2" />
                        Finalizing...
                      </>
                    ) : (
                      <>
                        <i className="fa-solid fa-check mr-2" />
                        Create All Accounts & Complete Setup
                      </>
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center mt-4">
                    This will create your local account and all media server accounts simultaneously
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InviteWizardPage;
