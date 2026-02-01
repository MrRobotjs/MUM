import { useState, useMemo, useEffect, type FormEvent } from 'react';
import { useAlerts } from '../contexts/AlertContext';
import { useInvites } from '../hooks/useInvites';
import { useAdminApi } from '../hooks/useAdminApi';
import { useInviteSummary } from '../hooks/useInviteSummary';
import { useDiscordSettings } from '../hooks/useSettings';
import { InvitesTable, InviteRow, InviteModal, InviteFormValues, InviteDetailDrawer, InviteCard, FeatureMeta } from '../components/invites';
import { requestJson } from '../util/apiClient';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Label } from '../components/ui/label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '../components/ui/dropdown-menu';
import { Button } from '../components/ui/button';
import { ResponsiveDialog } from '../components/ui/responsive-dialog';
import { PageHeader } from '../components';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBan,
  faCheck,
  faDownload,
  faFilter,
  faGaugeHigh,
  faHome,
  faList,
  faEllipsis,
  faPlus,
  faSave,
  faServer,
  faSliders,
  faSquare,
  faSquareCheck,
  faTableCellsLarge,
  faTicket,
  faTrash,
  faTv,
} from '@fortawesome/free-solid-svg-icons';
import type { InviteLibrary, InviteServer } from '../components/invites/InvitesTable';
import { getServiceBadgeClass as getServiceBadgeMeta, getServiceIcon } from '../config/pluginMetadata';
import { Spinner } from '@/components/ui/spinner'

// Helper function to get service-specific styling
const getServiceBadgeClass = (serviceType: string): string => {
  const fallback = 'bg-gray-500/10 text-gray-400 border-gray-500/20';
  if (!serviceType) return fallback;
  return getServiceBadgeMeta(serviceType) || fallback;
};

const renderServiceIcon = (serviceType: string, className?: string): JSX.Element => {
  return getServiceIcon(serviceType, className);
};

type FeatureKey = 'allow_downloads' | 'invite_to_plex_home' | 'allow_live_tv' | 'allow_4k_transcode';

type PluginMetaResponse = {
  data: Record<
    string,
    {
      invite_features?: string[];
    }
  >;
};

type FeatureMetaConfig = {
  key: FeatureKey;
  label: string;
  icon: IconDefinition;
  defaultClassName: string;
  tintServiceType?: string;
  hideIfUniformTrue?: boolean;
};

const FEATURE_META_CONFIG: FeatureMetaConfig[] = [
  {
    key: 'allow_downloads',
    label: 'Downloads',
    icon: faDownload,
    defaultClassName: 'bg-blue-500/10 text-blue-500 border-blue-500/20'
  },
  {
    key: 'invite_to_plex_home',
    label: 'Plex Home',
    icon: faHome,
    tintServiceType: 'plex',
    defaultClassName: 'bg-[#e5a00d]/10 text-[#e5a00d] border-[#e5a00d]/20'
  },
  {
    key: 'allow_live_tv',
    label: 'Live TV',
    icon: faTv,
    tintServiceType: 'plex',
    defaultClassName: 'bg-purple-500/10 text-purple-500 border-purple-500/20'
  },
  {
    key: 'allow_4k_transcode',
    label: '4K Transcode',
    icon: faGaugeHigh,
    defaultClassName: 'bg-sky-500/10 text-sky-600 border-sky-500/20'
  }
];

const buildFeatureMeta = (inviteFeatureSupport: Record<string, string[]>): FeatureMeta[] => {
  const servicesSupportingFeature = (key: FeatureKey) => {
    return Object.entries(inviteFeatureSupport)
      .filter(([, features]) => Array.isArray(features) && features.includes(key))
      .map(([serviceId]) => serviceId.toLowerCase());
  };

  const serviceTintClass = (serviceType?: string) => {
    if (!serviceType) return undefined;
    return `border ${getServiceBadgeClass(serviceType)}`;
  };

  const serviceIcon = (_serviceType?: string, fallbackIcon?: IconDefinition) => {
    return fallbackIcon || faServer;
  };

  return FEATURE_META_CONFIG.map((cfg) => {
    const onlyServices = servicesSupportingFeature(cfg.key);
    return {
      key: cfg.key,
      label: cfg.label,
      icon: serviceIcon(cfg.tintServiceType, cfg.icon),
      className: serviceTintClass(cfg.tintServiceType) ?? cfg.defaultClassName,
      onlyServices,
      hideIfUniformTrue: cfg.hideIfUniformTrue
    };
  });
};

