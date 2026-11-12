import { invitationExpiryFields } from '../util/calendarDates';
import { useState, useMemo, useEffect, type FormEvent, type ReactElement } from 'react';
import { useAlerts } from '../contexts/AlertContext';
import { useInvites } from '../hooks/useInvites';
import { useAdminApi } from '../hooks/useAdminApi';
import { usePlugins } from '../hooks/usePlugins';
import { useInviteSummary } from '../hooks/useInviteSummary';
import type { DiscordSettings } from '../hooks/useSettings';
import { InvitesTable, InviteRow, InviteModal, InviteFormValues, InviteDetailDrawer, InviteCard, FeatureMeta } from '../components/invites';
import { saveInvitation, applyInvitationAction, invitationShareURL, openInvitation, membershipDateFromDays } from '../lib/invitations';
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

const renderServiceIcon = (serviceType: string, className?: string): ReactElement => {
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

  return FEATURE_META_CONFIG.filter(cfg => servicesSupportingFeature(cfg.key).length > 0).map((cfg) => {
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
  const libraryIds =
    invite.grant_library_ids && invite.grant_library_ids.length > 0
      ? invite.grant_library_ids
      : (invite.libraries ?? []).map((l: InviteLibrary) => l.id);

  return {
    all_library_server_ids: invite.all_library_server_ids,
    custom_path: invite.custom_path ?? '',
    ...invitationExpiryFields(invite.expires_at),
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
    grant_purge_whitelist: false,
    grant_bot_whitelist: false,
    membership_expires_at: membershipDateFromDays(invite.membership_duration_days),
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
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const viewingArchived = statusFilter === 'archived';
  const [inviteSettings, setInviteSettings] = useState({
    default_require_discord_auth: false,
    default_require_discord_guild_membership: false,
  });
  const [inviteSettingsDirty, setInviteSettingsDirty] = useState(false);
  const [inviteSettingsSaving, setInviteSettingsSaving] = useState(false);
  const { data: serversData } = useAdminApi<{ data: { id: number; server_nickname: string }[] }>('/servers', true);
  // Shares the reshaped /api/providers cache; a raw read of the same key would get whichever shape loaded first.
  const { plugins: providerPlugins } = usePlugins();
  const { summary } = useInviteSummary();
  const [discordSettings] = useState<DiscordSettings | null>(null);
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
    return providerPlugins.reduce<Record<string, string[]>>((acc, provider) => {
      acc[provider.id] = provider.capabilities.includes('invitations.redeem') ? ['allow_downloads'] : [];
      return acc;
    }, {});
  }, [providerPlugins]);

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

  const handleInvitationAction = async (action: 'enable' | 'disable' | 'delete' | 'purge') => {
    if (selectedIds.size === 0) return;
    try {
      await applyInvitationAction(Array.from(selectedIds), action);
      success(action === 'purge' ? `Permanently deleted ${selectedIds.size} invite(s)` : action === 'delete' ? 'Invites archived; history retained' : `Invites ${action}d successfully`);
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      showError('Could not update the invitations: ' + String(err));
    }
  };

  const handleConfirmPurge = async () => {
    setPurging(true);
    try {
      await handleInvitationAction('purge');
    } finally {
      setPurging(false);
      setPurgeConfirmOpen(false);
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
      await saveInvitation(values, editingInvite ? { id: editingInvite.id, revision: editingInvite.revision ?? 0 } : undefined);
      success(editingInvite ? 'Invite updated' : 'Invite created');
      setModalOpen(false);
      setEditingInvite(null);
      await refresh();
    } catch (err) {
      showError('Failed to save invite: ' + String(err));
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

  const handleSaveInviteSettings = async () => showError('Discord invitation defaults are not available yet.');

  const statusOptions = useMemo(
    () => [
      { label: 'All', value: 'all' },
      { label: 'Usable', value: 'usable' },
      { label: 'Paused', value: 'paused' },
      { label: 'Active', value: 'active' },
      { label: 'Inactive', value: 'inactive' },
      { label: 'Expired', value: 'expired' },
      { label: 'Maxed', value: 'maxed' },
      { label: 'Archived', value: 'archived' }
    ],
    []
  );

  const totalPages = pagination?.total_pages ?? 1;
  const currentPage = pagination?.page ?? page;

  const goToPage = (nextPage: number) => {
    const clamped = Math.max(1, Math.min(nextPage, totalPages));
    setPage(clamped);
  };

  const handleCopyLink = async (invite: InviteRow) => {
    try {
      await navigator.clipboard.writeText(await invitationShareURL(invite.id));
      success('Invite link copied!');
    } catch (error) { showError('Unable to copy invite link: ' + String(error)); }
  };
  const handleOpenLink = async (invite: InviteRow) => {
    try { await openInvitation(invite.id); } catch (error) { showError('Unable to open invite: ' + String(error)); }
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
            {viewingArchived ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => setPurgeConfirmOpen(true)}
              >
                <FontAwesomeIcon icon={faTrash} className="mr-0 sm:mr-2" />
                <span className="hidden sm:inline-block">Delete Permanently ({selectedIds.size} selected)</span>
                <span className="inline-block sm:hidden">({selectedIds.size})</span>
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => handleInvitationAction('delete')}
                >
                  <FontAwesomeIcon icon={faTrash} className="mr-0 sm:mr-2" />
                  <span className="hidden sm:inline-block">Delete ({selectedIds.size} selected)</span>
                  <span className="inline-block sm:hidden">({selectedIds.size})</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleInvitationAction('disable')}
                >
                  <FontAwesomeIcon icon={faBan} className="mr-0 sm:mr-2" />
                  <span className="hidden sm:inline-block">Disable Selected</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleInvitationAction('enable')}
                >
                  <FontAwesomeIcon icon={faCheck} className="mr-0 sm:mr-2" />
                  <span className="hidden sm:inline-block">Enable Selected</span>
                </Button>
              </>
            )}
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
          onOpen={handleOpenLink}
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
                onOpen={handleOpenLink}
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
        open={purgeConfirmOpen}
        onOpenChange={(open) => { if (!purging) setPurgeConfirmOpen(open); }}
        title={selectedIds.size === 1 ? 'Permanently delete this invite?' : `Permanently delete ${selectedIds.size} invites?`}
        description="This cannot be undone."
        footer={[
          <Button key="cancel" variant="outline" onClick={() => setPurgeConfirmOpen(false)} disabled={purging}>
            Cancel
          </Button>,
          <Button key="purge" variant="destructive" onClick={handleConfirmPurge} disabled={purging || selectedIds.size === 0}>
            {purging ? (
              <>
                <Spinner className="mr-2 size-3" />
                Deleting...
              </>
            ) : (
              <>
                <FontAwesomeIcon icon={faTrash} className="mr-2" />
                Delete Permanently
              </>
            )}
          </Button>,
        ]}
        contentClassName="max-w-lg"
      >
        <div className="space-y-3 text-sm">
          <p>
            Are you sure you want to permanently delete {selectedIds.size === 1 ? 'this archived invite' : `these ${selectedIds.size} archived invites`}?
          </p>
          <p className="text-muted-foreground">
            The invite's history and data, including its usage list and sign-up records, will be deleted forever. Users who joined through it keep their accounts.
          </p>
        </div>
      </ResponsiveDialog>

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
            <FontAwesomeIcon icon={faBan} className="size-4 text-muted-foreground" />
            Discord invitation settings are not available yet.
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
