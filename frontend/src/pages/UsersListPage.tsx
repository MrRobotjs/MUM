import { useEffect, useMemo, useState } from 'react';
import { UsersTable, SyncUsersButton, ViewToggle, UserCardsGrid, PurgeUsersModal } from '../components';
import { UserDisplaySettingsModal } from '../components/users/UserDisplaySettingsModal';
import { MassEditUsersModal } from '../components/users/MassEditUsersModal';
import { useUsersPaginated } from '../hooks/useUsersPaginated';
import { useServerOptions } from '../hooks/useServerOptions';
import { useAuth } from '../contexts/AuthContext';
import type { UserColumns } from '../components/users/UsersTable';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
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
} from '../components/ui/dropdown-menu';
import { Card, CardContent } from '../components/ui/card';

export const UsersListPage = () => {
  const [view, setView] = useState<'table' | 'cards'>('cards');
  const [showPurgeModal, setShowPurgeModal] = useState(false);
  const [showDisplaySettingsModal, setShowDisplaySettingsModal] = useState(false);
  const [showMassEditModal, setShowMassEditModal] = useState(false);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);
  const { hasPermission } = useAuth();

  // Selection state
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [userType, setUserType] = useState('all');
  const [role, setRole] = useState('');
  const [serverId, setServerId] = useState('all');
  const [filterType, setFilterType] = useState('');
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
      filterType: filterType || undefined,
      searchEmail: searchEmail || undefined,
      searchUsername: searchUsername || undefined,
      searchNotes: searchNotes || undefined,
      sort
    }),
    [page, search, userType, role, serverId, filterType, searchEmail, searchUsername, searchNotes, sort]
  );

  const { users, loading, error, pagination, mutate } = useUsersPaginated(filters);
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

  return (
    <div className="container mx-auto px-4 py-2">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">Managed Users ({pagination?.total_items || 0})</h1>
        <div className="flex items-center gap-2 mt-4 sm:mt-0">
          <SyncUsersButton />

          <Button
            onClick={() => setShowDisplaySettingsModal(true)}
            variant="ghost"
            size="sm"
            title="User Display Settings"
          >
            <i className="fa-solid fa-cog" />
          </Button>

          {view === 'table' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <i className="fa-solid fa-table-columns mr-2" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
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
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <ViewToggle view={view} onChange={setView} />
        </div>
      </div>

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
            <SheetContent>
              <SheetHeader>
                <SheetTitle>
                  <i className="fa-solid fa-filter mr-2" />
                  Sort & Filter Options
                </SheetTitle>
                <SheetDescription>
                  Configure filters and sorting options for the user list
                </SheetDescription>
              </SheetHeader>

              <div className="space-y-4 mt-6">
                {/* Server Filter */}
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2">
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
                <div className="space-y-2">
                  <Label htmlFor="filterType">
                    <i className="fa-solid fa-filter mr-2" />
                    Filter by
                  </Label>
                  <Select value={filterType} onValueChange={setFilterType}>
                    <SelectTrigger id="filterType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">All Users</SelectItem>
                      <SelectItem value="home_user">Home Users</SelectItem>
                      <SelectItem value="shares_back">Shares Back</SelectItem>
                      <SelectItem value="has_discord">Discord Linked</SelectItem>
                      <SelectItem value="no_discord">No Discord Linked</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Role Filter */}
                <div className="space-y-2">
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
                      setFilterType('');
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
      {error ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load users: {(error as Error).message}
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
