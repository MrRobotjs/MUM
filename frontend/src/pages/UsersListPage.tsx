import { useEffect, useMemo, useState } from 'react';
import { UsersTable, UserCardsGrid, PurgeUsersModal, PageHeader } from '../components';
import { UserDisplaySettingsModal } from '../components/users/UserDisplaySettingsModal';
import { MassEditUsersModal } from '../components/users/MassEditUsersModal';
import { useUsersPaginated } from '../hooks/useUsersPaginated';
import { useServerOptions } from '../hooks/useServerOptions';
import { useSyncStatus } from '../hooks/useSyncStatus';
import { useAuth } from '../contexts/AuthContext';
import { useAlerts } from '../contexts/AlertContext';
import type { UserColumns } from '../components/users/UsersTable';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Badge } from '../components/ui/badge';
import { requestJson } from '../util/apiClient';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetClose,
} from '../components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuPortal,
} from '../components/ui/dropdown-menu';
import { Card, CardContent } from '../components/ui/card';
import { Progress } from '../components/ui/progress';
import { IconDots, IconRefresh } from '@tabler/icons-react';

export const UsersListPage = () => {
  const [view, setView] = useState<'table' | 'cards'>('cards');
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  const [showDisplaySettingsModal, setShowDisplaySettingsModal] = useState(false);
  const [showMassEditModal, setShowMassEditModal] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const { syncStatus } = useSyncStatus();
  const { hasPermission } = useAuth();
  const { success, error } = useAlerts();

  // Selection state
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [userType, setUserType] = useState('all');
  const [role, setRole] = useState('');
  const [serverId, setServerId] = useState('all');
  const [filterType, setFilterType] = useState('none');
  const [searchEmail, setSearchEmail] = useState('');
  const [searchUsername, setSearchUsername] = useState('');
  const [searchNotes, setSearchNotes] = useState('');
  const [sort, setSort] = useState('username_asc');

  const filters = useMemo(
    () => ({
      page,
      search,
      userType: userType === 'all' ? undefined : userType,
      role: role || undefined,
      serverId,
      filterType: filterType === 'none' ? undefined : filterType,
      searchEmail: searchEmail || undefined,
      searchUsername: searchUsername || undefined,
      searchNotes: searchNotes || undefined,
      sort
    }),
    [page, search, userType, role, serverId, filterType, searchEmail, searchUsername, searchNotes, sort]
  );

  const { users, loading, error: fetchError, pagination, mutate } = useUsersPaginated(filters);
  const { servers } = useServerOptions();
  const [columns, setColumns] = useState<UserColumns>({
    name: true,
    email: true,
    type: true,
    roles: true,
    linked: true,
    lastLogin: true
  });

  const toggleColumn = (key: keyof UserColumns) => {
    setColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  useEffect(() => {
    setPage(1);
    setSelectedUserIds(new Set());
  }, [search, userType, role, serverId, filterType, searchEmail, searchUsername, searchNotes, sort]);

  // Selection handlers
  const toggleUserSelection = (userId: string) => {
    setSelectedUserIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(userId)) {
        newSet.delete(userId);
      } else {
        newSet.add(userId);
      }
      return newSet;
    });
  };

  const selectAllUsers = () => {
    const allUserIds = users.map((u) => u.uuid);
    setSelectedUserIds(new Set(allUserIds));
  };

  const deselectAllUsers = () => {
    setSelectedUserIds(new Set());
  };

  const toggleSelectAll = () => {
    if (selectedUserIds.size === 0 || selectedUserIds.size < users.length) {
      selectAllUsers();
    } else {
      deselectAllUsers();
    }
  };

  const selectAllState: 'none' | 'some' | 'all' =
    selectedUserIds.size === 0
      ? 'none'
      : selectedUserIds.size === users.length
      ? 'all'
      : 'some';

  const handleSync = async () => {
    if (syncStatus.is_syncing) {
      return;
    }
    try {
      const result = await requestJson<{
        data: {
          results: Array<{
            server_id: number;
            server_name: string;
            service_type: string;
            success: boolean;
            added: number;
            updated: number;
            removed: number;
            message: string;
          }>;
          summary: {
            total_servers: number;
            successful: number;
            failed: number;
            total_added: number;
            total_updated: number;
            total_removed: number;
          };
        };
      }>('/admin/api/v2/users/sync-all', {
        method: 'POST'
      });

      const { summary, results } = result.data;

      // Show summary toast
      if (summary.failed === 0) {
        success(
          `Synced ${summary.total_servers} server${summary.total_servers !== 1 ? 's' : ''}: ` +
          `${summary.total_added} added, ${summary.total_updated} updated, ${summary.total_removed} removed`
        );
      } else {
        error(
          `Sync completed with errors: ${summary.successful}/${summary.total_servers} servers successful. ` +
          `${summary.total_added} added, ${summary.total_updated} updated, ${summary.total_removed} removed`
        );
      }

      // Log detailed results
      results.forEach((result) => {
        if (!result.success) {
          console.error(`Sync failed for ${result.server_name}: ${result.message}`);
        }
      });

      // Refresh the user list
      mutate();
    } catch (err) {
      error(`Failed to sync users: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  };

  const headerActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" type="button" title="More options">
          <IconDots className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="w-56 rounded-lg"
          align="end"
          side="bottom"
          sideOffset={8}
          collisionPadding={8}
        >
          <DropdownMenuItem
            disabled={syncStatus.is_syncing}
            onSelect={(event) => {
              if (syncStatus.is_syncing) {
                event.preventDefault();
                return;
              }
              handleSync();
            }}
          >
            <IconRefresh
              className={cn(
                'mr-2 h-4 w-4',
                syncStatus.is_syncing && 'animate-spin text-primary'
              )}
            />
            Sync All Users
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShowDisplaySettingsModal(true)}>
            <i className="fa-solid fa-cog fa-fw mr-2" />
            Display Settings
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>View Mode</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => setView('table')}
            className={view === 'table' ? 'bg-primary/10' : ''}
          >
            <i className="fa-solid fa-list fa-fw mr-2" />
            <span className="flex-1">Table View</span>
            {view === 'table' && <i className="fa-solid fa-check fa-fw ml-2 text-primary" />}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setView('cards')}
            className={view === 'cards' ? 'bg-primary/10' : ''}
          >
            <i className="fa-solid fa-th-large fa-fw mr-2" />
            <span className="flex-1">Card View</span>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">Default</Badge>
              {view === 'cards' && <i className="fa-solid fa-check fa-fw text-primary" />}
            </div>
          </DropdownMenuItem>

          {view === 'table' && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Table Columns</DropdownMenuLabel>
              {(
                [
                  { key: 'name', label: 'Name' },
                  { key: 'email', label: 'Email' },
                  { key: 'type', label: 'Type' },
                  { key: 'roles', label: 'Roles' },
                  { key: 'linked', label: 'Linked services' },
                  { key: 'lastLogin', label: 'Last login' }
                ] as Array<{ key: keyof UserColumns; label: string }>
              ).map(({ key, label }) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={columns[key]}
                  onCheckedChange={() => toggleColumn(key)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );

  return (
    <div className="container mx-auto px-4 py-2 space-y-6">
      <PageHeader
        title={`Managed Users (${pagination?.total_items || 0})`}
        description="View and manage all users across your media services"
        actions={headerActions}
      />

      {/* Sync Progress Bar */}
      {syncStatus.is_syncing && (
        <Card className="border-primary/50 bg-primary/5">
          <CardContent className="p-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
                  <span className="font-medium">
                    {syncStatus.progress.current_server_name
                      ? `Syncing ${syncStatus.progress.current_server_name}...`
                      : 'Syncing users from all servers...'}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {syncStatus.progress.current_server} / {syncStatus.progress.total_servers} servers
                </span>
              </div>
              <Progress
                value={syncStatus.progress.total_servers > 0
                  ? (syncStatus.progress.current_server / syncStatus.progress.total_servers) * 100
                  : 0
                }
                className="h-2"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {syncStatus.started_by_username && `Started by ${syncStatus.started_by_username}`}
                </p>
                <p className="text-xs text-muted-foreground">
                  This may take a few moments...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search Bar */}
      <Card className="mb-6">
        <CardContent className="flex gap-2 p-4">
          <Input
            type="text"
            placeholder="Search by username or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                mutate();
              }
            }}
            className="flex-1"
          />
          <Button onClick={() => mutate()}>
            <i className="fa-solid fa-search" />
          </Button>
          <Sheet open={showFilterDrawer} onOpenChange={setShowFilterDrawer}>
            <SheetTrigger asChild>
              <Button variant="secondary">
                <i className="fa-solid fa-filter mr-0 sm:mr-2" />
                <span className="hidden sm:inline">Sort & Filter</span>
              </Button>
            </SheetTrigger>
            <SheetContent className="w-[92vw] sm:max-w-md p-6">
              <SheetHeader>
                <SheetTitle>
                  <i className="fa-solid fa-filter mr-2" />
                  Sort & Filter Options
                </SheetTitle>
                <SheetDescription>
                  Configure filters and sorting options for the user list
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-6 overflow-y-auto pr-1">
                {/* Server Filter */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="serverId">
                    <i className="fa-solid fa-server mr-2" />
                    Server
                  </Label>
                  <Select value={serverId} onValueChange={setServerId}>
                    <SelectTrigger id="serverId">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Servers</SelectItem>
                      {servers.map((server) => (
                        <SelectItem key={server.id} value={String(server.id)}>
                          {server.server_nickname}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* User Type Filter */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="userType">
                    <i className="fa-solid fa-users mr-2" />
                    User Type
                  </Label>
                  <Select value={userType} onValueChange={setUserType}>
                    <SelectTrigger id="userType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Users</SelectItem>
                      <SelectItem value="owner">Owner</SelectItem>
                      <SelectItem value="local">Local</SelectItem>
                      <SelectItem value="service">Service</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Search Username */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="searchUsername">
                    <i className="fa-solid fa-user mr-2" />
                    Search Username
                  </Label>
                  <Input
                    id="searchUsername"
                    type="text"
                    placeholder="Search by username..."
                    value={searchUsername}
                    onChange={(e) => setSearchUsername(e.target.value)}
                  />
                </div>

                {/* Search Email */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="searchEmail">
                    <i className="fa-solid fa-envelope mr-2" />
                    Search Email
                  </Label>
                  <Input
                    id="searchEmail"
                    type="text"
                    placeholder="Search by email..."
                    value={searchEmail}
                    onChange={(e) => setSearchEmail(e.target.value)}
                  />
                </div>

                {/* Search Notes */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="searchNotes">
                    <i className="fa-solid fa-sticky-note mr-2" />
                    Search Notes
                  </Label>
                  <Input
                    id="searchNotes"
                    type="text"
                    placeholder="Search by notes..."
                    value={searchNotes}
                    onChange={(e) => setSearchNotes(e.target.value)}
                  />
                </div>

                {/* Filter Type */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="filterType">
                    <i className="fa-solid fa-filter mr-2" />
                    Filter by
                  </Label>
                  <Select value={filterType} onValueChange={setFilterType}>
                    <SelectTrigger id="filterType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">All Users</SelectItem>
                      <SelectItem value="home_user">Home Users</SelectItem>
                      <SelectItem value="shares_back">Shares Back</SelectItem>
                      <SelectItem value="has_discord">Discord Linked</SelectItem>
                      <SelectItem value="no_discord">No Discord Linked</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Role Filter */}
                <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
                  <Label htmlFor="role">
                    <i className="fa-solid fa-user-tag mr-2" />
                    Filter by Role
                  </Label>
                  <Input
                    id="role"
                    type="text"
                    placeholder="Role name"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  />
                </div>

                {/* Sort Options */}
                <div className="space-y-2">
                  <Label htmlFor="sort">
                    <i className="fa-solid fa-sort mr-2" />
                    Sort by
                  </Label>
                  <Select value={sort} onValueChange={setSort}>
                    <SelectTrigger id="sort">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="username_asc">Username (A-Z)</SelectItem>
                      <SelectItem value="username_desc">Username (Z-A)</SelectItem>
                      <SelectItem value="created_desc">Date Added (Newest)</SelectItem>
                      <SelectItem value="created_asc">Date Added (Oldest)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-2 pt-4">
                  <Button
                    variant="ghost"
                    className="flex-1"
                    onClick={() => {
                      setSearch('');
                      setSearchEmail('');
                      setSearchUsername('');
                      setSearchNotes('');
                      setUserType('all');
                      setRole('');
                      setServerId('all');
                      setFilterType('none');
                      setSort('username_asc');
                    }}
                  >
                    Clear All
                  </Button>
                  <SheetClose asChild>
                    <Button className="flex-1" onClick={() => mutate()}>
                      Apply Filters
                    </Button>
                  </SheetClose>
                </div>
              </div>
            </SheetContent>
          </Sheet>
          {hasPermission('purge_users') && (
            <Button
              onClick={() => setShowPurgeModal(true)}
              variant="default"
              className="bg-warning hover:bg-warning/90 text-warning-foreground"
            >
              <i className="fa-solid fa-user-clock mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Purge</span>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Mass Edit Bar - Shows below search, not fixed at bottom */}
      {selectedUserIds.size > 0 && (
        <Card className="mb-4">
          <CardContent className="flex items-center gap-2 p-4">
            <Button variant="default" onClick={() => setShowMassEditModal(true)}>
              <i className="fa-solid fa-pen-to-square mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Mass Edit ({selectedUserIds.size} selected)</span>
              <span className="inline sm:hidden">({selectedUserIds.size})</span>
            </Button>
            <Button variant="destructive" onClick={() => {
              if (confirm(`Are you sure you want to delete ${selectedUserIds.size} user(s)? This action cannot be undone.`)) {
                console.log('Delete users:', Array.from(selectedUserIds));
              }
            }}>
              <i className="fa-solid fa-trash mr-0 sm:mr-2" />
              <span className="hidden sm:inline">Delete Selected</span>
            </Button>
            <Button variant="secondary" onClick={toggleSelectAll}>
              <i className={`fa-solid ${
                selectAllState === 'none'
                  ? 'fa-square'
                  : selectAllState === 'all'
                  ? 'fa-square-check'
                  : 'fa-square-minus'
              } mr-0 sm:mr-2`} />
              <span className="hidden sm:inline">
                {selectAllState === 'all' ? 'Deselect All' : 'Select All'}
              </span>
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Users Display */}
      {fetchError ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load users: {(fetchError as Error).message}
        </div>
      ) : view === 'table' ? (
        <UsersTable
          users={users}
          loading={loading}
          columns={columns}
          currentPage={pagination?.page || 1}
          totalPages={pagination?.total_pages || 1}
          onPageChange={setPage}
          selectedUserIds={selectedUserIds}
          onToggleSelection={toggleUserSelection}
          onToggleSelectAll={toggleSelectAll}
          selectAllState={selectAllState}
        />
      ) : (
        <UserCardsGrid
          users={users}
          loading={loading}
          selectedUserIds={selectedUserIds}
          onToggleSelection={toggleUserSelection}
          currentPage={pagination?.page || 1}
          totalPages={pagination?.total_pages || 1}
          onPageChange={setPage}
        />
      )}

      {showPurgeModal && (
        <PurgeUsersModal
          onClose={() => setShowPurgeModal(false)}
          onPurgeComplete={() => {
            mutate();
          }}
        />
      )}

      <UserDisplaySettingsModal
        isOpen={showDisplaySettingsModal}
        onClose={() => setShowDisplaySettingsModal(false)}
      />

      <MassEditUsersModal
        isOpen={showMassEditModal}
        onClose={() => setShowMassEditModal(false)}
        selectedUserIds={selectedUserIds}
        onComplete={() => {
          mutate();
          setSelectedUserIds(new Set());
        }}
      />
    </div>
  );
};

export default UsersListPage;
