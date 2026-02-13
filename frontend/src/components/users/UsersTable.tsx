import { useState } from 'react';
import { Pagination } from '../common/Pagination';
import { useNavigate } from '@tanstack/react-router';
import { buildUserProfilePath } from '../../util/routes';
import { Checkbox } from '../ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Skeleton } from '../ui/skeleton';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { UserDebugModal } from './UserDebugModal';
import { Badge } from '../common/Badge';
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
  server_nickname?: string;
  service_type?: string;
  libraries?: string[];
  has_all_libraries?: boolean;
  access_expires_at?: string | null;
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
  } | null;
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

type UsersTableProps = {
  users: UserRow[];
  loading?: boolean;
  columns: UserColumns;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  selectedUserIds?: Set<string>;
  onToggleSelection?: (userId: string) => void;
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
  const navigate = useNavigate();
  const [debugUserUuid, setDebugUserUuid] = useState<string | null>(null);
  const [expandedLibraryUsers, setExpandedLibraryUsers] = useState<Set<string>>(new Set());
  const getAdminRoleBadges = (user: UserRow) => {
    if (user.admin_roles_detail && user.admin_roles_detail.length > 0) {
      return user.admin_roles_detail;
    }
    return user.admin_roles.map((role) => ({ name: role }));
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
      onToggleSelection(user.uuid);
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
    value ? new Date(value).toLocaleDateString() : '-';

  const formatDateTime = (value?: string | null) =>
    value ? new Date(value).toLocaleString() : '-';

  const formatTextValue = (value?: string | null) =>
    value && value.trim() ? value : '-';

  const renderLibraries = (user: UserRow) => {
    if (user.has_all_libraries) {
      return (
        <Badge color="bg-blue-500" className="text-xs font-medium gap-1" hover={false}>
          <FontAwesomeIcon icon={faLayerGroup} className="h-3 w-3" />
          {user.server_nickname ? `All libraries on ${user.server_nickname}` : 'All libraries'}
        </Badge>
      );
    }

    if (!user.libraries || user.libraries.length === 0) {
      return (
        <Badge color="bg-muted" className="text-xs font-medium gap-1" hover={false}>
          <FontAwesomeIcon icon={faFolderOpen} className="h-3 w-3" />
          No libraries
        </Badge>
      );
    }

    const maxVisible = 3;
    const isExpanded = expandedLibraryUsers.has(user.uuid);
    const visibleLibraries = isExpanded ? user.libraries : user.libraries.slice(0, maxVisible);
    const hiddenCount = Math.max(user.libraries.length - maxVisible, 0);

    return (
      <div className="flex flex-wrap items-center gap-1">
        {visibleLibraries.map((library) => (
          <Badge key={library} color="bg-blue-500" className="text-xs font-medium gap-1" hover={false}>
            <FontAwesomeIcon icon={faFolder} className="h-3 w-3 mt-0.5" />
            {library}
          </Badge>
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

  return (
    <div className="overflow-x-auto rounded-xl border shadow-sm">
      <Table className="min-w-max bg-card">
        <TableHeader>
          <TableRow>
            {onToggleSelection && (
              <TableHead className="w-12">
                <Checkbox
                  checked={selectAllState === 'all'}
                  ref={(input) => {
                    if (input) {
                      input.indeterminate = selectAllState === 'some';
                    }
                  }}
                  onCheckedChange={onToggleSelectAll}
                  title={selectAllState === 'all' ? 'Deselect All' : 'Select All'}
                />
              </TableHead>
            )}
            {columns.name ? <TableHead className="w-12"></TableHead> : null}
            {columns.name ? <TableHead>User</TableHead> : null}
            {columns.email ? <TableHead>Email</TableHead> : null}
            {columns.serviceJoinDate ? <TableHead>Service Join</TableHead> : null}
            {columns.lastKnownIp ? <TableHead>Last Known IP</TableHead> : null}
            {columns.totalPlays ? <TableHead>Total Plays</TableHead> : null}
            {columns.totalDuration ? <TableHead>Total Duration</TableHead> : null}
            {columns.type ? <TableHead>Type</TableHead> : null}
            {columns.roles ? <TableHead>Roles</TableHead> : null}
            {columns.libraries ? <TableHead>Libraries</TableHead> : null}
            {columns.lastStreamed ? <TableHead>Last Streamed</TableHead> : null}
            {columns.mumAddedDate ? <TableHead>MUM Added</TableHead> : null}
            {columns.lastPlayed ? <TableHead>Last Played</TableHead> : null}
            {columns.lastPlatform ? <TableHead>Last Platform</TableHead> : null}
            {columns.lastPlayer ? <TableHead>Last Player</TableHead> : null}
            {columns.linked ? <TableHead>Linked Services</TableHead> : null}
            {columns.lastLogin ? <TableHead>Last Login</TableHead> : null}
            {columns.actions ? <TableHead className="text-right">Actions</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody className="cursor-pointer">
          {loading ? (
            Array.from({ length: 5 }).map((_, idx) => (
              <TableRow key={idx}>
                {onToggleSelection && (
                  <TableCell>
                    <Skeleton className="h-4 w-4" />
                  </TableCell>
                )}
                {columns.name ? (
                  <TableCell>
                    <Skeleton className="h-8 w-8 rounded-full" />
                  </TableCell>
                ) : null}
                {columns.name ? (
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                ) : null}
                {columns.email ? (
                  <TableCell>
                    <Skeleton className="h-4 w-40" />
                  </TableCell>
                ) : null}
                {columns.serviceJoinDate ? (
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                ) : null}
                {columns.lastKnownIp ? (
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                ) : null}
                {columns.totalPlays ? (
                  <TableCell>
                    <Skeleton className="h-4 w-12" />
                  </TableCell>
                ) : null}
                {columns.totalDuration ? (
                  <TableCell>
                    <Skeleton className="h-4 w-16" />
                  </TableCell>
                ) : null}
                {columns.type ? (
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ) : null}
                {columns.roles ? (
                  <TableCell>
                    <div className="flex gap-1">
                      <Skeleton className="h-6 w-16" />
                      <Skeleton className="h-6 w-16" />
                    </div>
                  </TableCell>
                ) : null}
                {columns.libraries ? (
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                ) : null}
                {columns.lastStreamed ? (
                  <TableCell>
                    <Skeleton className="h-4 w-28" />
                  </TableCell>
                ) : null}
                {columns.mumAddedDate ? (
                  <TableCell>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ) : null}
                {columns.lastPlayed ? (
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                ) : null}
                {columns.lastPlatform ? (
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                ) : null}
                {columns.lastPlayer ? (
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                ) : null}
                {columns.linked ? (
                  <TableCell>
                    <Skeleton className="h-4 w-8" />
                  </TableCell>
                ) : null}
                {columns.lastLogin ? (
                  <TableCell>
                    <Skeleton className="h-4 w-32" />
                  </TableCell>
                ) : null}
                {columns.actions ? (
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Skeleton className="h-8 w-8" />
                      <Skeleton className="h-8 w-8" />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))
          ) : (
            <>
              {users.map((user) => {
                const isSelected = selectedUserIds.has(user.uuid);
                return (
                  <TableRow
                    key={user.uuid}
                    className={cn('group', isSelected && 'bg-primary/10')}
                    onClick={(e) => handleRowClick(e, user)}
                  >
                    {onToggleSelection && (
                      <TableCell>
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => onToggleSelection(user.uuid)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </TableCell>
                    )}
                    {columns.name ? (
                      <TableCell>
                        <UserAvatar user={user} />
                      </TableCell>
                    ) : null}
                    {columns.name ? (
                      <TableCell className="font-medium">
                        <a
                          href={buildUserProfilePath(user)}
                          className="text-foreground hover:underline group-hover:text-primary"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {user.display_name || user.username || 'Unnamed User'}
                        </a>
                      </TableCell>
                    ) : null}
                    {columns.email ? (
                      <TableCell className="text-muted-foreground">
                        {user.external_email ?? user.email ?? '-'}
                      </TableCell>
                    ) : null}
                    {columns.serviceJoinDate ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(user.service_join_date)}
                      </TableCell>
                    ) : null}
                    {columns.lastKnownIp ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {user.last_known_ip ?? '-'}
                      </TableCell>
                    ) : null}
                    {columns.totalPlays ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {user.total_plays ?? 0}
                      </TableCell>
                    ) : null}
                    {columns.totalDuration ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDuration(user.total_duration)}
                      </TableCell>
                    ) : null}
                    {columns.type ? <TableCell className="capitalize text-muted-foreground">{user.user_type}</TableCell> : null}
                    {columns.roles ? (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {getAdminRoleBadges(user).map((role) => (
                            <Badge
                              key={role.name}
                              hexColor={role.color ?? undefined}
                              iconClass={role.icon ?? undefined}
                              roleKind="admin"
                              badgeStyle={role.badge_style ?? undefined}
                              className="text-xs font-medium"
                              title={role.description ?? undefined}
                            >
                              {role.name}
                            </Badge>
                          ))}
                          {user.user_roles.map((role) => (
                            <Badge
                              key={`user-role-${role.name}`}
                              hexColor={role.color}
                              iconClass={role.icon}
                              roleKind="user"
                              badgeStyle={role.badge_style ?? undefined}
                              className="text-xs font-medium"
                            >
                              {role.name}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                    ) : null}
                    {columns.libraries ? (
                      <TableCell className="text-muted-foreground">
                        {renderLibraries(user)}
                      </TableCell>
                    ) : null}
                    {columns.lastStreamed ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDateTime(user.last_streamed_at)}
                      </TableCell>
                    ) : null}
                    {columns.mumAddedDate ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatDate(user.created_at)}
                      </TableCell>
                    ) : null}
                    {columns.lastPlayed ? (
                      <TableCell
                        className="text-xs text-muted-foreground"
                        title={user.last_played?.started_at ? new Date(user.last_played.started_at).toLocaleString() : undefined}
                      >
                        {user.last_played?.media_title ?? 'Never'}
                      </TableCell>
                    ) : null}
                    {columns.lastPlatform ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTextValue(user.last_platform)}
                      </TableCell>
                    ) : null}
                    {columns.lastPlayer ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {formatTextValue(user.last_player)}
                      </TableCell>
                    ) : null}
                    {columns.linked ? <TableCell className="text-muted-foreground">{user.linked_service_count}</TableCell> : null}
                    {columns.lastLogin ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '-'}
                      </TableCell>
                    ) : null}
                    {columns.actions ? (
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
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
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
              {users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={(Object.values(columns).filter(Boolean).length || 1) + (onToggleSelection ? 1 : 0) + (columns.name ? 1 : 0)} className="py-12 text-center text-sm text-muted-foreground">
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
