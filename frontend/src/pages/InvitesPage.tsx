import { useState, useMemo, useEffect, type FormEvent } from 'react';
import { useAlerts } from '../contexts/AlertContext';
import { useInvites } from '../hooks/useInvites';
import { useAdminApi } from '../hooks/useAdminApi';
import { useInviteSummary } from '../hooks/useInviteSummary';
import { InvitesTable, InviteRow, InviteModal, InviteFormValues, InviteDetailDrawer } from '../components/invites';
import { requestJson } from '../util/apiClient';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '../components/ui/dropdown-menu';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { PageHeader } from '../components';
import { IconDots } from '@tabler/icons-react';
import type { InviteLibrary, InviteServer, InviteServerFeature } from '../components/invites/InvitesTable';
import { getServiceBadgeClass as getServiceBadgeMeta, getServiceIconClass } from '../config/pluginMetadata';

// Helper function to get service-specific styling
const getServiceBadgeClass = (serviceType: string): string => {
  const fallback = 'bg-gray-500/10 text-gray-400 border-gray-500/20';
  if (!serviceType) return fallback;
  return getServiceBadgeMeta(serviceType) || fallback;
};

const getServiceIcon = (serviceType: string): string => {
  return getServiceIconClass(serviceType) || 'fa-solid fa-server';
};

type FeatureKey = 'allow_downloads' | 'invite_to_plex_home' | 'allow_live_tv' | 'allow_4k_transcode';

type FeatureMeta = {
  key: FeatureKey;
  label: string;
  icon: string;
  className: string;
  onlyServices?: string[];
  hideIfUniformTrue?: boolean;
};

const FEATURE_META: FeatureMeta[] = [
  {
    key: 'allow_downloads',
    label: 'Downloads',
    icon: 'fa-solid fa-download',
    className: 'bg-blue-500/10 text-blue-500 border-blue-500/20'
  },
  {
    key: 'invite_to_plex_home',
    label: 'Plex Home',
    icon: 'fa-solid fa-home',
    className: 'bg-[#e5a00d]/10 text-[#e5a00d] border-[#e5a00d]/20',
    onlyServices: ['plex']
  },
  {
    key: 'allow_live_tv',
    label: 'Live TV',
    icon: 'fa-solid fa-tv',
    className: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
    onlyServices: ['plex']
  },
  {
    key: 'allow_4k_transcode',
    label: '4K Transcode',
    icon: 'fa-solid fa-film',
    className: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    onlyServices: ['plex'],
    hideIfUniformTrue: true
  }
];

const resolveServerFeatures = (invite: InviteRow): InviteServerFeature[] => {
  const fromApi = invite.server_features ?? [];
  const map = new Map<number, typeof fromApi[number]>();
  fromApi.forEach((sf) => map.set(sf.server_id, sf));

  return (invite.servers ?? []).map((server) => {
    const existing = map.get(server.id);
    return {
      server_id: server.id,
      allow_downloads: existing?.allow_downloads ?? invite.allow_downloads ?? false,
      invite_to_plex_home: existing?.invite_to_plex_home ?? invite.invite_to_plex_home ?? false,
      allow_live_tv: existing?.allow_live_tv ?? invite.allow_live_tv ?? false,
      allow_4k_transcode: existing?.allow_4k_transcode ?? invite.allow_4k_transcode ?? true,
      server_nickname: existing?.server_nickname ?? server.server_nickname ?? server.name ?? null,
      service_type: existing?.service_type ?? server.service_type,
      is_override: existing?.is_override ?? false
    };
  });
};

