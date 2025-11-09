import { useState, useMemo, useEffect, type FormEvent } from 'react';
import { useAlerts } from '../contexts/AlertContext';
import { useInvites } from '../hooks/useInvites';
import { useAdminApi } from '../hooks/useAdminApi';
import { useInviteSummary } from '../hooks/useInviteSummary';
import { InvitesTable, InviteRow, InviteServer, InviteModal, InviteFormValues, InviteDetailDrawer } from '../components/invites';
import { requestJson } from '../util/apiClient';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Input } from '../components/ui/input';
import { Checkbox } from '../components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';

// Helper function to get service-specific styling
const getServiceBadgeClass = (serviceType: string): string => {
  const type = serviceType.toLowerCase();
  switch (type) {
    case 'plex':
      return 'bg-[#e5a00d]/10 text-[#e5a00d] border-[#e5a00d]/20';
    case 'jellyfin':
      return 'bg-[#00a4dc]/10 text-[#00a4dc] border-[#00a4dc]/20';
    case 'emby':
      return 'bg-[#52b54b]/10 text-[#52b54b] border-[#52b54b]/20';
    case 'audiobookshelf':
      return 'bg-[#f59e0b]/10 text-[#f59e0b] border-[#f59e0b]/20';
    case 'kavita':
      return 'bg-[#7c3aed]/10 text-[#7c3aed] border-[#7c3aed]/20';
    case 'komga':
      return 'bg-[#4169e1]/10 text-[#4169e1] border-[#4169e1]/20';
    case 'romm':
      return 'bg-[#ef4444]/10 text-[#ef4444] border-[#ef4444]/20';
    default:
      return 'bg-gray-500/10 text-gray-400 border-gray-500/20';
  }
};

const getServiceIcon = (serviceType: string): string => {
  const type = serviceType.toLowerCase();
  switch (type) {
    case 'plex':
      return 'fa-solid fa-play';
    case 'jellyfin':
      return 'fa-solid fa-cube';
    case 'emby':
      return 'fa-solid fa-play-circle';
    case 'audiobookshelf':
      return 'fa-solid fa-headphones';
    case 'kavita':
      return 'fa-solid fa-book';
    case 'komga':
      return 'fa-solid fa-book-open';
    case 'romm':
      return 'fa-solid fa-gamepad';
    default:
      return 'fa-solid fa-server';
  }
};