const mapInviteToForm = (invite: InviteRow): InviteFormValues => {
  const serverIds = (invite.servers ?? []).map((s: InviteServer) => s.id);
  const libraryIds = (invite.libraries ?? []).map((l: InviteLibrary) => l.id);

  return {
    custom_path: invite.custom_path ?? '',
    expires_at: invite.expires_at ?? null,
    max_uses: invite.max_uses ?? null,
    allow_downloads: invite.allow_downloads ?? false,
    is_active: invite.is_active ?? true,
    server_ids: serverIds,
    grant_library_ids: libraryIds,
    invite_to_plex_home: invite.invite_to_plex_home ?? false,
    allow_live_tv: invite.allow_live_tv ?? false,
    allow_4k_transcode: invite.allow_4k_transcode ?? true,
    require_discord_auth: invite.require_discord_auth ?? false,
    require_discord_guild_membership: invite.require_discord_guild_membership ?? false,
    grant_purge_whitelist: invite.grant_purge_whitelist ?? false,
    grant_bot_whitelist: invite.grant_bot_whitelist ?? false,
    membership_expires_at: null,
    server_features: invite.server_features ?? []
  };
};

export const InvitesPage = () => {
  const { success, error: showError } = useAlerts();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [serverFilter, setServerFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [editingInvite, setEditingInvite] = useState<InviteRow | null>(null);
  const [editingInitialValues, setEditingInitialValues] = useState<InviteFormValues | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailInviteId, setDetailInviteId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [inviteSettings, setInviteSettings] = useState({
    default_require_discord_auth: false,
    default_require_discord_guild_membership: false,
  });
  const [inviteSettingsDirty, setInviteSettingsDirty] = useState(false);
  const [inviteSettingsSaving, setInviteSettingsSaving] = useState(false);
  const { data: serversData } = useAdminApi<{ data: { id: number; server_nickname: string }[] }>('/servers', true);
  const { data: pluginMetaData } = useAdminApi<PluginMetaResponse>('/plugins/metadata', true);
  const { summary } = useInviteSummary();
  const { settings: discordSettings, refresh: refreshDiscordSettings } = useDiscordSettings();
  const { invites, pagination, loading, error, refresh } = useInvites({
    status: statusFilter === 'all' ? undefined : statusFilter,
    page,
    search: searchTerm || undefined,
    serverId: serverFilter === 'all' ? undefined : Number(serverFilter)
  });

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [statusFilter, searchTerm, serverFilter]);

  useEffect(() => {
    if (!settingsOpen || !discordSettings) return;
    const defaultRequireGuild = discordSettings.default_require_discord_guild_membership ?? false;
    const defaultRequireAuth = (discordSettings.default_require_discord_auth ?? false) || defaultRequireGuild;
    setInviteSettings({
      default_require_discord_auth: defaultRequireAuth,
      default_require_discord_guild_membership: defaultRequireGuild,
    });
    setInviteSettingsDirty(false);
  }, [settingsOpen, discordSettings]);

  const inviteFeatureSupport = useMemo(() => {
    const meta = pluginMetaData?.data ?? {};
    return Object.entries(meta).reduce<Record<string, string[]>>((acc, [pluginId, value]) => {
      acc[pluginId.toLowerCase()] = value.invite_features ?? [];
      return acc;
    }, {});
  }, [pluginMetaData]);

  const featureMeta = useMemo(() => buildFeatureMeta(inviteFeatureSupport), [inviteFeatureSupport]);

  const toggleSelect = (inviteId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(inviteId)) {
        next.delete(inviteId);
      } else {
        next.add(inviteId);
      }
      return next;
    });
  };

  const handleSelectAll = (select: boolean) => {
    setSelectedIds(select ? new Set(invites.map((invite) => invite.id)) : new Set());
  };

  const handleBulkAction = async (action: 'enable' | 'disable' | 'delete') => {
    if (selectedIds.size === 0) return;
    try {
      await requestJson('/admin/api/v2/invites/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: Array.from(selectedIds), action })
      });
      success(`Invites ${action}d successfully`);
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      showError('Bulk action failed: ' + String(err));
    }
  };

  const openCreateModal = () => {
    const defaultRequireGuild = discordSettings?.default_require_discord_guild_membership ?? false;
    const defaultRequireAuth = discordSettings?.default_require_discord_auth ?? false;
    const requireAuth = defaultRequireAuth || defaultRequireGuild;
    setEditingInvite(null);
    setEditingInitialValues({
      require_discord_auth: requireAuth,
      require_discord_guild_membership: defaultRequireGuild,
    });
    setModalOpen(true);
  };

  const openEditModal = (invite: InviteRow) => {
    setEditingInvite(invite);
    setEditingInitialValues(mapInviteToForm(invite));
    setModalOpen(true);
  };

  const openDetailDrawer = (invite: InviteRow) => {
    setDetailInviteId(invite.id);
  };

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearchTerm(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearchTerm('');
  };

  const handleSaveInvite = async (values: InviteFormValues) => {
    setSaving(true);
    try {
      const endpoint = editingInvite ? `/admin/api/v2/invites/${editingInvite.id}` : '/admin/api/v2/invites';
      const method = editingInvite ? 'PATCH' : 'POST';
      await requestJson(endpoint, {
        method,
        body: JSON.stringify(values)
      });
      success(editingInvite ? 'Invite updated' : 'Invite created');
      setModalOpen(false);
      setEditingInvite(null);
      await refresh();
    } catch (err) {
      showError('Failed to save invite: ' + String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleInviteSettingsToggle = (
    field: 'default_require_discord_auth' | 'default_require_discord_guild_membership',
    value: boolean
  ) => {
    setInviteSettings((prev) => {
      const next = { ...prev, [field]: value };
      if (field === 'default_require_discord_guild_membership' && value) {
        next.default_require_discord_auth = true;
      }
      if (field === 'default_require_discord_auth' && !value) {
        next.default_require_discord_guild_membership = false;
      }
      return next;
    });
    setInviteSettingsDirty(true);
  };

  const handleSaveInviteSettings = async () => {
    if (!discordSettings) {
      showError('Discord settings are not loaded yet.');
      return;
    }
    setInviteSettingsSaving(true);
    try {
      await requestJson('/admin/api/v2/settings/discord', {
        method: 'PATCH',
        body: JSON.stringify({
          enable_oauth: discordSettings.enable_oauth,
          enable_bot: discordSettings.enable_bot,
          enable_membership_requirement: discordSettings.enable_membership_requirement,
          default_require_discord_auth: inviteSettings.default_require_discord_auth,
          default_require_discord_guild_membership: inviteSettings.default_require_discord_guild_membership,
          client_id: discordSettings.client_id ?? '',
          client_secret: '',
          oauth_auth_url: discordSettings.oauth_auth_url ?? '',
          redirect_uri_invite: discordSettings.redirect_uri_invite ?? '',
          redirect_uri_admin: discordSettings.redirect_uri_admin ?? '',
          guild_id: discordSettings.guild_id ?? '',
          server_invite_url: discordSettings.server_invite_url ?? '',
          bot_token: '',
          monitored_role_id: discordSettings.monitored_role_id ?? '',
          thread_channel_id: discordSettings.thread_channel_id ?? '',
          bot_log_channel_id: discordSettings.bot_log_channel_id ?? '',
          whitelist_sharers: discordSettings.whitelist_sharers,
        })
      });
      success('Invite settings saved');
      setInviteSettingsDirty(false);
      setSettingsOpen(false);
      await refreshDiscordSettings();
    } catch (err) {
      showError('Failed to save invite settings: ' + String(err));
    } finally {
      setInviteSettingsSaving(false);
    }
  };

  const statusOptions = useMemo(
    () => [
      { label: 'All', value: 'all' },
      { label: 'Usable', value: 'usable' },
      { label: 'Active', value: 'active' },
      { label: 'Inactive', value: 'inactive' },
      { label: 'Expired', value: 'expired' },
      { label: 'Maxed', value: 'maxed' }
    ],
    []
  );

  const totalPages = pagination?.total_pages ?? 1;
  const currentPage = pagination?.page ?? page;

  const goToPage = (nextPage: number) => {
    const clamped = Math.max(1, Math.min(nextPage, totalPages));
    setPage(clamped);
  };

  const handleCopyLink = (invite: InviteRow) => {
    const invitePath = invite.custom_path || invite.token;
    const fullUrl = `${window.location.origin}/invite/${invitePath}`;
    navigator.clipboard.writeText(fullUrl);
    success('Invite link copied!');
  };

  const headerActions = (
    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
      <Button onClick={openCreateModal} className="w-full sm:w-auto">
        <FontAwesomeIcon icon={faPlus} className="mr-2" /> Create Invite
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" type="button" title="More options">
            <FontAwesomeIcon icon={faEllipsis} className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className="w-56 rounded-lg" align="end" side="bottom" sideOffset={8}>
            <DropdownMenuLabel>View Mode</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setViewMode('table')}
              className={viewMode === 'table' ? 'bg-primary/10' : ''}
            >
              <FontAwesomeIcon icon={faList} fixedWidth className="mr-2" />
              <span className="flex-1">Table View</span>
              {viewMode === 'table' && <FontAwesomeIcon icon={faCheck} fixedWidth className="ml-2 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('cards')}
              className={viewMode === 'cards' ? 'bg-primary/10' : ''}
            >
              <FontAwesomeIcon icon={faTableCellsLarge} fixedWidth className="mr-2" />
              <span className="flex-1">Card View</span>
              {viewMode === 'cards' && <FontAwesomeIcon icon={faCheck} fixedWidth className="ml-2 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Settings</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
              <FontAwesomeIcon icon={faSliders} fixedWidth className="mr-2" />
              <span className="flex-1">Invite Settings</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="container mx-auto px-4 py-2 space-y-6">
      {/* Header */}
      <PageHeader
        title={`Manage Invites (${pagination?.total_items ?? 0})`}
        description="Create and manage shareable access to your media servers."
        actions={headerActions}
      />

      {/* Filter Section */}
      <form method="GET" className="mb-6 p-4 rounded-lg border shadow-sm bg-card" onSubmit={handleSearchSubmit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div className="flex flex-col gap-2">
            <Label>Filter by Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label>Search by Path</Label>
            <Input
              type="text"
              name="search_path"
              placeholder="Custom path part"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Server</Label>
            <Select value={serverFilter} onValueChange={setServerFilter}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All servers</SelectItem>
                {(serversData?.data ?? []).map((server) => (
                  <SelectItem key={server.id} value={server.id.toString()}>
                    {server.server_nickname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label className="opacity-0" aria-hidden="true">
              Apply
            </Label>
            <Button type="submit" className="w-full">
              <FontAwesomeIcon icon={faFilter} className="mr-2" /> Apply
            </Button>
          </div>
        </div>
      </form>

      {/* Mass Actions Container */}
      {selectedIds.size > 0 && (
        <div className="mb-4 p-4 rounded-lg border shadow-sm">
          <div className="flex items-center flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              onClick={() => handleBulkAction('delete')}
            >
              <FontAwesomeIcon icon={faTrash} className="mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Delete ({selectedIds.size} selected)</span>
              <span className="inline-block sm:hidden">({selectedIds.size})</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleBulkAction('disable')}
            >
              <FontAwesomeIcon icon={faBan} className="mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Disable Selected</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleBulkAction('enable')}
            >
              <FontAwesomeIcon icon={faCheck} className="mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Enable Selected</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSelectAll(true)}
              title="Select all invites currently visible"
            >
              <FontAwesomeIcon icon={faSquareCheck} className="mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Select All</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSelectAll(false)}
              title="Deselect All"
            >
              <FontAwesomeIcon icon={faSquare} className="mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Deselect All</span>
            </Button>
          </div>
        </div>
      )}

      {error ? <div className="text-sm text-destructive">Failed to load invites: {(error as Error).message}</div> : null}

      {/* Render based on view mode */}
      {viewMode === 'table' ? (
        <InvitesTable
          invites={invites}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={handleSelectAll}
          loading={loading}
          onEdit={openEditModal}
          onViewDetail={openDetailDrawer}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {loading ? (
            <div className="col-span-full text-center p-8">
              <Spinner className="h-12 w-12 text-primary mx-auto mb-4" />
              <p>Loading invites...</p>
            </div>
          ) : invites.length === 0 ? (
            <div className="col-span-full text-center py-10 rounded-lg border shadow-sm">
              <FontAwesomeIcon icon={faTicket} size="3x" className="text-muted-foreground mb-4" />
              <p className="text-xl text-muted-foreground">No invites found matching your criteria.</p>
            </div>
          ) : (
            invites.map((invite) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                selected={selectedIds.has(invite.id)}
                onToggleSelect={toggleSelect}
                onEdit={openEditModal}
                onViewDetail={openDetailDrawer}
                onCopyLink={handleCopyLink}
                featureMeta={featureMeta}
                getServiceBadgeClass={getServiceBadgeClass}
                getServiceIcon={renderServiceIcon}
              />
            ))
          )}
        </div>
      )}

      {pagination ? (
        <div className="flex items-center justify-between rounded-lg border px-4 py-3 text-sm">
          <div className="text-muted-foreground">
            Page {currentPage} of {totalPages} - {pagination.total_items} invite
            {pagination.total_items === 1 ? '' : 's'}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      <InviteModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setEditingInvite(null);
          setEditingInitialValues(undefined);
        }}
        initialValues={editingInitialValues}
        isEditing={Boolean(editingInvite)}
        onSubmit={handleSaveInvite}
        loading={saving}
      />

      <InviteDetailDrawer inviteId={detailInviteId} onClose={() => setDetailInviteId(null)} />

      <ResponsiveDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        title="Invite Settings"
        description="Configure defaults for new invites."
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setSettingsOpen(false)} disabled={inviteSettingsSaving}>
            Cancel
          </Button>,
          <Button
            key="save"
            onClick={handleSaveInviteSettings}
            disabled={!inviteSettingsDirty || inviteSettingsSaving || !discordSettings}
          >
            {inviteSettingsSaving ? (
              <>
                <Spinner className="mr-2 size-3" />
                Saving...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faSave} className="mr-2" />
                Save Defaults
              </>
            )}
          </Button>,
        ]}
        contentClassName="max-w-lg"
      >
        {!discordSettings ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4 text-muted-foreground" />
            Loading Discord settings...
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="rounded-lg border border-border/70 bg-muted/40 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">Default Discord Link Requirement</p>
                  <p className="text-xs text-muted-foreground">
                    New invites will require Discord login unless you disable it per invite.
                  </p>
                </div>
                <Switch
                  checked={inviteSettings.default_require_discord_auth}
                  onCheckedChange={(checked) => handleInviteSettingsToggle('default_require_discord_auth', checked)}
                  disabled={inviteSettings.default_require_discord_guild_membership}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-foreground">Default Discord Membership Requirement</p>
                  <p className="text-xs text-muted-foreground">
                    New invites will require users to be members of your Discord server.
                  </p>
                </div>
                <Switch
                  checked={inviteSettings.default_require_discord_guild_membership}
                  onCheckedChange={(checked) =>
                    handleInviteSettingsToggle('default_require_discord_guild_membership', checked)
                  }
                />
              </div>

              {inviteSettings.default_require_discord_guild_membership && (
                <p className="text-xs text-muted-foreground">
                  Discord login is required when membership is required by default.
                </p>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              These defaults apply to newly created invites. Existing invites keep their current settings.
            </p>
          </div>
        )}
      </ResponsiveDialog>
    </div>
  );
};

export default InvitesPage;
