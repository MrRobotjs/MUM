import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { buildDiscordAvatarUrl } from '@/lib/discord';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '../components/ui/collapsible';
import { Skeleton } from '../components/ui/skeleton';
import { useAlerts } from '../contexts/AlertContext';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faArrowRight,
  faCalendar,
  faCheck,
  faCircleCheck,
  faCircleInfo,
  faCircleXmark,
  faChevronDown,
  faDownload,
  faEnvelopeOpenText,
  faExternalLinkAlt,
  faFilm,
  faFolder,
  faHouseUser,
  faInfo,
  faKey,
  faLink,
  faRightToBracket,
  faRotateRight,
  faSave,
  faServer,
  faStar,
  faTriangleExclamation,
  faTv,
  faUser,
  faUserCheck,
  faUserClock,
  faUserPlus,
  faUsers,
} from '@fortawesome/free-solid-svg-icons';
import { faClock } from '@fortawesome/free-regular-svg-icons';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';

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

type ServerFeatures = {
  allow_downloads: boolean;
  invite_to_plex_home: boolean;
  allow_live_tv: boolean;
  allow_4k_transcode: boolean;
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
  features?: ServerFeatures;
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
    invite_to_plex_home: boolean;
    allow_live_tv: boolean;
    allow_4k_transcode: boolean;
    membership_duration_days: number | null;
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
      avatar?: string | null;
    } | null;
    guild_id?: string | null;
    invite_url?: string | null;
    guild_verified?: boolean | null;
    guild_error?: string | null;
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

type ServerAccessDetailsProps = {
  server: WizardServer;
  invite: WizardState['invite'];
  grantLibraryIds: string[] | null;
};

