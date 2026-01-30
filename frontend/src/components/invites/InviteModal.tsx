import { useEffect, useState } from 'react';
import { requestJson } from '../../util/apiClient';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { ServiceIcon } from '@/components';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCalendar,
  faCalendarDays,
  faCheck,
  faChevronDown,
  faCircleExclamation,
  faClock,
  faCog,
  faDownload,
  faFilm,
  faHashtag,
  faHome,
  faLink,
  faPhotoFilm,
  faPlus,
  faRobot,
  faRotate,
  faServer,
  faShieldHalved,
  faTicketSimple,
  faTv,
  faUsers
} from '@fortawesome/free-solid-svg-icons';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';

export type InviteFormValues = {
  custom_path?: string;
  expires_at?: string | null;
  max_uses?: number | null;
  membership_expires_at?: string | null;
  allow_downloads?: boolean;
  is_active?: boolean;
  server_ids?: number[];
  grant_library_ids?: string[];
  invite_to_plex_home?: boolean;
  allow_live_tv?: boolean;
  allow_4k_transcode?: boolean;
  require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean;
  grant_purge_whitelist?: boolean;
  grant_bot_whitelist?: boolean;
   server_features?: {
    server_id: number;
    allow_downloads?: boolean | null;
    invite_to_plex_home?: boolean | null;
    allow_live_tv?: boolean | null;
    allow_4k_transcode?: boolean | null;
  }[];
};

type Library = {
  id: string;
  name: string;
  external_id?: string;
  internal_id?: string;
};

type Server = {
  id: number;
  server_nickname: string;
  service_type: string;
  is_active: boolean;
  libraries?: Library[];
  loadingLibraries?: boolean;
};

type ServerFeatureState = {
  allow_downloads?: boolean;
  invite_to_plex_home?: boolean;
  allow_live_tv?: boolean;
  allow_4k_transcode?: boolean;
};

type InviteModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InviteFormValues) => Promise<void> | void;
  initialValues?: InviteFormValues;
  isEditing?: boolean;
  loading?: boolean;
};

const defaultValues: InviteFormValues = {
  custom_path: '',
  expires_at: null,
  max_uses: null,
  membership_expires_at: null,
  allow_downloads: false,
  is_active: true,
  server_ids: [],
  grant_library_ids: [],
  invite_to_plex_home: false,
  allow_live_tv: false,
  allow_4k_transcode: true,
  require_discord_auth: false,
  require_discord_guild_membership: false,
  grant_purge_whitelist: false,
  grant_bot_whitelist: false,
  server_features: []
};

