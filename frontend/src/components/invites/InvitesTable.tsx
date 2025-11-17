import { Button } from '@/components/ui/button';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

export type InviteServer = {
  id: number;
  name: string;
  service_type: string;
};

export type InviteLibrary = {
  id: string;
  name: string;
  server_name: string;
  service_type: string;
};

export type InviteRow = {
  id: number;
  token: string;
  custom_path?: string;
  expires_at?: string | null;
  max_uses?: number | null;
  current_uses: number;
  uses_count?: number; // Alias for current_uses used in some contexts
  is_active: boolean;
  status?: string; // Status computed on frontend: 'active' | 'inactive' | 'expired' | 'maxed'
  created_at?: string | null;
  updated_at?: string | null;
  grant_library_ids?: string[];
  allow_downloads?: boolean;
  require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean;
  servers?: InviteServer[];
  libraries?: InviteLibrary[];
  grants_all_libraries?: boolean;
  invite_to_plex_home?: boolean;
  allow_live_tv?: boolean;
  membership_duration_days?: number;
};

type InvitesTableProps = {
  invites: InviteRow[];
  selectedIds: Set<number>;
  onToggleSelect: (inviteId: number) => void;
  onSelectAll: (select: boolean) => void;
  loading?: boolean;
  onEdit?: (invite: InviteRow) => void;
  onViewDetail?: (invite: InviteRow) => void;
};

export const InvitesTable = ({
  invites,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  loading,
  onEdit,
  onViewDetail
}: InvitesTableProps) => (
  <div className="overflow-hidden rounded-xl border shadow-sm">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12">
            <Checkbox
              checked={selectedIds.size > 0 && selectedIds.size === invites.length}
              onCheckedChange={(checked) => onSelectAll(!!checked)}
            />
          </TableHead>
          <TableHead>Token / Path</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Uses</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invites.map((invite) => (
          <TableRow key={invite.id}>
            <TableCell>
              <Checkbox
                checked={selectedIds.has(invite.id)}
                onCheckedChange={() => onToggleSelect(invite.id)}
              />
            </TableCell>
            <TableCell>
              <div className="font-medium break-words">{invite.custom_path || invite.token}</div>
              <div className="text-xs text-muted-foreground break-all">{invite.token}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {invite.expires_at ? new Date(invite.expires_at).toLocaleString() : 'Never'}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {invite.current_uses} / {invite.max_uses ?? '∞'}
            </TableCell>
            <TableCell>
              <Badge variant={invite.is_active ? 'default' : 'secondary'}>
                {invite.is_active ? 'Active' : 'Disabled'}
              </Badge>
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const publicPath = encodeURIComponent(invite.custom_path || invite.token);
                    window.open(`/invite/${publicPath}`, '_blank', 'noopener');
                  }}
                >
                  Open
                </Button>
                {onViewDetail ? (
                  <Button variant="ghost" size="sm" onClick={() => onViewDetail(invite)}>
                    Detail
                  </Button>
                ) : null}
                {onEdit ? (
                  <Button variant="ghost" size="sm" onClick={() => onEdit(invite)}>
                    Edit
                  </Button>
                ) : null}
              </div>
            </TableCell>
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

export default InvitesTable;
