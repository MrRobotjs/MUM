import { historyServiceName, type HistoryService } from '../../lib/playHistory';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useMemo, useState, type ReactNode } from 'react';
import type { ColumnVisibilityState, RowSelectionState } from '@tanstack/react-table';
import { createAppColumnHelper, useAppTable } from '../table/DataTable';
import { Pagination } from '../common/Pagination';
import { useNavigate } from '@tanstack/react-router';
import { buildUserProfilePath } from '../../router/appLinks';
import { Checkbox } from '../ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Skeleton } from '../ui/skeleton';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { UserDebugModal } from './UserDebugModal';
import { Badge, RoleBadge } from '../common/Badge';
import { UserAvatar } from './UserAvatar';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faLayerGroup,
  faFolderOpen,
  faFolder,
  faCircleInfo,
  faUser,
} from '@fortawesome/free-solid-svg-icons';

export type UserRow = {
  uuid: string;
  username?: string;
  email?: string;
  external_email?: string;
  user_type: string;
  display_name?: string;
  avatar_url?: string | null;
  created_at?: string;
  last_login_at?: string;
  last_streamed_at?: string | null;
  last_streamed_source?: 'mum' | HistoryService | null;
  service_join_date?: string | null;
  is_active: boolean;
  admin_roles: string[];
  admin_roles_detail?: Array<{
    name: string;
    color?: string | null;
    icon?: string | null;
    badge_style?: string | null;
    description?: string | null;
  }>;
  user_roles: Array<{
    name: string;
    color?: string | null;
    icon?: string | null;
    badge_style?: string | null;
  }>;
  linked_service_count: number;
  server_id?: number | null;
  server_nickname?: string;
  service_type?: string;
  libraries?: string[];
  has_all_libraries?: boolean;
  library_policy_known: boolean;
  access_expires_at?: string | null;
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
  } | null;
  /** When the MUM account (a server account's owner) last signed in. */
  mum_last_login_at?: string | null;
  /** The owner's other server accounts. */
  linked_accounts?: Array<{
    uuid: string;
    service_type: string;
    server_nickname: string;
    username: string;
  }>;
  notes?: string | null;
  last_known_ip?: string | null;
  last_platform?: string | null;
  last_player?: string | null;
  total_plays?: number;
  total_duration?: number;
  last_played?: {
    media_title?: string | null;
    started_at?: string | null;
    rating_key?: string | null;
    server_id?: number | null;
  } | null;
};

export type UserColumns = {
  name: boolean;
  email: boolean;
  serviceJoinDate: boolean;
  lastKnownIp: boolean;
  totalPlays: boolean;
  totalDuration: boolean;
  type: boolean;
  roles: boolean;
  libraries: boolean;
  lastStreamed: boolean;
  mumAddedDate: boolean;
  lastPlayed: boolean;
  lastPlatform: boolean;
  lastPlayer: boolean;
  linked: boolean;
  lastLogin: boolean;
  actions: boolean;
};

export type SelectionModifiers = {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  source?: 'row' | 'card' | 'checkbox';
};

// The table's columns in order; the profile picture and name both follow the
// "name" choice, and the checkbox column appears when rows can be selected.
type UserColumnId = 'select' | 'avatar' | keyof UserColumns;
const columnChoice: Record<Exclude<UserColumnId, 'select'>, keyof UserColumns> = {
  avatar: 'name', name: 'name', email: 'email', serviceJoinDate: 'serviceJoinDate', lastKnownIp: 'lastKnownIp', totalPlays: 'totalPlays', totalDuration: 'totalDuration',
  type: 'type', roles: 'roles', libraries: 'libraries', lastStreamed: 'lastStreamed', mumAddedDate: 'mumAddedDate', lastPlayed: 'lastPlayed', lastPlatform: 'lastPlatform',
  lastPlayer: 'lastPlayer', linked: 'linked', lastLogin: 'lastLogin', actions: 'actions',
};
const columnHelper = createAppColumnHelper<UserRow>();