export const InviteModal = ({ open, onClose, onSubmit, initialValues, isEditing, loading }: InviteModalProps) => {
  const [form, setForm] = useState<InviteFormValues>(defaultValues);
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerIds, setSelectedServerIds] = useState<Set<number>>(new Set());
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set());
  const [serverFeatures, setServerFeatures] = useState<Record<number, ServerFeatureState>>({});
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [librarySearch, setLibrarySearch] = useState<Record<number, string>>({});

  const selectedServerCount = selectedServerIds.size;
  const selectedLibraryCount = selectedLibraries.size;
  const expiresLabel = form.expires_at ? new Date(form.expires_at).toLocaleDateString() : 'Never';
  const maxUsesLabel = form.max_uses || form.max_uses === 0 ? form.max_uses : 'Unlimited';

  useEffect(() => {
    if (open) {
      loadServers();
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      const nextForm = { ...defaultValues, ...initialValues };
      if (nextForm.require_discord_guild_membership) {
        nextForm.require_discord_auth = true;
      }
      setForm(nextForm);
      setSelectedServerIds(new Set(initialValues?.server_ids || []));
      setSelectedLibraries(new Set(initialValues?.grant_library_ids || []));
      const featureMap: Record<number, ServerFeatureState> = {};
      (initialValues?.server_features || []).forEach((sf) => {
        featureMap[sf.server_id] = {
          allow_downloads: sf.allow_downloads ?? initialValues?.allow_downloads ?? false,
          invite_to_plex_home: sf.invite_to_plex_home ?? initialValues?.invite_to_plex_home ?? false,
          allow_live_tv: sf.allow_live_tv ?? initialValues?.allow_live_tv ?? false,
          allow_4k_transcode: sf.allow_4k_transcode ?? initialValues?.allow_4k_transcode ?? true,
        };
      });
      setServerFeatures(featureMap);
    } else {
      setForm(defaultValues);
      setSelectedServerIds(new Set());
      setSelectedLibraries(new Set());
      setAdvancedOpen(false);
      setServerFeatures({});
      setLibrarySearch({});
    }
  }, [initialValues, open]);

  useEffect(() => {
    if (!open || loadingServers || selectedServerIds.size === 0) return;
    selectedServerIds.forEach((serverId) => {
      const server = servers.find((s) => s.id === serverId);
      if (server && !server.libraries && !server.loadingLibraries) {
        void loadLibrariesForServer(serverId, false, false);
      }
    });
  }, [open, loadingServers, selectedServerIds, servers]);

  const loadServers = async () => {
    setLoadingServers(true);
    try {
      const response = await requestJson('/admin/api/v2/servers', { method: 'GET' });
      setServers(response.data || []);
    } catch (error) {
      console.error('Failed to load servers:', error);
    } finally {
      setLoadingServers(false);
    }
  };

  const loadLibrariesForServer = async (
    serverId: number,
    forceRefresh = false,
    autoSelectLibraries = true
  ) => {
    setServers((prev) =>
      prev.map((s) => (s.id === serverId ? { ...s, loadingLibraries: true } : s))
    );

    try {
      const endpoint = forceRefresh
        ? `/admin/api/v2/servers/${serverId}/libraries/refresh`
        : `/admin/api/v2/servers/${serverId}/libraries`;
      const method = forceRefresh ? 'POST' : 'GET';

      const response = await requestJson(endpoint, { method });

      if (response.success && response.libraries) {
        setServers((prev) =>
          prev.map((s) =>
            s.id === serverId
              ? { ...s, libraries: response.libraries, loadingLibraries: false }
              : s
          )
        );

        if (autoSelectLibraries) {
          const libraryIds = response.libraries.map(
            (lib: Library) => lib.id || lib.external_id || lib.internal_id
          );
          setSelectedLibraries((prev) => {
            const next = new Set(prev);
            libraryIds.forEach((id: string) => next.add(id));
            return next;
          });
        }
      }
    } catch (error) {
      console.error('Failed to load libraries:', error);
      setServers((prev) =>
        prev.map((s) => (s.id === serverId ? { ...s, loadingLibraries: false } : s))
      );
    }
  };

  const toggleServer = (serverId: number) => {
    setServerError(null);
    const next = new Set(selectedServerIds);

    if (next.has(serverId)) {
      next.delete(serverId);
      const server = servers.find((s) => s.id === serverId);
      if (server?.libraries) {
        const libIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
        setSelectedLibraries((prev) => {
          const updated = new Set(prev);
          libIds.forEach((id) => id && updated.delete(id));
          return updated;
        });
      }
      setServerFeatures((prev) => {
        const updated = { ...prev };
        delete updated[serverId];
        return updated;
      });
    } else {
      next.add(serverId);
      const server = servers.find((s) => s.id === serverId);
      if (server && !server.libraries) {
        void loadLibrariesForServer(serverId);
      } else if (server?.libraries) {
        const libIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
        setSelectedLibraries((prev) => {
          const updated = new Set(prev);
          libIds.forEach((id) => id && updated.add(id));
          return updated;
        });
      }
      setServerFeatures((prev) => {
        if (prev[serverId]) return prev;
        return {
          ...prev,
          [serverId]: {
            allow_downloads: form.allow_downloads ?? false,
            invite_to_plex_home: form.invite_to_plex_home ?? false,
            allow_live_tv: form.allow_live_tv ?? false,
            allow_4k_transcode: form.allow_4k_transcode ?? true
          }
        };
      });
    }

    setSelectedServerIds(next);
  };

  const toggleLibrary = (libraryId: string) => {
    setSelectedLibraries((prev) => {
      const next = new Set(prev);
      if (next.has(libraryId)) {
        next.delete(libraryId);
      } else {
        next.add(libraryId);
      }
      return next;
    });
  };

  const selectAllLibraries = (serverId: number) => {
    const server = servers.find((s) => s.id === serverId);
    if (server?.libraries) {
      const libIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
      setSelectedLibraries((prev) => {
        const next = new Set(prev);
        libIds.forEach((id) => id && next.add(id));
        return next;
      });
    }
  };

  const deselectAllLibraries = (serverId: number) => {
    const server = servers.find((s) => s.id === serverId);
    if (server?.libraries) {
      const libIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
      setSelectedLibraries((prev) => {
        const next = new Set(prev);
        libIds.forEach((id) => id && next.delete(id));
        return next;
      });
    }
  };

  const handleChange = (field: keyof InviteFormValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleDiscordRequirementToggle = (
    field: 'require_discord_auth' | 'require_discord_guild_membership',
    value: boolean
  ) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'require_discord_guild_membership' && value) {
        next.require_discord_auth = true;
      }
      if (field === 'require_discord_auth' && !value) {
        next.require_discord_guild_membership = false;
      }
      return next;
    });
  };

  const handleLibrarySearchChange = (serverId: number, value: string) => {
    setLibrarySearch((prev) => ({ ...prev, [serverId]: value }));
  };

  const getServerFeature = (serverId: number): ServerFeatureState => ({
    allow_downloads: form.allow_downloads ?? false,
    invite_to_plex_home: form.invite_to_plex_home ?? false,
    allow_live_tv: form.allow_live_tv ?? false,
    allow_4k_transcode: form.allow_4k_transcode ?? true,
    ...(serverFeatures[serverId] || {})
  });

  const updateServerFeature = (serverId: number, next: Partial<ServerFeatureState>) => {
    setServerFeatures((prev) => ({
      ...prev,
      [serverId]: { ...getServerFeature(serverId), ...next }
    }));
  };

  const handleSubmit = async () => {
    if (selectedServerIds.size === 0) {
      setServerError('Please select at least one server to grant access to.');
      return;
    }

    const expires_at = form.expires_at && form.expires_at.trim() !== '' ? form.expires_at : null;

    const serverFeaturePayload = Array.from(selectedServerIds).map((serverId) => {
      const features = getServerFeature(serverId);
      return {
        server_id: serverId,
        allow_downloads: features.allow_downloads ?? false,
        invite_to_plex_home: features.invite_to_plex_home ?? false,
        allow_live_tv: features.allow_live_tv ?? false,
        allow_4k_transcode: features.allow_4k_transcode ?? true
      };
    });

    const allowDownloadsAny = serverFeaturePayload.some((f) => f.allow_downloads);
    const invitePlexAny = serverFeaturePayload.some((f) => f.invite_to_plex_home);
    const allowLiveTvAny = serverFeaturePayload.some((f) => f.allow_live_tv);
    const allow4kAny = serverFeaturePayload.some((f) => f.allow_4k_transcode ?? true);
    const requireDiscordGuild = form.require_discord_guild_membership ?? false;
    const requireDiscordAuth = (form.require_discord_auth ?? false) || requireDiscordGuild;

    const submitData = {
      custom_path: form.custom_path?.trim() || undefined,
      expires_at,
      max_uses: form.max_uses ?? null,
      allow_downloads: allowDownloadsAny,
      is_active: form.is_active ?? true,
      invite_to_plex_home: invitePlexAny,
      allow_live_tv: allowLiveTvAny,
      allow_4k_transcode: allow4kAny,
      require_discord_auth: requireDiscordAuth,
      require_discord_guild_membership: requireDiscordGuild,
      membership_duration_days:
        form.membership_expires_at && form.membership_expires_at.trim() !== ''
          ? Math.max(
              1,
              Math.ceil(
                (new Date(form.membership_expires_at).getTime() - Date.now()) /
                  (1000 * 60 * 60 * 24)
              )
            )
          : null,
      grant_purge_whitelist: form.grant_purge_whitelist ?? false,
      grant_bot_whitelist: false, // WIP / disabled
      server_ids: Array.from(selectedServerIds),
      grant_library_ids: Array.from(selectedLibraries),
      server_features: serverFeaturePayload
    };

    await onSubmit(submitData);
  };

  const groupedServers = servers.reduce((acc, server) => {
    const type = server.service_type || 'Unknown';
    if (!acc[type]) acc[type] = [];
    acc[type].push(server);
    return acc;
  }, {} as Record<string, Server[]>);

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      onClose();
    }
  };

  const editingMode = isEditing ?? Boolean(initialValues);
  const footerButtons = [
    <Button key="cancel" variant="outline" onClick={onClose} disabled={loading}>
      Cancel
    </Button>,
    <Button key="submit" onClick={handleSubmit} disabled={loading}>
      {loading ? (
        <>
          <span className="loading loading-spinner loading-xs mr-2" />
          Saving...
        </>
      ) : (
        <>
          <FontAwesomeIcon icon={faTicketSimple} className="mr-2" />
          {editingMode ? 'Update Invite' : 'Create Invite'}
        </>
      )}
    </Button>,
  ];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={editingMode ? 'Edit Invite' : 'Create Invite'}
      description="Configure invite settings, select servers, and set permissions."
      footer={footerButtons}
      contentClassName="max-w-4xl"
      bodyClassName="space-y-6"
    >
      <div className="rounded-lg border bg-muted/40 p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faServer} className="text-primary" />
          <div>
            <p className="text-xs text-muted-foreground">Servers</p>
            <p className="font-semibold">{selectedServerCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faPhotoFilm} className="text-blue-400" />
          <div>
            <p className="text-xs text-muted-foreground">Libraries</p>
            <p className="font-semibold">{selectedLibraryCount}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faCalendarDays} className="text-yellow-400" />
          <div>
            <p className="text-xs text-muted-foreground">Expires</p>
            <p className="font-semibold">{expiresLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faHashtag} className="text-emerald-500" />
          <div>
            <p className="text-xs text-muted-foreground">Max Uses</p>
            <p className="font-semibold">{maxUsesLabel}</p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <div className="space-y-4">
          {/* Basics */}
          <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-lg">Basics</h4>
              <span className="text-xs text-muted-foreground">URL + expiry</span>
            </div>
            <div className="space-y-3">
              <label className="space-y-1 block">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FontAwesomeIcon icon={faLink} className="text-primary" />
                  Custom Path
                  <span className="ml-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-yellow-400">
                    Optional
                  </span>
                </div>
                <Input
                  type="text"
                  value={form.custom_path ?? ''}
                  onChange={handleChange('custom_path')}
                  placeholder="e.g., besties or vip_access"
                />
                <span className="text-xs text-muted-foreground">
                  Leave blank to auto-generate a secure tokenized link.
                </span>
              </label>

              <label className="space-y-1 block">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FontAwesomeIcon icon={faCalendar} className="text-yellow-400" />
                  Invite Expiration
                </div>
                <Input
                  type="date"
                  value={form.expires_at ?? ''}
                  onChange={handleChange('expires_at')}
                />
                <span className="text-xs text-muted-foreground">Empty = never expires.</span>
              </label>
            </div>
          </div>

          {/* Server selection */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h4 className="font-medium text-lg">Server & Access</h4>
                {serverError ? (
                  <span className="text-destructive text-xs flex items-center gap-1">
                    <FontAwesomeIcon icon={faCircleExclamation} /> {serverError}
                  </span>
                ) : null}
              </div>
              <span className="text-xs text-muted-foreground">
                Select servers, then fine-tune libraries.
              </span>
            </div>

            {loadingServers ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2" />
                <p className="text-sm text-muted-foreground mt-2">Loading servers...</p>
              </div>
            ) : Object.keys(groupedServers).length === 0 ? (
              <div className="text-center py-8 rounded-lg border bg-muted/30">
                <FontAwesomeIcon icon={faServer} className="text-muted-foreground text-3xl mb-2" />
                <p className="text-sm text-muted-foreground">No servers available</p>
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(groupedServers).map(([serviceType, serviceServers]) => (
                  <div key={serviceType} className="rounded-md border bg-background/60">
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-2">
                        <ServiceIcon
                          serviceType={serviceType}
                          className={serviceType.toLowerCase() === 'plex' ? 'w-5 h-5' : 'w-4 h-4'}
                        />
                        <span className="text-sm font-semibold uppercase tracking-wide">{serviceType}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {serviceServers.filter((s) => selectedServerIds.has(s.id)).length} selected
                      </span>
                    </div>
                    <div className="divide-y">
                      {serviceServers.map((server) => {
                        const isSelected = selectedServerIds.has(server.id);
                        const searchTerm = (librarySearch[server.id] || '').toLowerCase().trim();
                        const allLibraries = server.libraries || [];
                        const filteredLibraries = searchTerm
                          ? allLibraries.filter((lib) => (lib.name || '').toLowerCase().includes(searchTerm))
                          : allLibraries;
                        const selectedCountForServer = allLibraries.reduce((acc, lib) => {
                          const id = lib.id || lib.external_id || lib.internal_id;
                          return id && selectedLibraries.has(id) ? acc + 1 : acc;
                        }, 0);
                        const featureState = getServerFeature(server.id);

                        return (
                          <div key={server.id} className={isSelected ? 'bg-primary/5' : ''}>
                            <button
                              type="button"
                              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent/40 transition-colors"
                              onClick={() => toggleServer(server.id)}
                            >
                              <div className="flex items-center gap-3">
                                <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full border ${isSelected ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
                                  <ServiceIcon
                                    serviceType={server.service_type}
                                    className={server.service_type.toLowerCase() === 'plex' ? 'text-sm w-4 h-4' : 'text-sm'}
                                  />
                                </span>
                                <div>
                                  <p className="font-semibold leading-tight">{server.server_nickname}</p>
                                  <p className="text-xs text-muted-foreground capitalize">{server.service_type}</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{selectedCountForServer} libraries</span>
                                {isSelected ? (
                                  <FontAwesomeIcon icon={faCheck} className="text-primary" />
                                ) : (
                                  <FontAwesomeIcon icon={faPlus} />
                                )}
                              </div>
                            </button>

                            {isSelected ? (
                              <div className="space-y-3 border-t px-4 py-3 bg-background/80">
                                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                  <span>Library Access</span>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]">
                                    {selectedCountForServer}/{allLibraries.length || 0} selected
                                  </span>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1 text-xs">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => selectAllLibraries(server.id)}
                                    >
                                      All
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => deselectAllLibraries(server.id)}
                                    >
                                      None
                                    </Button>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => loadLibrariesForServer(server.id, true)}
                                      title="Refresh libraries from server"
                                    >
                                      <FontAwesomeIcon icon={faRotate} />
                                    </Button>
                                  </div>
                                  <Input
                                    className="h-9 w-full md:w-64"
                                    placeholder="Search libraries..."
                                    value={librarySearch[server.id] || ''}
                                    onChange={(e) => handleLibrarySearchChange(server.id, e.target.value)}
                                  />
                                </div>
                                <div className="max-h-44 overflow-y-auto rounded-md border bg-background/60 p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                  {server.loadingLibraries ? (
                                    <div className="col-span-2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                                      <div className="animate-spin h-4 w-4 border-b-2 border-primary rounded-full" />
                                      Loading libraries...
                                    </div>
                                  ) : filteredLibraries.length === 0 ? (
                                    <div className="col-span-2 text-center text-xs text-muted-foreground">
                                      {allLibraries.length === 0 ? 'No libraries found' : 'No matches'}
                                    </div>
                                  ) : (
                                    filteredLibraries.map((library) => {
                                      const libId = library.id || library.external_id || library.internal_id;
                                      return (
                                        <label key={libId} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm hover:border-primary/50 cursor-pointer">
                                          <Checkbox
                                            checked={selectedLibraries.has(libId || '')}
                                            onCheckedChange={() => toggleLibrary(libId || '')}
                                          />
                                          <span className="truncate" title={library.name}>
                                            {library.name}
                                          </span>
                                        </label>
                                      );
                                    })
                                  )}
                                </div>

                                <div className="space-y-3">
                                    <div className="rounded-md border bg-background px-3 py-2">
                                      <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2 text-sm font-medium">
                                          <FontAwesomeIcon icon={faDownload} className="text-blue-400" />
                                          Allow Downloads
                                        </div>
                                        <Switch
                                          checked={featureState.allow_downloads ?? false}
                                          onCheckedChange={(checked) => {
                                            updateServerFeature(server.id, { allow_downloads: checked });
                                            setForm((prev) => ({ ...prev, allow_downloads: checked }));
                                          }}
                                        />
                                      </div>
                                      <p className="text-[11px] text-muted-foreground mt-1">Users can download media.</p>
                                    </div>

                                    {server.service_type?.toLowerCase() === 'plex' ? (
                                      <>
                                        <div className="rounded-md border bg-background px-3 py-2">
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-2 text-sm font-medium">
                                            <FontAwesomeIcon icon={faHome} className="text-primary" />
                                            Plex Home
                                          </div>
                                          <Switch
                                              checked={featureState.invite_to_plex_home ?? false}
                                              onCheckedChange={(checked) => {
                                                updateServerFeature(server.id, { invite_to_plex_home: checked });
                                                setForm((prev) => ({ ...prev, invite_to_plex_home: checked }));
                                              }}
                                            />
                                          </div>
                                        </div>
                                        <div className="rounded-md border bg-background px-3 py-2">
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-2 text-sm font-medium">
                                            <FontAwesomeIcon icon={faTv} className="text-purple-400" />
                                            Live TV
                                          </div>
                                          <Switch
                                              checked={featureState.allow_live_tv ?? false}
                                              onCheckedChange={(checked) => {
                                                updateServerFeature(server.id, { allow_live_tv: checked });
                                                setForm((prev) => ({ ...prev, allow_live_tv: checked }));
                                              }}
                                            />
                                          </div>
                                        </div>
                                        <div className="rounded-md border bg-background px-3 py-2">
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-2 text-sm font-medium">
                                            <FontAwesomeIcon icon={faFilm} className="text-primary" />
                                            Allow 4K Transcode
                                          </div>
                                          <Switch
                                              checked={featureState.allow_4k_transcode ?? true}
                                              onCheckedChange={(checked) => {
                                                updateServerFeature(server.id, { allow_4k_transcode: checked });
                                                setForm((prev) => ({ ...prev, allow_4k_transcode: checked }));
                                              }}
                                            />
                                          </div>
                                        </div>
                                      </>
                                    ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Advanced */}
        <div className="space-y-4">
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="rounded-lg border hover:border-primary/50 transition-colors bg-muted/30"
          >
            <CollapsibleTrigger className="flex w-full items-center justify-between p-4 hover:bg-accent/50 transition-colors">
              <div className="flex items-center gap-2">
                <FontAwesomeIcon icon={faCog} className="text-blue-400 text-sm" />
                <span className="text-lg font-medium">Advanced Options</span>
              </div>
              <FontAwesomeIcon icon={faChevronDown} className="text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 p-4 pt-2">
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h5 className="font-medium text-base">Usage & Duration</h5>
                  <span className="text-xs text-muted-foreground">Limits & expiry</span>
                </div>
                <div className="rounded-lg p-4 border bg-background space-y-3">
                  <label className="space-y-1 block">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FontAwesomeIcon icon={faHashtag} className="text-primary" />
                      Maximum Uses
                    </div>
                    <Input
                      type="number"
                      value={form.max_uses ?? ''}
                      onChange={handleChange('max_uses')}
                      min="0"
                      placeholder="Blank = unlimited"
                    />
                    <span className="text-xs text-muted-foreground">0 or blank means unlimited uses.</span>
                  </label>

                  <label className="space-y-1 block">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FontAwesomeIcon icon={faClock} className="text-yellow-400" />
                      Membership Expiration
                    </div>
                    <Input
                      type="date"
                      value={form.membership_expires_at ?? ''}
                      onChange={handleChange('membership_expires_at')}
                    />
                    <span className="text-xs text-muted-foreground">
                      When access to granted libraries should end.
                    </span>
                  </label>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h5 className="font-medium text-base">Discord Requirements</h5>
                  <span className="text-xs text-muted-foreground">Identity & membership</span>
                </div>
                        <div className="space-y-3">
                          <div className="rounded-lg p-4 border bg-background">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <FontAwesomeIcon icon={faDiscord} className="text-blue-400 text-sm" />
                                <div>
                                  <p className="font-medium text-sm">Require Discord Authentication</p>
                                  <p className="text-xs text-muted-foreground">Invitees must link a Discord account.</p>
                                </div>
                              </div>
                              <Switch
                                checked={form.require_discord_auth ?? false}
                                onCheckedChange={(checked) => handleDiscordRequirementToggle('require_discord_auth', checked)}
                              />
                            </div>
                          </div>

                          <div className="rounded-lg p-4 border bg-background">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <FontAwesomeIcon icon={faUsers} className="text-yellow-400 text-sm" />
                                <div>
                                  <p className="font-medium text-sm">Require Discord Server Membership</p>
                                  <p className="text-xs text-muted-foreground">Invitees must be in your Discord server.</p>
                                </div>
                              </div>
                              <Switch
                                checked={form.require_discord_guild_membership ?? false}
                                onCheckedChange={(checked) => handleDiscordRequirementToggle('require_discord_guild_membership', checked)}
                              />
                            </div>
                          </div>
                        </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h5 className="font-medium text-base">Protection Grants</h5>
                  <span className="text-xs text-muted-foreground">Safety defaults</span>
                </div>
                <div className="space-y-3">
                  <div className="rounded-lg p-4 border bg-background">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faShieldHalved} className="text-blue-400 text-sm" />
                        <div>
                          <p className="font-medium text-sm">Grant Purge Whitelist</p>
                          <p className="text-xs text-muted-foreground">Protect from automated purges.</p>
                        </div>
                      </div>
                      <Switch
                        checked={form.grant_purge_whitelist ?? false}
                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, grant_purge_whitelist: checked }))}
                      />
                    </div>
                  </div>

                  <div className="rounded-lg p-4 border bg-background opacity-60">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FontAwesomeIcon icon={faRobot} className="text-blue-400 text-sm" />
                        <div>
                          <p className="font-medium text-sm">Grant Bot Whitelist (WIP)</p>
                          <p className="text-xs text-muted-foreground">Coming soon. Not yet applied.</p>
                        </div>
                      </div>
                      <Switch checked={false} disabled />
                    </div>
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>
    </ResponsiveDialog>
  );
};

export default InviteModal;