const buildFeatureSummaries = (invite: InviteRow) => {
  const perServer = resolveServerFeatures(invite);

  return FEATURE_META.map((meta) => {
    const relevant = meta.onlyServices
      ? perServer.filter((sf) => meta.onlyServices?.includes((sf.service_type || '').toLowerCase()))
      : perServer;
    if (relevant.length === 0) return null;

    const enabled = relevant.filter((sf) => Boolean((sf as any)[meta.key]));
    const disabled = relevant.filter((sf) => !Boolean((sf as any)[meta.key]));

    if (enabled.length === 0) return null;
    const allEnabled = enabled.length === relevant.length;
    if (meta.hideIfUniformTrue && allEnabled) return null;

    return {
      meta,
      enabled,
      disabled,
      state: allEnabled ? 'all' : 'partial' as const
    };
  }).filter(Boolean) as Array<{
    meta: FeatureMeta;
    enabled: InviteServerFeature[];
    disabled: InviteServerFeature[];
    state: 'all' | 'partial';
  }>;
};

const getInviteStatusMeta = (invite: InviteRow) => {
  const isExpired = invite.expires_at ? new Date(invite.expires_at).getTime() < Date.now() : false;
  const uses = invite.uses_count ?? invite.current_uses ?? 0;
  const maxUses = invite.max_uses ?? null;
  const isMaxed = typeof maxUses === 'number' && maxUses > 0 ? uses >= maxUses : false;

  if (isExpired) {
    return { label: 'Expired', className: 'bg-destructive/10 text-destructive border-destructive/20' };
  }
  if (isMaxed) {
    return { label: 'Maxed', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' };
  }
  if (invite.is_active === false) {
    return { label: 'Inactive', className: 'bg-muted text-muted-foreground border-border' };
  }
  return { label: 'Active', className: 'bg-green-500/10 text-green-600 border-green-500/20' };
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
  const { data: serversData } = useAdminApi<{ data: { id: number; server_nickname: string }[] }>('/servers', true);
  const { summary } = useInviteSummary();
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
    setEditingInvite(null);
    setEditingInitialValues(undefined);
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

  const headerActions = (
    <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
      <Button onClick={openCreateModal} className="w-full sm:w-auto">
        <i className="fa-solid fa-plus mr-2" /> Create Invite
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" type="button" title="More options">
            <IconDots className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent className="w-56 rounded-lg" align="end" side="bottom" sideOffset={8}>
            <DropdownMenuLabel>View Mode</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={() => setViewMode('table')}
              className={viewMode === 'table' ? 'bg-primary/10' : ''}
            >
              <i className="fa-solid fa-list fa-fw mr-2" />
              <span className="flex-1">Table View</span>
              {viewMode === 'table' && <i className="fa-solid fa-check fa-fw ml-2 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setViewMode('cards')}
              className={viewMode === 'cards' ? 'bg-primary/10' : ''}
            >
              <i className="fa-solid fa-th-large fa-fw mr-2" />
              <span className="flex-1">Card View</span>
              {viewMode === 'cards' && <i className="fa-solid fa-check fa-fw ml-2 text-primary" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>
              <i className="fa-solid fa-gear fa-fw mr-2" />
              <span className="flex-1 text-muted-foreground">More options coming soon</span>
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
      <form method="GET" className="mb-6 p-4 rounded-lg border shadow-sm" onSubmit={handleSearchSubmit}>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 items-end">
          <div className="space-y-2">
            <label className="text-sm font-medium">Filter by Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
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
          <div className="space-y-2">
            <label className="text-sm font-medium">Search by Path</label>
            <Input
              type="text"
              name="search_path"
              placeholder="Custom path part"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Server</label>
            <Select value={serverFilter} onValueChange={setServerFilter}>
              <SelectTrigger>
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
          <div className="space-y-2">
            <label className="text-sm font-medium invisible">Apply</label>
            <Button type="submit" className="w-full">
              <i className="fa-solid fa-filter mr-2" /> Apply
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
              <i className="fa-solid fa-trash mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Delete ({selectedIds.size} selected)</span>
              <span className="inline-block sm:hidden">({selectedIds.size})</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleBulkAction('disable')}
            >
              <i className="fa-solid fa-ban mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Disable Selected</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleBulkAction('enable')}
            >
              <i className="fa-solid fa-check mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Enable Selected</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSelectAll(true)}
              title="Select all invites currently visible"
            >
              <i className="fa-solid fa-check-square mr-0 sm:mr-2" />
              <span className="hidden sm:inline-block">Select All</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleSelectAll(false)}
              title="Deselect All"
            >
              <i className="fa-solid fa-square mr-0 sm:mr-2" />
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
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
              <p>Loading invites...</p>
            </div>
          ) : invites.length === 0 ? (
            <div className="col-span-full text-center py-10 rounded-lg border shadow-sm">
              <i className="fa-solid fa-ticket-slash fa-3x text-muted-foreground mb-4" />
              <p className="text-xl text-muted-foreground">No invites found matching your criteria.</p>
            </div>
          ) : (
            invites.map((invite) => {
              const featureSummaries = buildFeatureSummaries(invite);
              const hasMembershipDuration = Boolean(invite.membership_duration_days);

              return (
                <Card
                  key={invite.id}
                  className={`relative overflow-hidden border transition-all duration-200 ease-in-out group cursor-pointer ${
                    selectedIds.has(invite.id) ? 'ring-2 ring-primary shadow-xl translate-y-[-2px]' : 'hover:shadow-lg'
                  }`}
                  onClick={() => toggleSelect(invite.id)}
                >
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-background via-background to-primary/5 opacity-80" />
                  {/* Selection Checkbox */}
                  <div className={`absolute top-2 right-2 z-10 transition-opacity duration-200 ${selectedIds.has(invite.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    <Checkbox
                      checked={selectedIds.has(invite.id)}
                      onCheckedChange={() => toggleSelect(invite.id)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>

                  <CardContent className="relative z-10 flex h-full flex-col space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            className="font-semibold text-primary text-left hover:underline underline-offset-4 p-0"
                            title="Click to copy invite link"
                            onClick={(e) => {
                              e.stopPropagation();
                              const invitePath = invite.custom_path || invite.token;
                              const fullUrl = `${window.location.origin}/invite/${invitePath}`;
                              navigator.clipboard.writeText(fullUrl);
                              success('Invite link copied!');
                            }}
                          >
                            {invite.custom_path || invite.token.substring(0, 12)}
                          </button>
                          <a
                            href={`/invite/${invite.custom_path || invite.token}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-muted-foreground hover:text-foreground p-1"
                            title="Open link in new tab"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <i className="fa-solid fa-external-link-alt fa-xs" />
                          </a>
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          <span>
                            <i className="fa-solid fa-calendar-plus fa-fw mr-1" />
                            {invite.created_at ? new Date(invite.created_at).toLocaleDateString() : 'Created: N/A'}
                          </span>
                          <span className={invite.status === 'expired' ? 'text-destructive' : ''}>
                            <i className="fa-solid fa-clock fa-fw mr-1" />
                            {invite.expires_at ? new Date(invite.expires_at).toLocaleDateString() : 'Never expires'}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2 text-right">
                        {(() => {
                          const meta = getInviteStatusMeta(invite);
                          return (
                            <span
                              className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium ${meta.className}`}
                            >
                              <i className="fa-solid fa-circle-dot fa-xs" />
                              {meta.label}
                            </span>
                          );
                        })()}
                        <div className="flex items-center gap-2 text-xs text-muted-foreground font-semibold bg-muted/40 border border-border px-2 py-1 rounded-full">
                          <i className="fa-solid fa-users-line fa-fw" />
                          <span>{invite.uses_count ?? invite.current_uses ?? 0} / {invite.max_uses ?? '\u221e'} uses</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 text-sm flex-1">
                      {/* Server Access */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <i className="fa-solid fa-server fa-fw" /> Server Access
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {invite.servers?.length ? (
                            invite.servers.map((server) => (
                              <span
                                key={server.id}
                                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${getServiceBadgeClass(server.service_type)}`}
                              >
                                <i className={`${getServiceIcon(server.service_type)} w-3 h-3`} />
                                {server.server_nickname || server.name || 'Unnamed server'}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">No servers</span>
                          )}
                        </div>
                      </div>

                      {/* Library Access */}
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          <i className="fa-solid fa-photo-film fa-fw" /> Library Access
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {invite.grants_all_libraries ? (
                            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-green-500/10 text-green-500 border-green-500/20">
                              <i className="fa-solid fa-infinity w-3 h-3" />
                              All Libraries
                            </span>
                          ) : invite.libraries?.length ? (
                            invite.libraries.map((library) => (
                              <span
                                key={library.id}
                                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${getServiceBadgeClass(library.service_type)}`}
                                title={`${library.name} (${library.server_name})`}
                              >
                                <i className={`${getServiceIcon(library.service_type)} w-3 h-3`} />
                                {library.name}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-muted text-muted-foreground border-border">
                              <i className="fa-solid fa-question w-3 h-3" />
                              No Libraries
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Features */}
                      {(featureSummaries.length > 0 || hasMembershipDuration) && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <i className="fa-solid fa-star fa-fw" /> Features
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {featureSummaries.map(({ meta, state }) => (
                              <span
                                key={meta.key}
                                className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${meta.className}`}
                              >
                                <i className={`${meta.icon} w-3 h-3`} />
                                {meta.label}
                                {state === 'partial' && (
                                  <span className="text-[10px] uppercase tracking-wide font-bold text-muted-foreground/80">
                                    (Partial)
                                  </span>
                                )}
                              </span>
                            ))}
                            {hasMembershipDuration && (
                              <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-orange-500/10 text-orange-500 border-orange-500/20">
                                <i className="fa-solid fa-clock w-3 h-3" />
                                {invite.membership_duration_days} days
                              </span>
                            )}
                          </div>
                          {featureSummaries.some((f) => f.state === 'partial') && (
                            <div className="text-xs text-muted-foreground space-y-1">
                              {featureSummaries
                                .filter((f) => f.state === 'partial')
                                .map((f) => {
                                  const enabledNames = f.enabled.map((s) => s?.server_nickname || 'Server').join(', ');
                                  const disabledNames = f.disabled.map((s) => s?.server_nickname || 'Server').join(', ');
                                  return (
                                    <div key={f.meta.key} className="flex flex-wrap gap-2">
                                      <span className="font-semibold">{f.meta.label}:</span>
                                      <span>On: {enabledNames || 'None'}</span>
                                      {disabledNames ? <span className="text-muted-foreground/80">Off: {disabledNames}</span> : null}
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Discord Requirements */}
                      {(invite.require_discord_auth || invite.require_discord_guild_membership) && (
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            <i className="fa-brands fa-discord fa-fw" /> Discord
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {invite.require_discord_auth && (
                              <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-[#5865F2]/10 text-[#5865F2] border-[#5865F2]/20">
                                <i className="fa-solid fa-link w-3 h-3" />
                                Auth Required
                              </span>
                            )}
                            {invite.require_discord_guild_membership && (
                              <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-[#5865F2]/10 text-[#5865F2] border-[#5865F2]/20">
                                <i className="fa-solid fa-users w-3 h-3" />
                                Guild Required
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end gap-2 pt-3 border-t" onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="View Usages"
                        onClick={(e) => {
                          e.stopPropagation();
                          openDetailDrawer(invite);
                        }}
                      >
                        <i className="fa-solid fa-chart-line" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title="Edit Invite"
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditModal(invite);
                        }}
                      >
                        <i className="fa-solid fa-pen-to-square" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
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
        onSubmit={handleSaveInvite}
        loading={saving}
      />

      <InviteDetailDrawer inviteId={detailInviteId} onClose={() => setDetailInviteId(null)} />
    </div>
  );
};

export default InvitesPage;