type UsersTableProps = {
  users: UserRow[];
  loading?: boolean;
  columns: UserColumns;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  selectedUserIds?: Set<string>;
  onToggleSelection?: (userId: string, modifiers?: SelectionModifiers) => void;
  onToggleSelectAll?: () => void;
  selectAllState?: 'none' | 'some' | 'all';
};

export const UsersTable = ({
  users,
  loading,
  columns,
  currentPage = 1,
  totalPages = 1,
  onPageChange,
  selectedUserIds = new Set(),
  onToggleSelection,
  onToggleSelectAll,
  selectAllState = 'none'
}: UsersTableProps) => {
  const { formatTimestamp } = useAccountDisplay();
  const navigate = useNavigate();
  const [debugUserUuid, setDebugUserUuid] = useState<string | null>(null);
  const [expandedLibraryUsers, setExpandedLibraryUsers] = useState<Set<string>>(new Set());
  const getAdminRoleBadges = (user: UserRow) => {
    if (user.admin_roles_detail && user.admin_roles_detail.length > 0) {
      return user.admin_roles_detail;
    }
    return user.admin_roles.map((role): { name: string; color?: string | null; icon?: string | null; badge_style?: string | null; description?: string | null } => ({ name: role }));
  };

  const toggleLibraryExpansion = (userId: string) => {
    setExpandedLibraryUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  const handleRowClick = (e: React.MouseEvent, user: UserRow) => {
    // Don't navigate if clicking checkbox
    const target = e.target as HTMLElement;
    if (target.closest('input[type="checkbox"]')) {
      return;
    }

    // If selection is enabled, toggle on row click
    if (onToggleSelection) {
      onToggleSelection(user.uuid, {
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        source: 'row',
      });
    } else {
      navigate({ to: buildUserProfilePath(user), state: { userUuid: user.uuid } });
    }
  };

  const formatDuration = (seconds?: number | null) => {
    if (seconds == null) {
      return '-';
    }
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  };

  const formatDate = (value?: string | null) =>
    formatTimestamp(value, 'date', '-');

  const formatDateTime = (value?: string | null) =>
    formatTimestamp(value, 'datetime', '-');

  const formatTextValue = (value?: string | null) =>
    value && value.trim() ? value : '-';

  const renderLibraries = (user: UserRow) => {
    if (!user.library_policy_known) {
      return <Badge color="bg-muted" icon={faFolderOpen} hover={false}>Library access unavailable</Badge>;
    }
    if (user.has_all_libraries) {
      return (
        <Badge color="bg-blue-500" icon={faLayerGroup} hover={false}>
          {user.server_nickname ? `All libraries on ${user.server_nickname}` : 'All libraries'}
        </Badge>
      );
    }

    if (!user.libraries || user.libraries.length === 0) {
      return (
        <Badge color="bg-muted" icon={faFolderOpen} hover={false}>No libraries</Badge>
      );
    }

    const maxVisible = 3;
    const isExpanded = expandedLibraryUsers.has(user.uuid);
    const visibleLibraries = isExpanded ? user.libraries : user.libraries.slice(0, maxVisible);
    const hiddenCount = Math.max(user.libraries.length - maxVisible, 0);

    return (
      <div className="flex flex-wrap items-center gap-1">
        {visibleLibraries.map((library) => (
          <Badge key={library} color="bg-blue-500" icon={faFolder} hover={false}>{library}</Badge>
        ))}
        {hiddenCount > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              toggleLibraryExpansion(user.uuid);
            }}
          >
            {isExpanded ? `-${hiddenCount}` : `+${hiddenCount}`}
          </Button>
        )}
      </div>
    );
  };

  // What each column shows, its header and its loading placeholder.
  const columnDefs: Array<{ id: UserColumnId; header: ReactNode; headClassName?: string; cellClassName?: string; title?: (user: UserRow) => string | undefined; skeleton: ReactNode; cell: (user: UserRow) => ReactNode }> = [
    { id: 'select', headClassName: 'w-12', skeleton: <Skeleton className="h-4 w-4" />,
      header: <Checkbox
        checked={selectAllState === 'all'}
        ref={(input) => {
          if (input) {
            (input as unknown as HTMLInputElement).indeterminate = selectAllState === 'some';
          }
        }}
        onCheckedChange={onToggleSelectAll}
        title={selectAllState === 'all' ? 'Deselect All' : 'Select All'}
      />,
      cell: (user) => <Checkbox
        checked={selectedUserIds.has(user.uuid)}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelection?.(user.uuid, {
            shiftKey: e.shiftKey,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            source: 'checkbox',
          });
        }}
      /> },
    { id: 'avatar', header: null, headClassName: 'w-12', skeleton: <Skeleton className="h-8 w-8 rounded-full" />, cell: (user) => <UserAvatar user={user} /> },
    { id: 'name', header: 'User', cellClassName: 'font-medium', skeleton: <Skeleton className="h-4 w-32" />,
      cell: (user) => <a
        href={buildUserProfilePath(user)}
        className="text-foreground hover:underline group-hover:text-primary"
        onClick={(event) => event.stopPropagation()}
      >
        {user.display_name || user.username || 'Unnamed User'}
      </a> },
    { id: 'email', header: 'Email', cellClassName: 'text-muted-foreground', skeleton: <Skeleton className="h-4 w-40" />, cell: (user) => user.external_email ?? user.email ?? '-' },
    { id: 'serviceJoinDate', header: 'Service Join', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-24" />, cell: (user) => formatDate(user.service_join_date) },
    { id: 'lastKnownIp', header: 'Last Known IP', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-24" />, cell: (user) => user.last_known_ip ?? '-' },
    { id: 'totalPlays', header: 'Total Plays', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-12" />, cell: (user) => user.total_plays ?? 0 },
    { id: 'totalDuration', header: 'Total Duration', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-16" />, cell: (user) => formatDuration(user.total_duration) },
    { id: 'type', header: 'Type', cellClassName: 'capitalize text-muted-foreground', skeleton: <Skeleton className="h-4 w-20" />, cell: (user) => user.user_type },
    { id: 'roles', header: 'Roles', skeleton: <div className="flex gap-1">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>,
      cell: (user) => <div className="flex flex-wrap gap-1">
        {getAdminRoleBadges(user).map((role) => (
          <RoleBadge key={role.name} role={role} kind="admin" />
        ))}
        {user.user_roles.map((role) => (
          <RoleBadge key={`user-role-${role.name}`} role={role} kind="user" />
        ))}
      </div> },
    { id: 'libraries', header: 'Libraries', cellClassName: 'text-muted-foreground', skeleton: <Skeleton className="h-4 w-32" />, cell: (user) => renderLibraries(user) },
    { id: 'lastStreamed', header: 'Last Streamed', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-28" />,
      title: (user) => user.last_streamed_source && user.last_streamed_source !== 'mum' ? `From ${historyServiceName[user.last_streamed_source]} history` : undefined,
      cell: (user) => formatDateTime(user.last_streamed_at) },
    { id: 'mumAddedDate', header: 'MUM Added', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-20" />, cell: (user) => formatDate(user.created_at) },
    { id: 'lastPlayed', header: 'Last Played', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-32" />,
      title: (user) => user.last_played?.started_at ? formatTimestamp(user.last_played.started_at) : undefined,
      cell: (user) => user.last_played?.media_title ?? 'Never' },
    { id: 'lastPlatform', header: 'Last Platform', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-24" />, cell: (user) => formatTextValue(user.last_platform) },
    { id: 'lastPlayer', header: 'Last Player', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-24" />, cell: (user) => formatTextValue(user.last_player) },
    { id: 'linked', header: 'Linked Services', cellClassName: 'text-muted-foreground', skeleton: <Skeleton className="h-4 w-8" />, cell: (user) => user.linked_service_count },
    { id: 'lastLogin', header: 'Last Login', cellClassName: 'text-xs text-muted-foreground', skeleton: <Skeleton className="h-4 w-32" />, cell: (user) => user.last_login_at ? formatTimestamp(user.last_login_at) : '-' },
    { id: 'actions', header: 'Actions', headClassName: 'text-right', cellClassName: 'text-right', skeleton: <div className="flex justify-end gap-1">
        <Skeleton className="h-8 w-8" />
        <Skeleton className="h-8 w-8" />
      </div>,
      cell: (user) => <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          title="Show Raw User Data"
          onClick={(e) => {
            e.stopPropagation();
            setDebugUserUuid(user.uuid);
          }}
        >
          <FontAwesomeIcon icon={faCircleInfo} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="View User Profile"
          onClick={(e) => {
            e.stopPropagation();
            navigate({ to: buildUserProfilePath(user), state: { userUuid: user.uuid } });
          }}
        >
          <FontAwesomeIcon icon={faUser} />
        </Button>
      </div> },
  ];
  const tableColumns = columnDefs.map(def => columnHelper.display({
    id: def.id, header: () => def.header, cell: ({ row }) => def.cell(row.original), meta: { headClassName: def.headClassName, cellClassName: def.cellClassName },
  }));
  const skeletons = Object.fromEntries(columnDefs.map(def => [def.id, def.skeleton])) as Record<UserColumnId, ReactNode>;
  const titles = Object.fromEntries(columnDefs.map(def => [def.id, def.title])) as Record<UserColumnId, ((user: UserRow) => string | undefined) | undefined>;
  // The page chooses the columns; selection follows the page's own rules (shift and ctrl).
  const columnVisibility = useMemo<ColumnVisibilityState>(() => ({
    select: Boolean(onToggleSelection),
    ...Object.fromEntries(Object.entries(columnChoice).map(([id, choice]) => [id, columns[choice]])),
  }), [columns, onToggleSelection]);
  const rowSelection = useMemo<RowSelectionState>(() => Object.fromEntries([...selectedUserIds].map(id => [id, true])), [selectedUserIds]);
  const table = useAppTable({
    columns: tableColumns, data: users, getRowId: user => user.uuid,
    state: { columnVisibility, rowSelection },
  });
  const visibleColumns = table.getVisibleLeafColumns();

  return (
    <div className="overflow-x-auto rounded-xl border shadow-sm">
      <Table className="min-w-max bg-card">
        <TableHeader>
          {table.getHeaderGroups().map(group => <TableRow key={group.id}>
            {group.headers.map(header => <TableHead key={header.id} className={header.column.columnDef.meta?.headClassName}><table.FlexRender header={header} /></TableHead>)}
          </TableRow>)}
        </TableHeader>
        <TableBody className="cursor-pointer">
          {loading ? (
            Array.from({ length: 5 }).map((_, idx) => (
              <TableRow key={idx}>
                {visibleColumns.map(column => <TableCell key={column.id}>{skeletons[column.id as UserColumnId]}</TableCell>)}
              </TableRow>
            ))
          ) : (
            <>
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn('group', row.getIsSelected() && 'bg-primary/10')}
                  onClick={(e) => handleRowClick(e, row.original)}
                >
                  {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName} title={titles[cell.column.id as UserColumnId]?.(row.original)}>
                    <table.FlexRender cell={cell} />
                  </TableCell>)}
                </TableRow>
              ))}
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length || 1} className="py-12 text-center text-sm text-muted-foreground">
                    No users match the current filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </>
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {onPageChange && totalPages > 1 && (
        <div className="border-t">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={onPageChange}
            loading={loading}
          />
        </div>
      )}
      <UserDebugModal
        open={Boolean(debugUserUuid)}
        onClose={() => setDebugUserUuid(null)}
        userUuid={debugUserUuid}
      />
    </div>
  );
};


export default UsersTable;
