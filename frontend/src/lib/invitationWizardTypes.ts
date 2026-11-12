export type WizardStep = {
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

export type PlexUser = {
  username?: string;
  email?: string;
  uuid?: string;
  thumb?: string;
};

export type PlexConflict = {
  type?: 'can_link' | 'already_linked' | 'already_exists_no_linking' | string;
  plex_username?: string;
  plex_email?: string;
  message?: string;
};

export type WizardServerCredentials = {
  username?: string;
  email?: string;
  password?: string;
};

export type ServerFeatures = {
  allow_downloads: boolean;
  invite_to_plex_home: boolean;
  allow_live_tv: boolean;
  allow_4k_transcode: boolean;
};

export type WizardServer = {
	all_libraries?: boolean;
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

export type DisabledServer = {
  id: number;
  name: string;
  service_type: string;
  is_active: boolean;
  plugin_enabled: boolean;
  effective_active: boolean;
  reason?: string | null;
};

export type WizardAccount = {
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

export type WizardState = {
  invite: {
    id: number;
    token: string;
    custom_path: string | null;
    expires_at: string | null;
    max_uses: number | null;
    current_uses: number;
    is_active: boolean;
    is_paused: boolean;
    allow_downloads: boolean;
    invite_to_plex_home: boolean;
    allow_live_tv: boolean;
    allow_4k_transcode: boolean;
    membership_duration_days: number | null;
    grant_library_ids: string[] | null;
    require_discord_auth: boolean;
    require_discord_guild_membership: boolean;
    server_count: number;
    effective_server_count: number;
    disabled_server_count: number;
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
  disabled_servers?: DisabledServer[];
  meta: {
    server_label: string;
    has_multiple_servers: boolean;
  };
};

export type WizardResponse = {
  data: WizardState;
};

export type CompletionResponse = {
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

