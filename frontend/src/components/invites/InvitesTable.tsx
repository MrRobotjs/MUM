import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { Button } from '@/components/ui/button';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { useMemo } from 'react';
import type { RowSelectionState } from '@tanstack/react-table';
import { createAppColumnHelper, useAppTable } from '../table/DataTable';

export type InviteServer = {
  id: number;
  server_nickname?: string | null;
  name?: string | null;
  service_type: string;
  is_active?: boolean;
  service_enabled?: boolean;
  effective_active?: boolean;
};

export type InviteServerFeature = {
  server_id: number;
  allow_downloads?: boolean | null;
  invite_to_plex_home?: boolean | null;
  allow_live_tv?: boolean | null;
  allow_4k_transcode?: boolean | null;
  server_nickname?: string | null;
  service_type?: string | null;
  is_override?: boolean | null;
};

export type InviteLibrary = {
  server_id?: number;
  id: string;
  name: string;
  server_name: string;
  service_type: string;
};

export type InviteRow = {
	revision?: number;
	reserved_uses?: number;
	all_library_server_ids?: number[];
  id: number;
  token: string;
  custom_path?: string;
  expires_at?: string | null;
  max_uses?: number | null;
  current_uses: number;
  uses_count?: number; // Alias for current_uses used in some contexts
  is_active: boolean;
  is_expired?: boolean;
  has_reached_max_uses?: boolean;
  is_usable?: boolean;
  is_effectively_usable?: boolean;
  is_paused?: boolean;
  is_archived?: boolean;
  archived_at?: string | null;
  effective_server_count?: number;
  disabled_server_count?: number;
  status?: string; // Status computed on frontend: 'active' | 'inactive' | 'expired' | 'maxed'
  created_at?: string | null;
  updated_at?: string | null;
  grant_library_ids?: string[];
  allow_downloads?: boolean;
  require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean;
  servers?: InviteServer[];
  disabled_servers?: InviteServer[];
  libraries?: InviteLibrary[];
  grants_all_libraries?: boolean;
  invite_to_plex_home?: boolean;
  allow_live_tv?: boolean;
  membership_duration_days?: number;
  allow_4k_transcode?: boolean;
  grant_purge_whitelist?: boolean;
  server_features?: InviteServerFeature[];
};

const columnHelper = createAppColumnHelper<InviteRow>();

type InvitesTableProps = {
  invites: InviteRow[];
  selectedIds: Set<number>;
  onToggleSelect: (inviteId: number) => void;
  onSelectAll: (select: boolean) => void;
  loading?: boolean;
  onEdit?: (invite: InviteRow) => void;
  onViewDetail?: (invite: InviteRow) => void;
	onOpen?: (invite: InviteRow) => void;
};

export const InvitesTable = ({
  invites,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  loading,
  onEdit,
  onViewDetail, onOpen
}: InvitesTableProps) => {
  const { formatTimestamp } = useAccountDisplay();
  const getStatusLabel = (invite: InviteRow) => {
    const isExpired =
      invite.is_expired ?? (invite.expires_at ? new Date(invite.expires_at).getTime() < Date.now() : false);
    const uses = invite.uses_count ?? invite.current_uses ?? 0;
    const maxUses = invite.max_uses ?? null;
    const isMaxed =
      invite.has_reached_max_uses ?? (typeof maxUses === 'number' && maxUses > 0 ? uses >= maxUses : false);
    if (invite.is_archived) return { label: 'Archived', variant: 'secondary' as const };
    if (isExpired) return { label: 'Expired', variant: 'destructive' as const };
    if (isMaxed) return { label: 'Maxed', variant: 'outline' as const };
    if (invite.is_active === false) return { label: 'Disabled', variant: 'secondary' as const };
    if (invite.is_paused) return { label: 'Paused', variant: 'outline' as const };
    return { label: 'Active', variant: 'default' as const };
  };

  // The page keeps the selection; the table shows it.
  const rowSelection = useMemo<RowSelectionState>(() => Object.fromEntries([...selectedIds].map(id => [String(id), true])), [selectedIds]);
  const columns = [
    columnHelper.display({ id: 'select', meta: { headClassName: 'w-12' },
      header: () => <Checkbox
        checked={selectedIds.size > 0 && selectedIds.size === invites.length}
        onCheckedChange={(checked) => onSelectAll(!!checked)}
      />,
      cell: ({ row }) => <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={() => onToggleSelect(row.original.id)}
      /> }),
    columnHelper.display({ id: 'token', header: 'Token / Path', cell: ({ row }) => <>
      <div className="font-medium wrap-break-word">{row.original.custom_path || row.original.token}</div>
      <div className="text-xs text-muted-foreground break-all">{row.original.token}</div>
    </> }),
    columnHelper.display({ id: 'expires', header: 'Expires', meta: { cellClassName: 'text-muted-foreground' },
      cell: ({ row }) => row.original.expires_at ? formatTimestamp(row.original.expires_at) : 'Never' }),
    columnHelper.display({ id: 'uses', header: 'Uses', meta: { cellClassName: 'text-muted-foreground' },
      cell: ({ row }) => <>{row.original.current_uses} / {row.original.max_uses ?? '∞'}{row.original.reserved_uses ? ` (+${row.original.reserved_uses} reserved)` : ''}</> }),
    columnHelper.display({ id: 'status', header: 'Status', cell: ({ row }) => {
      const status = getStatusLabel(row.original);
      return <Badge variant={status.variant}>{status.label}</Badge>;
    } }),
    columnHelper.display({ id: 'actions', header: () => null, meta: { headClassName: 'text-right', cellClassName: 'text-right' }, cell: ({ row }) => {
      const invite = row.original;
      return <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpen?.(invite)}
        >
          Open
        </Button>
        {onViewDetail ? (
          <Button variant="ghost" size="sm" onClick={() => onViewDetail(invite)}>
            Detail
          </Button>
        ) : null}
        {onEdit ? (
          <Button variant="ghost" size="sm" disabled={invite.is_archived} title={invite.is_archived ? 'Archived invites cannot be edited' : undefined} onClick={() => onEdit(invite)}>
            Edit
          </Button>
        ) : null}
      </div>;
    } }),
  ];
  const table = useAppTable({ columns, data: invites, getRowId: invite => String(invite.id), state: { rowSelection } });

  return (
  <div className="overflow-hidden rounded-xl border shadow-sm">
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map(group => <TableRow key={group.id}>
          {group.headers.map(header => <TableHead key={header.id} className={header.column.columnDef.meta?.headClassName}><table.FlexRender header={header} /></TableHead>)}
        </TableRow>)}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map(cell => <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}><table.FlexRender cell={cell} /></TableCell>)}
          </TableRow>
        ))}
        {!loading && invites.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
              No invites found.
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  </div>
  );
};

export default InvitesTable;
