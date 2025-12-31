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
import { RoleBadge } from '../roles/RoleBadge';

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
  user_roles: Array<{
    name: string;
    color?: string | null;
    icon?: string | null;
  }>;
  linked_service_count: number;
  server_nickname?: string;
  service_type?: string;
  libraries?: string[];
  has_all_libraries?: boolean;
  linked_local_user?: {
    uuid: string;
    username?: string | null;
    display_name?: string | null;
  } | null;
  notes?: string | null;
  last_known_ip?: string | null;
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

const UserAvatar = ({ user }: { user: UserRow }) => {
  const [avatarError, setAvatarError] = useState(false);
  const serviceType = user.service_type?.toLowerCase();
  const isService = user.user_type.toLowerCase() === 'service';

  const avatarClasses = cn(
    'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium text-white',
    isService
      ? serviceType === 'plex' ? 'bg-plex'
      : serviceType === 'jellyfin' ? 'bg-jellyfin'
      : serviceType === 'emby' ? 'bg-emby'
      : serviceType === 'kavita' ? 'bg-kavita'
      : serviceType === 'audiobookshelf' ? 'bg-audiobookshelf'
      : serviceType === 'komga' ? 'bg-komga'
      : serviceType === 'romm' ? 'bg-romm'
      : 'bg-primary'
      : 'bg-primary'
  );

  if (user.avatar_url && !avatarError) {
    return (
      <img
        src={user.avatar_url}
        alt={user.display_name || user.username || 'User'}
        className="w-8 h-8 rounded-full object-cover ring-2 ring-primary/20"
        onError={() => setAvatarError(true)}
      />
    );
  }

  return (
    <div className={avatarClasses}>
      {(user.display_name || user.username || 'U')[0].toUpperCase()}
    </div>
  );
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

  const renderLibraries = (user: UserRow) => {
    if (user.has_all_libraries) {
      return <span className="text-xs font-medium">All Libraries</span>;
    }

    if (!user.libraries || user.libraries.length === 0) {
      return <span className="text-xs text-muted-foreground">-</span>;
    }

    const label = user.libraries.join(', ');
    return (
      <span className="max-w-[220px] truncate text-xs" title={label}>
        {label}
      </span>
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
                    className={isSelected ? 'bg-primary/10' : ''}
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
                        {user.display_name || user.username || 'Unnamed User'}
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
                          {user.admin_roles.map((role) => (
                            <RoleBadge key={role} label={role} kind="admin" />
                          ))}
                          {user.user_roles.map((role) => (
                            <RoleBadge
                              key={`user-role-${role.name}`}
                              label={role.name}
                              color={role.color}
                              icon={role.icon}
                            />
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
                            <i className="fa-solid fa-info" />
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
                            <i className="fa-solid fa-user" />
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