export const InvitesPage = () => {
  const { success, error: showError } = useAlerts();
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [serverFilter, setServerFilter] = useState<string>('all');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [editingInvite, setEditingInvite] = useState<InviteRow | null>(null);
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
    setModalOpen(true);
  };

  const openEditModal = (invite: InviteRow) => {
    setEditingInvite(invite);
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

  return (
    <div className="container mx-auto px-4 py-2 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">
          Manage Invites ({pagination?.total_items ?? 0})
        </h1>
        <div className="flex gap-2 mt-4 sm:mt-0">
          <Button onClick={openCreateModal}>
            <i className="fa-solid fa-plus mr-2" /> Create Invite
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" title="Change view">
                <i className="fa-solid fa-display mr-1" /> View <i className="fa-solid fa-chevron-down fa-xs ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className={viewMode === 'cards' ? 'font-bold' : ''}
                onClick={() => setViewMode('cards')}
              >
                <i className="fa-solid fa-grip-vertical fa-fw mr-2" /> Card View
              </DropdownMenuItem>
              <DropdownMenuItem
                className={viewMode === 'table' ? 'font-bold' : ''}
                onClick={() => setViewMode('table')}
              >
                <i className="fa-solid fa-table-list fa-fw mr-2" /> Table View
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

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
            invites.map((invite) => (
              <Card
                key={invite.id}
                className={`shadow-lg hover:shadow-xl transition-shadow duration-200 ease-in-out relative group cursor-pointer ${
                  selectedIds.has(invite.id) ? 'ring-2 ring-primary' : ''
                }`}
                onClick={() => toggleSelect(invite.id)}
              >
                {/* Selection Checkbox */}
                <div className={`absolute top-2 right-2 z-10 transition-opacity duration-200 ${selectedIds.has(invite.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                  <Checkbox
                    checked={selectedIds.has(invite.id)}
                    onCheckedChange={() => toggleSelect(invite.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>

                <div className="p-4">
                  <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
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
                    {invite.custom_path && (
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        <i className="fa-solid fa-link w-3 h-3" />
                        Custom Path
                      </span>
                    )}
                  </div>

                  <div className="text-xs space-y-2 mb-3">
                    <p>
                      <i className="fa-solid fa-calendar-plus fa-fw mr-1 text-info" /> Created:{' '}
                      {invite.created_at ? new Date(invite.created_at).toLocaleDateString() : 'N/A'}
                    </p>
                    <p>
                      <i className={`fa-solid fa-clock fa-fw mr-1 ${invite.status === 'expired' ? 'text-error' : 'text-success'}`} />{' '}
                      Expires: {invite.expires_at ? new Date(invite.expires_at).toLocaleDateString() : 'Never'}
                    </p>
                    <p>
                      <i className="fa-solid fa-users-line fa-fw mr-1 text-info" /> Uses: {invite.uses_count || invite.current_uses} /{' '}
                      {invite.max_uses || '∞'}
                    </p>

                    {/* Server Access Badges */}
                    {invite.servers && invite.servers.length > 0 && (
                      <div>
                        <label className="text-xs font-medium text-base-content/70 block mb-1">
                          <i className="fa-solid fa-server fa-fw mr-1" /> Server Access:
                        </label>
                        <div className="flex flex-wrap gap-1">
                          {invite.servers.map((server) => (
                            <span
                              key={server.id}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border ${getServiceBadgeClass(server.service_type)}`}
                            >
                              <i className={`${getServiceIcon(server.service_type)} w-3 h-3`} />
                              {server.name}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Discord Requirements */}
                    {(invite.require_discord_auth || invite.require_discord_guild_membership) && (
                      <div>
                        <label className="text-xs font-medium text-base-content/70 block mb-1">
                          <i className="fa-brands fa-discord fa-fw mr-1" /> Discord:
                        </label>
                        <div className="flex flex-wrap gap-1">
                          {invite.require_discord_auth && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[#5865F2]/10 text-[#5865F2] border border-[#5865F2]/20">
                              <i className="fa-solid fa-link w-3 h-3" />
                              Auth Required
                            </span>
                          )}
                          {invite.require_discord_guild_membership && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[#5865F2]/10 text-[#5865F2] border border-[#5865F2]/20">
                              <i className="fa-solid fa-users w-3 h-3" />
                              Guild Required
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Library Access */}
                    <div>
                      <label className="text-xs font-medium text-base-content/70 block mb-1">
                        <i className="fa-solid fa-photo-film fa-fw mr-1" /> Library Access:
                      </label>
                      <div className="flex flex-wrap gap-1">
                        {invite.grants_all_libraries ? (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-green-500/10 text-green-400 border border-green-500/20">
                            <i className="fa-solid fa-infinity w-3 h-3" />
                            All Libraries
                          </span>
                        ) : invite.libraries && invite.libraries.length > 0 ? (
                          invite.libraries.map((library) => (
                            <span
                              key={library.id}
                              className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border ${getServiceBadgeClass(library.service_type)}`}
                              title={`${library.name} (${library.server_name})`}
                            >
                              <i className={`${getServiceIcon(library.service_type)} w-3 h-3`} />
                              {library.name}
                            </span>
                          ))
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-gray-500/10 text-gray-400 border border-gray-500/20">
                            <i className="fa-solid fa-question w-3 h-3" />
                            No Libraries
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Additional Features */}
                    {(invite.allow_downloads || invite.invite_to_plex_home || invite.allow_live_tv || invite.membership_duration_days) && (
                      <div>
                        <label className="text-xs font-medium text-base-content/70 block mb-1">
                          <i className="fa-solid fa-star fa-fw mr-1" /> Features:
                        </label>
                        <div className="flex flex-wrap gap-1">
                          {invite.allow_downloads && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20">
                              <i className="fa-solid fa-download w-3 h-3" />
                              Downloads
                            </span>
                          )}
                          {invite.invite_to_plex_home && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-[#e5a00d]/10 text-[#e5a00d] border border-[#e5a00d]/20">
                              <i className="fa-solid fa-home w-3 h-3" />
                              Plex Home
                            </span>
                          )}
                          {invite.allow_live_tv && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20">
                              <i className="fa-solid fa-tv w-3 h-3" />
                              Live TV
                            </span>
                          )}
                          {invite.membership_duration_days && (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-orange-500/10 text-orange-400 border border-orange-500/20">
                              <i className="fa-solid fa-clock w-3 h-3" />
                              {invite.membership_duration_days} days
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-end gap-2 mt-auto pt-3 border-t" onClick={(e) => e.stopPropagation()}>
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
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {pagination ? (
        <div className="flex items-center justify-between rounded-lg border px-4 py-3 text-sm">
          <div className="text-muted-foreground">
            Page {currentPage} of {totalPages} • {pagination.total_items} invite
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
        }}
        initialValues={editingInvite ?? undefined}
        onSubmit={handleSaveInvite}
        loading={saving}
      />

      <InviteDetailDrawer inviteId={detailInviteId} onClose={() => setDetailInviteId(null)} />
    </div>
  );
};

export default InvitesPage;