const ServerAccessDetails = ({ server, invite, grantLibraryIds }: ServerAccessDetailsProps) => {
  const [isOpen, setIsOpen] = useState(false);

  // Get libraries that match grant_library_ids for this server
  const matchingLibraries = useMemo(() => {
    if (!grantLibraryIds || grantLibraryIds.length === 0) {
      return null; // All libraries
    }
    return server.libraries.filter(lib => grantLibraryIds.includes(lib.id));
  }, [server.libraries, grantLibraryIds]);

  const features = server.features ?? {
    allow_downloads: invite.allow_downloads,
    invite_to_plex_home: invite.invite_to_plex_home,
    allow_live_tv: invite.allow_live_tv,
    allow_4k_transcode: invite.allow_4k_transcode,
  };

  const formatExpiry = (expiresAt: string | null) => {
    if (!expiresAt) return 'Never';
    try {
      return new Date(expiresAt).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return expiresAt;
    }
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="mt-6">
      <div className="bg-muted/30 border border-border rounded-lg overflow-hidden">
        <CollapsibleTrigger className="flex items-center justify-between w-full p-4 cursor-pointer hover:bg-muted/50 transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
              <FontAwesomeIcon icon={faInfo} className="text-blue-500 text-xs" />
            </div>
            <span className="font-medium text-foreground">{server.name} Access Details</span>
          </div>
          <FontAwesomeIcon
            icon={faChevronDown}
            className={cn('text-muted-foreground transition-transform', isOpen && 'rotate-180')}
          />
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-t border-border p-4 space-y-4">
            {/* Server Information */}
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FontAwesomeIcon icon={faServer} className="text-blue-500 text-xs" />
                </div>
                <div>
                  <h4 className="font-medium text-blue-600 dark:text-blue-400 mb-2">Server Information</h4>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Name:</span>
                      <span>{server.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">Type:</span>
                      <span>{server.service_type}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Library Access */}
            <div className="bg-primary/10 border border-primary/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FontAwesomeIcon icon={faFolder} className="text-primary text-xs" />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium text-primary mb-2">Library Access</h4>
                  {matchingLibraries === null ? (
                    <p className="text-sm text-muted-foreground">
                      All available libraries on this server
                    </p>
                  ) : matchingLibraries.length > 0 ? (
                    <>
                      <p className="text-sm text-muted-foreground mb-2">
                        You will have access to <strong>{matchingLibraries.length}</strong> selected {matchingLibraries.length === 1 ? 'library' : 'libraries'}:
                      </p>
                      <div className="space-y-1">
                        {matchingLibraries.map(lib => (
                          <div key={lib.id} className="flex items-center gap-2 text-sm">
                            <div className="w-3 h-3 rounded-full bg-primary/20 flex items-center justify-center">
                              <FontAwesomeIcon icon={faCheck} className="text-primary text-xs" />
                            </div>
                            <span className="text-muted-foreground">{lib.name}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Selected libraries (specific access will be configured)
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Features & Permissions */}
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FontAwesomeIcon icon={faStar} className="text-green-500 text-xs" />
                </div>
                <div>
                  <h4 className="font-medium text-green-600 dark:text-green-400 mb-2">Features & Permissions</h4>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    {server.service_type === 'PLEX' ? (
                      <>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faDownload} className="w-4 text-green-500" />
                          <span>Downloads/Sync: <strong>{features.allow_downloads ? 'Enabled' : 'Disabled'}</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faHouseUser} className="w-4 text-green-500" />
                          <span>Plex Home Invite: <strong>{features.invite_to_plex_home ? 'Yes' : 'No'}</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faTv} className="w-4 text-green-500" />
                          <span>Live TV Access: <strong>{features.allow_live_tv ? 'Enabled' : 'Disabled'}</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faFilm} className="w-4 text-green-500" />
                          <span>4K Transcoding: <strong>{features.allow_4k_transcode ? 'Enabled' : 'Disabled'}</strong></span>
                        </div>
                      </>
                    ) : server.service_type === 'JELLYFIN' ? (
                      <>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faUser} className="w-4 text-green-500" />
                          <span>Account Type: <strong>New user account will be created</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faKey} className="w-4 text-green-500" />
                          <span>Authentication: <strong>Username and password (required)</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faDownload} className="w-4 text-green-500" />
                          <span>Downloads: <strong>Available through Jellyfin apps</strong></span>
                        </div>
                      </>
                    ) : server.service_type === 'EMBY' ? (
                      <>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faUser} className="w-4 text-green-500" />
                          <span>Account Type: <strong>New user account will be created</strong></span>
                        </div>
                        <div className="flex items-center gap-2">
                          <FontAwesomeIcon icon={faKey} className="w-4 text-green-500" />
                          <span>Authentication: <strong>Username and password</strong></span>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faUser} className="w-4 text-green-500" />
                        <span>Account Type: <strong>New user account will be created</strong></span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Invite Information */}
            <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-purple-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <FontAwesomeIcon icon={faCalendar} className="text-purple-500 text-xs" />
                </div>
                <div>
                  <h4 className="font-medium text-purple-600 dark:text-purple-400 mb-2">Invite Details</h4>
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faClock} className="w-4 text-muted-foreground" />
                      <span>Expires: <strong>{formatExpiry(invite.expires_at)}</strong></span>
                    </div>
                    <div className="flex items-center gap-2">
                      <FontAwesomeIcon icon={faUsers} className="w-4 text-muted-foreground" />
                      <span>Uses Left: <strong>{invite.max_uses !== null ? (invite.max_uses - invite.current_uses) : 'Unlimited'}</strong></span>
                    </div>
                    {invite.membership_duration_days ? (
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faUserClock} className="w-4 text-muted-foreground" />
                        <span>Membership Duration: <strong>{invite.membership_duration_days} day{invite.membership_duration_days !== 1 ? 's' : ''} after acceptance</strong></span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faUserCheck} className="w-4 text-muted-foreground" />
                        <span>Membership: <strong>Permanent</strong></span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Info Footer */}
            <div className="bg-muted/50 border border-border/50 rounded-lg p-3">
              <div className="flex items-start gap-2">
                <FontAwesomeIcon icon={faCircleInfo} className="text-muted-foreground text-xs mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  This information shows what access you'll receive after completing the setup.
                </p>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export const InviteWizardPage = () => {
  // TanStack Router requires an options object; passing the route ID ensures the hook has context.
  const { token = '' } = useParams({ from: '/invite/$token' as const });
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
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const discordAvatarUrl = state?.discord.user
    ? buildDiscordAvatarUrl({
        userId: state.discord.user.id,
        avatarHash: state.discord.user.avatar,
      })
    : null;

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

  const activeStepId = useMemo(() => {
    if (!state?.steps?.length) return null;

    const accountStepVisible = state.account.allowed && !state.account.completed;
    if (accountStepVisible) return 'user_account';

    const discordStepVisible = state.discord.oauth_enabled
      && !state.discord.authenticated
      && (!state.account.allowed || state.account.completed);
    if (discordStepVisible) return 'discord';

    const plexStepVisible = state.plex.has_plex_servers
      && !state.plex.authenticated
      && (state.discord.authenticated || !state.discord.oauth_enabled)
      && (!state.account.allowed || state.account.completed);
    if (plexStepVisible) return 'plex';

    if (state.next_step_id) return state.next_step_id;

    const firstIncomplete = state.steps.find((step) => !step.completed);
    return firstIncomplete?.id ?? null;
  }, [state]);

  const currentStepId = selectedStepId ?? activeStepId;

  const activeStepIndex = useMemo(() => {
    if (!state?.steps) return -1;
    if (currentStepId) {
      const idx = state.steps.findIndex((step) => step.id === currentStepId);
      if (idx >= 0) return idx;
    }
    return -1;
  }, [state, currentStepId]);

  const activeServerId = useMemo(() => {
    if (!currentStepId?.startsWith('server_access_')) return null;
    const idPart = currentStepId.replace('server_access_', '');
    const parsedId = Number.parseInt(idPart, 10);
    return Number.isNaN(parsedId) ? null : parsedId;
  }, [currentStepId]);

  const navigableStepIds = useMemo(() => {
    if (!state?.steps) return [];
    return state.steps
      .filter((step) => step.completed || step.id === activeStepId)
      .map((step) => step.id);
  }, [state, activeStepId]);

  const navigableIndex = useMemo(() => {
    if (!currentStepId) return -1;
    return navigableStepIds.indexOf(currentStepId);
  }, [currentStepId, navigableStepIds]);

  const previousStepId = navigableIndex > 0 ? navigableStepIds[navigableIndex - 1] : null;
  const nextStepId = navigableIndex >= 0 && navigableIndex < navigableStepIds.length - 1
    ? navigableStepIds[navigableIndex + 1]
    : null;

  const selectStep = useCallback((stepId: string | null) => {
    if (!stepId) return;
    if (stepId === activeStepId) {
      setSelectedStepId(null);
      return;
    }
    setSelectedStepId(stepId);
  }, [activeStepId]);

  useEffect(() => {
    if (!selectedStepId || !state?.steps) return;
    const selectedStep = state.steps.find((step) => step.id === selectedStepId);
    if (!selectedStep?.completed) {
      setSelectedStepId(null);
    }
  }, [selectedStepId, state]);

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
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-4xl">
          <div className="bg-card border rounded-xl shadow-lg overflow-hidden">
            <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 text-center border-b border">
              <div className="flex flex-col items-center gap-3">
                <Skeleton className="h-16 w-16 rounded-full" />
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>

            <div className="p-6 sm:p-8 space-y-8">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <div className="flex items-center gap-2">
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <div key={idx} className="flex items-center flex-1">
                      <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/50 flex-1">
                        <Skeleton className="w-6 h-6 rounded-full" />
                        <div className="flex-1 space-y-2">
                          <Skeleton className="h-3 w-24" />
                          <Skeleton className="h-2 w-16" />
                        </div>
                      </div>
                      {idx < 3 ? <div className="w-3 h-0.5 mx-1 bg-muted" /> : null}
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Skeleton className="h-36 w-full rounded-lg" />
                <Skeleton className="h-36 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
                <Skeleton className="h-16 w-full rounded-lg" />
              </div>

              <div className="space-y-3">
                <Skeleton className="h-12 w-full rounded-lg" />
                <Skeleton className="h-12 w-full rounded-lg" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="bg-card border border-destructive/30 rounded-xl shadow-lg overflow-hidden max-w-md w-full">
          <div className="bg-red-50 dark:bg-red-400/10 border-b border-red-200 dark:border-red-500/20 p-6 text-center">
            <div className="w-16 h-16 rounded-full bg-red-100/20 flex items-center justify-center mx-auto mb-4">
              <FontAwesomeIcon icon={faCircleXmark} className="text-red-600 dark:text-red-400 text-2xl" />
            </div>
            <h1 className="text-2xl font-bold text-red-600 dark:text-red-400 mb-2">Invite Problem</h1>
            <p className="text-muted-foreground text-sm">There was an issue with your invite</p>
          </div>
          <div className="p-6 text-center">
            <p className="text-foreground mb-6">{error ?? 'Unable to load this invite link.'}</p>
            <Button onClick={() => loadState()} variant="outline">
              <FontAwesomeIcon icon={faRotateRight} className="mr-2" />
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
          <div className="bg-gradient-to-br from-success/10 to-primary/10 border border-green-200 dark:border-green-500/20 rounded-xl p-8 shadow-lg">
            <div className="text-center mb-8">
              <div className="w-20 h-20 rounded-full bg-green-100/20 flex items-center justify-center mx-auto mb-6">
              <FontAwesomeIcon icon={faCircleCheck} className="text-green-600 dark:text-green-400 text-3xl" />
              </div>
              <h2 className="text-3xl font-bold text-green-600 dark:text-green-400 mb-3">Welcome, {completion.username}!</h2>
              <p className="text-muted-foreground text-lg">Your invitation has been completed successfully</p>
            </div>

            {state.plex.authenticated || state.discord.authenticated ? (
              <div className="space-y-3 mb-8">
                {state.plex.authenticated && state.plex.user && (
                  <div className="bg-[#e5a00d]/10 border border-[#e5a00d]/20 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-full bg-[#e5a00d]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                        <FontAwesomeIcon icon={faRightToBracket} className="text-[#e5a00d] text-xs" />
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
                      <Avatar className="size-6 mt-0.5">
                        {discordAvatarUrl ? (
                          <AvatarImage
                            src={discordAvatarUrl}
                            alt={`${state.discord.user.username ?? 'Discord'} avatar`}
                          />
                        ) : (
                          <AvatarFallback className="bg-[#5865F2]/20">
                            <FontAwesomeIcon icon={faDiscord} className="text-[#5865F2] text-xs" />
                          </AvatarFallback>
                        )}
                      </Avatar>
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

            <div className="bg-muted/50 border rounded-lg p-6 mb-8">
              <div className="flex items-center justify-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-green-100/20 flex items-center justify-center">
                  <FontAwesomeIcon icon={faServer} className="text-green-600 dark:text-green-400 text-sm" />
                </div>
                <h3 className="font-medium text-foreground text-lg">Media Server Access</h3>
              </div>
              <div className="space-y-2">
                {completion.servers.map((server) => (
                  <div key={server.name} className="flex items-center justify-between gap-2 text-sm bg-card rounded-lg p-3">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 rounded-full bg-green-100/20 flex items-center justify-center">
                        <FontAwesomeIcon icon={faCheck} className="text-green-600 dark:text-green-400 text-xs" />
                      </div>
                      <span className="font-medium">{server.name}</span>
                      <span className="text-xs text-muted-foreground">({server.service_type})</span>
                    </div>
                    {server.access_url && (
                      <Button asChild variant="ghost" size="sm">
                        <a href={server.access_url} target="_blank" rel="noreferrer" className="gap-1">
                          Open
                          <FontAwesomeIcon icon={faExternalLinkAlt} className="text-xs" />
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
        <div className="bg-card border rounded-xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-6 text-center border-b border">
            <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-4">
              <FontAwesomeIcon icon={faEnvelopeOpenText} className="text-primary text-2xl" />
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
                    const canSelectStep = step.completed || step.id === activeStepId;
                    return (
                      <div key={step.id} className="flex items-center flex-1">
                        <button
                          type="button"
                          onClick={() => {
                            if (canSelectStep) {
                              selectStep(step.id);
                            }
                          }}
                          disabled={!canSelectStep}
                          className={cn(
                            'flex items-center gap-2 p-3 rounded-lg transition-colors flex-1',
                            'disabled:cursor-not-allowed disabled:opacity-60',
                            step.completed
                              ? 'bg-primary/10 border border-primary/20'
                              : isActive
                              ? 'bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-500/20'
                              : 'bg-muted/50 border'
                          )}
                        >
                          <div
                            className={cn(
                              'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
                              step.completed
                                ? 'bg-primary text-primary-content'
                                : isActive
                                ? 'bg-amber-100 text-amber-600 dark:text-amber-400-content'
                                : 'bg-muted text-muted-foreground'
                            )}
                          >
                            {step.completed ? (
                              <FontAwesomeIcon icon={faCheck} className="text-xs" />
                            ) : (
                              <i className={`${step.icon} text-xs`} />
                            )}
                          </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={cn(
                                    'text-xs font-medium truncate',
                                    step.completed
                                      ? 'text-primary'
                                      : isActive
                                      ? 'text-amber-600 dark:text-amber-400'
                                      : 'text-muted-foreground'
                                  )}
                                >
                                  {step.name}
                                </span>
                                {!step.required && (
                                  <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    Optional
                                  </span>
                                )}
                              </div>
                            </div>
                        </button>
                        {index < state.steps.length - 1 && (
                          <div
                            className={cn(
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
              {state.account.allowed && currentStepId === 'user_account' && (
                <div className="bg-muted/50 border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <FontAwesomeIcon icon={faUserPlus} className="text-primary text-lg" />
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
                          className={accountErrors.username ? 'border-red-500' : ''}
                        />
                        {accountErrors.username && (
                          <p className="text-xs text-red-600 dark:text-red-400">{accountErrors.username.join(', ')}</p>
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
                          className={accountErrors.email ? 'border-red-500' : ''}
                        />
                        {accountErrors.email && (
                          <p className="text-xs text-red-600 dark:text-red-400">{accountErrors.email.join(', ')}</p>
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
                          className={accountErrors.password ? 'border-red-500' : ''}
                        />
                        {accountErrors.password && (
                          <p className="text-xs text-red-600 dark:text-red-400">{accountErrors.password.join(', ')}</p>
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
                          className={accountErrors.confirm_password ? 'border-red-500' : ''}
                        />
                        {accountErrors.confirm_password && (
                          <p className="text-xs text-red-600 dark:text-red-400">{accountErrors.confirm_password.join(', ')}</p>
                        )}
                      </div>
                    </div>

                    <div className="bg-blue-50 dark:bg-blue-400/10 border border-blue-200 dark:border-blue-500/20 rounded-lg p-4 mt-6">
                      <div className="flex items-start gap-3 mb-4">
                        <div className="w-6 h-6 rounded-full bg-blue-100/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <FontAwesomeIcon icon={faLink} className="text-blue-600 dark:text-blue-400 text-xs" />
                        </div>
                        <div>
                          <h4 className="font-medium text-blue-600 dark:text-blue-400 mb-1">Cross-Server Convenience</h4>
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
                            <FontAwesomeIcon icon={faSave} className="mr-2" />
                            Save Account Details & Continue
                          </>
                        )}
                      </Button>
                    </div>
                  </form>
                </div>
              )}

              {state.discord.authenticated && state.discord.user && (
                <div className="mb-8 rounded-lg border border-[#5865F2]/20 bg-[#5865F2]/10 p-4">
                  <div className="flex items-start gap-3">
                    <Avatar className="mt-0.5">
                      {discordAvatarUrl ? (
                        <AvatarImage
                          src={discordAvatarUrl}
                          alt={`${state.discord.user.username ?? 'Discord'} avatar`}
                        />
                      ) : (
                        <AvatarFallback className="bg-[#5865F2]/20">
                          <FontAwesomeIcon icon={faDiscord} className="text-[#5865F2] text-sm" />
                        </AvatarFallback>
                      )}
                    </Avatar>
                    <div>
                      <h3 className="font-medium text-[#5865F2] mb-1">Discord Account Linked</h3>
                      <p className="text-sm text-foreground/80">
                        Linked as <strong>{state.discord.user.username}</strong>
                      </p>
                      {state.discord.user.email && (
                        <p className="text-xs text-muted-foreground">Email: {state.discord.user.email}</p>
                      )}
                      {state.discord.user.id && (
                        <p className="text-xs text-muted-foreground">Discord ID: {state.discord.user.id}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Discord Step */}
              {state.discord.oauth_enabled && currentStepId === 'discord' && !state.discord.authenticated && (
                <div className="bg-muted/50 border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0">
                      <FontAwesomeIcon icon={faDiscord} className="text-[#5865F2] text-lg" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">Discord Authentication</h2>
                      <div className='flex items-center gap-2 min-w-0'>
                        <p className="text-sm text-muted-foreground">
                          {state.discord.requires_auth ? 'Required to continue with your invite' : 'Connect your Discord account'}
                        </p>
                        {!state.discord.requires_auth && (
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-muted/50 text-muted-foreground mt-1">
                            Optional
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {state.discord.guild_error && (
                    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="w-6 h-6 rounded-full bg-destructive/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <FontAwesomeIcon icon={faTriangleExclamation} className="text-destructive text-xs" />
                        </div>
                        <div>
                          <h4 className="font-medium text-destructive mb-1">Discord Server Membership Required</h4>
                          <p className="text-sm text-foreground/80">{state.discord.guild_error}</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {state.discord.requires_guild && (
                    <div className="bg-[#5865F2]/10 border border-[#5865F2]/20 rounded-lg p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <div className="w-6 h-6 rounded-full bg-[#5865F2]/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <FontAwesomeIcon icon={faInfo} className="text-[#5865F2] text-xs" />
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
                                <FontAwesomeIcon icon={faDiscord} />
                                Join Discord Server First
                                <FontAwesomeIcon icon={faExternalLinkAlt} className="text-xs" />
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
                        <FontAwesomeIcon icon={faDiscord} className="mr-2" />
                        Continue with Discord
                      </>
                    )}
                  </Button>
                </div>
              )}

              {/* Plex Step */}
              {state.plex.has_plex_servers && currentStepId === 'plex' && (
                <div className="bg-muted/50 border rounded-lg p-6">
                  {state.plex.authenticated ? (
                    <div className="flex items-center gap-3 mb-6">
                      <div className="w-10 h-10 rounded-full bg-[#e5a00d]/20 flex items-center justify-center flex-shrink-0">
                        <svg className="w-5 h-5 text-[#e5a00d]" viewBox="0 0 192 192" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                          <path d="M22 25.5h48L116 94l-46 68.5H22L68.5 94Zm109.8 56L108 46l14-20.5h48zm-.3 23.5c10.979 17.625 25.52 38.875 38.5 49.5-11.149 13.635-34.323 32.278-62.5-14z" />
                        </svg>
                      </div>
                      <div>
                        <h2 className="text-xl font-semibold text-foreground mb-1">Plex Connected</h2>
                        <p className="text-sm text-muted-foreground">
                          {state.plex.user?.username ? (
                            <>
                              Authenticated as <strong>{state.plex.user.username}</strong>
                            </>
                          ) : (
                            'Your Plex account is linked.'
                          )}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <>
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
                        <div className="bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-500/20 rounded-lg p-4 mb-6">
                          {state.plex.conflict.type === 'can_link' ? (
                            <div className="space-y-3">
                              <div className="flex items-start gap-3">
                                <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-600 dark:text-amber-400 mt-0.5" />
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
                    </>
                  )}

                  {/* Plex Server Access Details */}
                  {(() => {
                    const plexServer = state.servers.find(s => s.service_type === 'PLEX');
                    if (!plexServer) return null;
                    return (
                      <ServerAccessDetails
                        server={plexServer}
                        invite={state.invite}
                        grantLibraryIds={state.invite.grant_library_ids}
                      />
                    );
                  })()}
                </div>
              )}

              {/* Server Credentials */}
              {(() => {
                // Find the selected server credentials step (non-Plex)
                const activeServer = state.servers.find(
                  (s) => s.id === activeServerId && s.service_type !== 'PLEX'
                );

                if (!activeServer) return null;

                return (
                <div key={activeServer.id} className="bg-muted/50 border rounded-lg p-6">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                      <FontAwesomeIcon icon={faServer} className="text-primary text-lg" />
                    </div>
                    <div>
                      <h2 className="text-xl font-semibold text-foreground mb-1">
                        {activeServer.name}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        Setting up access to {activeServer.name || activeServer.service_type}
                      </p>
                    </div>
                  </div>

                  {activeServer.username_conflict && (
                    <div className="bg-amber-50 dark:bg-amber-400/10 border border-amber-200 dark:border-amber-500/20 rounded-lg p-3 mb-4">
                      <div className="flex items-start gap-2">
                        <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-600 dark:text-amber-400 text-sm mt-0.5" />
                        <div className="text-sm">
                          <p className="font-medium text-amber-600 dark:text-amber-400 mb-1">Username Not Available</p>
                          <p className="text-foreground/80">
                            The username is already taken on {activeServer.name}. Please choose a different username.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor={`server-${activeServer.id}-username`}>Username</Label>
                      <Input
                        id={`server-${activeServer.id}-username`}
                        value={serverForms[activeServer.id]?.username ?? ''}
                        onChange={(e) => updateServerForm(activeServer.id, 'username', e.target.value)}
                        required
                      />
                    </div>

                    {activeServer.service_type === 'KAVITA' && (
                      <div className="space-y-2">
                        <Label htmlFor={`server-${activeServer.id}-email`}>Email</Label>
                        <Input
                          id={`server-${activeServer.id}-email`}
                          type="email"
                          value={serverForms[activeServer.id]?.email ?? ''}
                          onChange={(e) => updateServerForm(activeServer.id, 'email', e.target.value)}
                          required
                        />
                      </div>
                    )}

                    <div className="space-y-2">
                      <Label htmlFor={`server-${activeServer.id}-password`}>Password</Label>
                      <Input
                        id={`server-${activeServer.id}-password`}
                        type="password"
                        value={serverForms[activeServer.id]?.password ?? ''}
                        onChange={(e) => updateServerForm(activeServer.id, 'password', e.target.value)}
                        required
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor={`server-${activeServer.id}-password-confirm`}>Confirm Password</Label>
                      <Input
                        id={`server-${activeServer.id}-password-confirm`}
                        type="password"
                        value={serverForms[activeServer.id]?.password_confirm ?? ''}
                        onChange={(e) => updateServerForm(activeServer.id, 'password_confirm', e.target.value)}
                        required
                      />
                    </div>

                    <Button
                      onClick={() => handleSaveServer(activeServer.id)}
                      disabled={savingServerId === activeServer.id}
                      className="w-full h-12"
                    >
                      {savingServerId === activeServer.id ? (
                        <>
                          <span className="loading loading-spinner loading-xs mr-2" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <FontAwesomeIcon icon={faUserPlus} className="mr-2" />
                          {activeServer.completed ? 'Update Account Details' : `Create Account on ${activeServer.name}`}
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Server Access Details */}
                  <ServerAccessDetails
                    server={activeServer}
                    invite={state.invite}
                    grantLibraryIds={state.invite.grant_library_ids}
                  />
                </div>
                );
              })()}

              {state.steps.length > 0 && (
                <div className="flex items-center justify-between gap-3 pt-2">
                  {previousStepId ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => selectStep(previousStepId)}
                    >
                      <FontAwesomeIcon icon={faArrowLeft} className="mr-2" />
                      Previous
                    </Button>
                  ) : (
                    <span />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => selectStep(nextStepId)}
                    disabled={!nextStepId}
                  >
                    Next
                    <FontAwesomeIcon icon={faArrowRight} className="ml-2" />
                  </Button>
                </div>
              )}

              {/* Complete Button */}
              {allStepsComplete && (
                <div className="bg-gradient-to-br from-success/10 to-primary/10 border border-green-200 dark:border-green-500/20 rounded-lg p-8">
                  <div className="text-center mb-8">
                    <div className="w-20 h-20 rounded-full bg-green-100/20 flex items-center justify-center mx-auto mb-6">
                      <FontAwesomeIcon icon={faCircleCheck} className="text-green-600 dark:text-green-400 text-3xl" />
                    </div>
                    <h2 className="text-2xl font-bold text-green-600 dark:text-green-400 mb-3">Ready to Complete Setup!</h2>
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
                        <FontAwesomeIcon icon={faCheck} className="mr-2" />
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
