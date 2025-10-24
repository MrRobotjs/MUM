import { useState, useEffect } from 'react';
import { Pagination } from '../common/Pagination';
import { useNavigate } from 'react-router-dom';
import { buildUserProfilePath } from '../../util/routes';
import { Checkbox } from '../ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Skeleton } from '../ui/skeleton';
import clsx from 'clsx';

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
};

export type UserColumns = {
  name: boolean;
  email: boolean;
  type: boolean;
  roles: boolean;
  linked: boolean;
  lastLogin: boolean;
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

  const avatarClasses = clsx(
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
      navigate(buildUserProfilePath(user), { state: { userUuid: user.uuid } });
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border shadow-sm">
      <Table>
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
            {columns.name ? <TableHead>Name</TableHead> : null}
            {columns.email ? <TableHead>Email</TableHead> : null}
            {columns.type ? <TableHead>Type</TableHead> : null}
            {columns.roles ? <TableHead>Roles</TableHead> : null}
            {columns.linked ? <TableHead>Linked Services</TableHead> : null}
            {columns.lastLogin ? <TableHead>Last Login</TableHead> : null}
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
                    {columns.email ? <TableCell className="text-muted-foreground">{user.external_email ?? '—'}</TableCell> : null}
                    {columns.type ? <TableCell className="capitalize text-muted-foreground">{user.user_type}</TableCell> : null}
                    {columns.roles ? (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {user.admin_roles.map((role) => (
                            <span key={role} className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium bg-muted ring-1 ring-inset ring-border">
                              {role}
                            </span>
                          ))}
                          {user.user_roles.map((role) => (
                            <span
                              key={`user-role-${role.name}`}
                              className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium ring-1 ring-inset"
                              style={
                                role.color
                                  ? {
                                      backgroundColor: `${role.color}20`,
                                      color: role.color,
                                      borderColor: `${role.color}40`
                                    }
                                  : undefined
                              }
                            >
                              {role.icon ? <i className={`${role.icon} mr-1`} /> : null}
                              {role.name}
                            </span>
                          ))}
                        </div>
                      </TableCell>
                    ) : null}
                    {columns.linked ? <TableCell className="text-muted-foreground">{user.linked_service_count}</TableCell> : null}
                    {columns.lastLogin ? (
                      <TableCell className="text-xs text-muted-foreground">
                        {user.last_login_at ? new Date(user.last_login_at).toLocaleString() : '—'}
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
    </div>
  );
};


export default UsersTable;
