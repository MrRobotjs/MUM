import { useState, useEffect } from 'react';
import { requestJson } from '../../util/apiClient';
import { Input } from '../ui/input';
import { Checkbox } from '../ui/checkbox';
import { Switch } from '../ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Card } from '../ui/card';
import { Button } from '@/components/ui/button';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';

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
};

type Server = {
  id: number;
  server_nickname: string;
  service_type: string;
  is_active: boolean;
};

type Library = {
  id: string;
  name: string;
  external_id?: string;
  internal_id?: string;
};

type ServerWithLibraries = Server & {
  libraries?: Library[];
  loadingLibraries?: boolean;
};

type InviteModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: InviteFormValues) => Promise<void> | void;
  initialValues?: InviteFormValues;
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
  allow_4k_transcode: false,
  require_discord_auth: false,
  require_discord_guild_membership: false,
  grant_purge_whitelist: false,
  grant_bot_whitelist: false
};

export const InviteModal = ({ open, onClose, onSubmit, initialValues, loading }: InviteModalProps) => {
  const [form, setForm] = useState<InviteFormValues>(defaultValues);
  const [servers, setServers] = useState<ServerWithLibraries[]>([]);
  const [selectedServerIds, setSelectedServerIds] = useState<Set<number>>(new Set());
  const [selectedLibraries, setSelectedLibraries] = useState<Set<string>>(new Set());
  const [loadingServers, setLoadingServers] = useState(true);
  const [serverError, setServerError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Load servers on mount
  useEffect(() => {
    if (open) {
      loadServers();
    }
  }, [open]);

  // Reset form when modal opens/closes or initial values change
  useEffect(() => {
    if (open) {
      setForm({ ...defaultValues, ...initialValues });
      setSelectedServerIds(new Set(initialValues?.server_ids || []));
      setSelectedLibraries(new Set(initialValues?.grant_library_ids || []));
    } else {
      // Reset on close
      setForm(defaultValues);
      setSelectedServerIds(new Set());
      setSelectedLibraries(new Set());
      setAdvancedOpen(false);
    }
  }, [initialValues, open]);

  const loadServers = async () => {
    setLoadingServers(true);
    try {
      const response = await requestJson('/admin/api/v2/servers', { method: 'GET' });
      setServers(response.data || []);
      setLoadingServers(false);
    } catch (error) {
      console.error('Failed to load servers:', error);
      setLoadingServers(false);
    }
  };

  const loadLibrariesForServer = async (serverId: number, forceRefresh = false) => {
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

        // Auto-select all libraries for this server
        const libraryIds = response.libraries.map((lib: Library) => lib.id || lib.external_id || lib.internal_id);
        setSelectedLibraries((prev) => {
          const newSet = new Set(prev);
          libraryIds.forEach((id: string) => newSet.add(id));
          return newSet;
        });
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
    const newSelected = new Set(selectedServerIds);

    if (newSelected.has(serverId)) {
      newSelected.delete(serverId);
      // Remove libraries for this server
      const server = servers.find((s) => s.id === serverId);
      if (server?.libraries) {
        server.libraries.forEach((lib) => {
          const libId = lib.id || lib.external_id || lib.internal_id;
          if (libId) {
            selectedLibraries.delete(libId);
          }
        });
        setSelectedLibraries(new Set(selectedLibraries));
      }
    } else {
      newSelected.add(serverId);
      // Load libraries if not already loaded
      const server = servers.find((s) => s.id === serverId);
      if (server && !server.libraries) {
        loadLibrariesForServer(serverId);
      } else if (server?.libraries) {
        // Auto-select all libraries
        const libraryIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
        setSelectedLibraries((prev) => {
          const newSet = new Set(prev);
          libraryIds.forEach((id) => newSet.add(id));
          return newSet;
        });
      }
    }

    setSelectedServerIds(newSelected);
  };

  const toggleLibrary = (libraryId: string) => {
    const newSelected = new Set(selectedLibraries);
    if (newSelected.has(libraryId)) {
      newSelected.delete(libraryId);
    } else {
      newSelected.add(libraryId);
    }
    setSelectedLibraries(newSelected);
  };

  const selectAllLibraries = (serverId: number) => {
    const server = servers.find((s) => s.id === serverId);
    if (server?.libraries) {
      const libraryIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
      setSelectedLibraries((prev) => {
        const newSet = new Set(prev);
        libraryIds.forEach((id) => newSet.add(id));
        return newSet;
      });
    }
  };

  const deselectAllLibraries = (serverId: number) => {
    const server = servers.find((s) => s.id === serverId);
    if (server?.libraries) {
      const libraryIds = server.libraries.map((lib) => lib.id || lib.external_id || lib.internal_id);
      setSelectedLibraries((prev) => {
        const newSet = new Set(prev);
        libraryIds.forEach((id) => newSet.delete(id));
        return newSet;
      });
    }
  };

  const handleChange = (field: keyof InviteFormValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async () => {
    // Validate server selection
    if (selectedServerIds.size === 0) {
      setServerError('Please select at least one server to grant access to.');
      return;
    }

    const submitData = {
      ...form,
      server_ids: Array.from(selectedServerIds),
      grant_library_ids: Array.from(selectedLibraries)
    };

    await onSubmit(submitData);
  };

  const getServiceIcon = (serviceType: string) => {
    const type = serviceType?.toLowerCase();
    switch (type) {
      case 'plex':
        return 'fa-solid fa-play';
      case 'jellyfin':
        return 'fa-solid fa-cube';
      case 'emby':
        return 'fa-solid fa-play-circle';
      case 'kavita':
        return 'fa-solid fa-book';
      case 'audiobookshelf':
        return 'fa-solid fa-headphones';
      case 'komga':
        return 'fa-solid fa-book-open';
      case 'romm':
        return 'fa-solid fa-gamepad';
      default:
        return 'fa-solid fa-server';
    }
  };

  const getServiceColorClass = (serviceType: string) => {
    const type = serviceType?.toLowerCase();
    return `text-${type}`;
  };

  // Group servers by service type
  const groupedServers = servers.reduce((acc, server) => {
    const type = server.service_type || 'Unknown';
    if (!acc[type]) {
      acc[type] = [];
    }
    acc[type].push(server);
    return acc;
  }, {} as Record<string, ServerWithLibraries[]>);

  const handleOpenChange = (value: boolean) => {
    if (!value) {
      onClose();
    }
  };

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
          <i className="fa-solid fa-ticket-simple mr-2" />
          {initialValues ? 'Update Invite' : 'Create Invite'}
        </>
      )}
    </Button>,
  ];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={initialValues ? 'Edit Invite' : 'Create Invite'}
      description="Configure invite settings, select servers, and set permissions."
      footer={footerButtons}
      contentClassName="max-w-4xl"
      bodyClassName="space-y-6"
    >
      {/* Description Card */}
      <div className="rounded-lg p-4 mb-6 border bg-muted/50">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
            <i className="fa-solid fa-info text-primary text-sm" />
          </div>
          <div>
            <h4 className="font-medium mb-1">Invitation Setup</h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Configure invite settings, select servers, and set permissions for new users.
            </p>
          </div>
        </div>
      </div>

      {/* Basic Settings Section */}
      <div className="space-y-4 mb-6">
        <h4 className="font-medium text-lg mb-3">Basic Settings</h4>

        {/* Custom Path */}
        <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-muted/30">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <i className="fa-solid fa-link text-primary text-sm" />
              <h5 className="font-medium">Custom Path</h5>
              <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium border border-yellow-500/20 bg-yellow-500/10 text-yellow-400">Optional</span>
            </div>
          </div>
          <Input
            type="text"
            value={form.custom_path ?? ''}
            onChange={handleChange('custom_path')}
            placeholder="e.g., 'besties' or 'vip_access'"
          />
          <span className="text-muted-foreground text-xs mt-1 block">
            Create a custom URL path for this invite (leave blank for auto-generated token)
          </span>
        </div>

        {/* Expiration Date */}
        <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-muted/30">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <i className="fa-solid fa-calendar text-yellow-400 text-sm" />
              <h5 className="font-medium">Invite Expiration Date</h5>
            </div>
          </div>
          <Input
            type="date"
            value={form.expires_at ?? ''}
            onChange={handleChange('expires_at')}
          />
          <span className="text-muted-foreground text-xs mt-1 block">
            The invite link will expire on this date (leave blank for no expiration)
          </span>
        </div>
      </div>

      {/* Server Selection Section */}
      <div className="space-y-4 mb-6">
        <h4 className="font-medium text-lg mb-3">Server & Access Configuration</h4>

        {serverError && (
          <div className="text-destructive text-sm bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <i className="fa-solid fa-exclamation-triangle mr-1" />
            {serverError}
          </div>
        )}

        {loadingServers ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2" />
            <p className="text-sm text-muted-foreground mt-2">Loading servers...</p>
          </div>
        ) : Object.keys(groupedServers).length === 0 ? (
          <div className="text-center py-8 rounded-lg border bg-muted/30">
            <i className="fa-solid fa-server text-muted-foreground text-3xl mb-2" />
            <p className="text-sm text-muted-foreground">No servers available</p>
          </div>
        ) : (
          Object.entries(groupedServers).map(([serviceType, serviceServers]) => (
            <Collapsible
              key={serviceType}
              defaultOpen={Object.keys(groupedServers).length === 1}
              className="rounded-md border bg-muted/30"
            >
              <CollapsibleTrigger className="flex w-full items-center justify-between p-4 hover:bg-accent/50 transition-colors">
                <div className="flex items-center">
                  <i className={`${getServiceIcon(serviceType)} ${getServiceColorClass(serviceType)} fa-lg mr-2`} />
                  <span className="text-lg font-medium">{serviceType}</span>
                </div>
                <i className="fa-solid fa-chevron-down text-muted-foreground" />
              </CollapsibleTrigger>
              <CollapsibleContent className="p-4 pt-0">
                <div className="grid grid-cols-1 gap-4">
                  {serviceServers.map((server) => {
                    const isSelected = selectedServerIds.has(server.id);
                    return (
                      <Card
                        key={server.id}
                        className={`shadow-xl cursor-pointer border-2 relative transition-colors ${
                          isSelected ? 'border-primary' : 'border-transparent'
                        }`}
                        onClick={() => toggleServer(server.id)}
                      >
                        {isSelected && (
                          <div className="absolute top-2 right-2">
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-6 w-6 text-primary"
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </div>
                        )}
                        <div className="p-4 pt-3">
                          <h4 className="font-bold text-md mb-2 border-b pb-2">
                            <i className="fa-solid fa-server mr-2" />
                            {server.server_nickname}
                          </h4>

                          {isSelected && (
                            <div
                              className="space-y-4"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* Library Access */}
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <label className="text-sm font-medium">Library Access</label>
                                  <div className="flex items-center gap-1 text-xs">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => selectAllLibraries(server.id)}
                                    >
                                      All
                                    </Button>
                                    <span className="text-muted-foreground">|</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => deselectAllLibraries(server.id)}
                                    >
                                      None
                                    </Button>
                                    <span className="text-muted-foreground">|</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => loadLibrariesForServer(server.id, true)}
                                      title="Refresh libraries from server"
                                    >
                                      <i className="fa-solid fa-refresh" />
                                    </Button>
                                  </div>
                                </div>
                                <div className="max-h-40 overflow-y-auto p-2 border rounded-md bg-background/50 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
                                  {server.loadingLibraries ? (
                                    <div className="text-center py-4 col-span-2">
                                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary inline-block mr-2" />
                                      <span className="text-muted-foreground text-sm">Loading libraries...</span>
                                    </div>
                                  ) : !server.libraries || server.libraries.length === 0 ? (
                                    <div className="text-center py-4 text-muted-foreground col-span-2">
                                      No libraries found
                                    </div>
                                  ) : (
                                    server.libraries.map((library) => {
                                      const libId = library.id || library.external_id || library.internal_id;
                                      return (
                                        <label key={libId} className="flex items-center cursor-pointer py-1">
                                          <Checkbox
                                            checked={selectedLibraries.has(libId || '')}
                                            onCheckedChange={() => toggleLibrary(libId || '')}
                                            className="mr-2"
                                          />
                                          <span className="text-sm" title={library.name}>
                                            {library.name.length > 30
                                              ? library.name.substring(0, 30) + '...'
                                              : library.name}
                                          </span>
                                        </label>
                                      );
                                    })
                                  )}
                                </div>
                              </div>

                              {/* Allow Downloads */}
                              <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                  <label className="text-sm font-medium cursor-pointer">
                                    <i className="fa-solid fa-download mr-2 text-blue-400" />
                                    Allow Downloads
                                  </label>
                                  <Switch
                                    checked={form.allow_downloads ?? false}
                                    onCheckedChange={(checked) => setForm((prev) => ({ ...prev, allow_downloads: checked }))}
                                  />
                                </div>
                                <p className="text-xs text-muted-foreground">
                                  Users can download media from this server
                                </p>
                              </div>

                              {/* Plex-specific options */}
                              {server.service_type?.toLowerCase() === 'plex' && (
                                <>
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <label className="text-sm font-medium cursor-pointer">
                                        <i className="fa-solid fa-home mr-2 text-primary" />
                                        Invite to Plex Home
                                      </label>
                                      <Switch
                                        checked={form.invite_to_plex_home ?? false}
                                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, invite_to_plex_home: checked }))}
                                      />
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      Add users as Plex Home members
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <label className="text-sm font-medium cursor-pointer">
                                        <i className="fa-solid fa-tv mr-2 text-purple-400" />
                                        Allow Live TV
                                      </label>
                                      <Switch
                                        checked={form.allow_live_tv ?? false}
                                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, allow_live_tv: checked }))}
                                      />
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      Grant access to Live TV & DVR
                                    </p>
                                  </div>
                                  <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                      <label className="text-sm font-medium cursor-pointer">
                                        <i className="fa-solid fa-film mr-2 text-primary" />
                                        Allow 4K Transcode
                                      </label>
                                      <Switch
                                        checked={form.allow_4k_transcode ?? false}
                                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, allow_4k_transcode: checked }))}
                                      />
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                      Allow transcoding of 4K content
                                    </p>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))
        )}
      </div>

      {/* Advanced Options Section */}
      <div className="space-y-4 mb-6">
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="rounded-lg border hover:border-primary/50 transition-colors bg-muted/30"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between p-4 hover:bg-accent/50 transition-colors">
            <div className="flex items-center gap-2">
              <i className="fa-solid fa-cog text-blue-400 text-sm" />
              <span className="text-lg font-medium">Advanced Options</span>
            </div>
            <i className="fa-solid fa-chevron-down text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 p-4 pt-2">
            {/* Usage & Duration Limits */}
            <div className="space-y-3">
              <h5 className="font-medium text-base mb-3">Usage & Duration Limits</h5>

              {/* Number of Uses */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <i className="fa-solid fa-hashtag text-primary text-sm" />
                    <h6 className="font-medium">Maximum Uses</h6>
                  </div>
                </div>
                <Input
                  type="number"
                  value={form.max_uses ?? ''}
                  onChange={handleChange('max_uses')}
                  min="0"
                  placeholder="Leave blank for unlimited"
                />
                <span className="text-muted-foreground text-xs mt-1 block">
                  Maximum number of times this invite can be used (0 or blank = unlimited)
                </span>
              </div>

              {/* Membership Duration */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <i className="fa-solid fa-clock text-yellow-400 text-sm" />
                    <h6 className="font-medium">Membership Expiration Date</h6>
                  </div>
                </div>
                <Input
                  type="date"
                  value={form.membership_expires_at ?? ''}
                  onChange={handleChange('membership_expires_at')}
                />
                <span className="text-muted-foreground text-xs mt-1 block">
                  When user access should expire (leave blank for permanent access)
                </span>
              </div>
            </div>

            {/* Discord Integration */}
            <div className="space-y-3">
              <h5 className="font-medium text-base mb-3">Discord Integration</h5>

              {/* Require Discord Auth */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <i className="fa-brands fa-discord text-blue-400 text-sm" />
                        <h6 className="font-medium">Require Discord Authentication</h6>
                      </div>
                      <Switch
                        checked={form.require_discord_auth ?? false}
                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, require_discord_auth: checked }))}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Users must authenticate with Discord to accept this invite
                    </p>
                  </div>
                </div>
              </div>

              {/* Guild Membership Requirement */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <i className="fa-solid fa-users text-yellow-400 text-sm" />
                        <h6 className="font-medium">Require Discord Server Membership</h6>
                      </div>
                      <Switch
                        checked={form.require_discord_guild_membership ?? false}
                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, require_discord_guild_membership: checked }))}
                        disabled={!form.require_discord_auth}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Users must be a member of your Discord server
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Protection Grants */}
            <div className="space-y-3">
              <h5 className="font-medium text-base mb-3">Protection Grants</h5>

              {/* Grant Purge Whitelist */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <i className="fa-solid fa-shield-halved text-blue-400 text-sm" />
                        <h6 className="font-medium">Grant Purge Whitelist</h6>
                      </div>
                      <Switch
                        checked={form.grant_purge_whitelist ?? false}
                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, grant_purge_whitelist: checked }))}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Protect users from automatic purge operations
                    </p>
                  </div>
                </div>
              </div>

              {/* Grant Bot Whitelist */}
              <div className="rounded-lg p-4 border hover:border-primary/50 transition-colors bg-background">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <i className="fa-solid fa-robot text-blue-400 text-sm" />
                        <h6 className="font-medium">Grant Bot Whitelist</h6>
                      </div>
                      <Switch
                        checked={form.grant_bot_whitelist ?? false}
                        onCheckedChange={(checked) => setForm((prev) => ({ ...prev, grant_bot_whitelist: checked }))}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Allow bot commands and automated features for these users
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </ResponsiveDialog>
  );
};

export default InviteModal;
