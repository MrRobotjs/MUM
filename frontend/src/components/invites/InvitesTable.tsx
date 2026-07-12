import { Button } from '@/components/ui/button';
import { Checkbox } from '../ui/checkbox';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

export type InviteServer = {
  id: number;
  server_nickname?: string | null;
  name?: string | null;
  service_type: string;
  is_active?: boolean;
  plugin_enabled?: boolean;
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
  is_expired?: boolean;
  has_reached_max_uses?: boolean;
  is_usable?: boolean;
  is_effectively_usable?: boolean;
  is_paused?: boolean;
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
  server_features?: InviteServerFeature[];
};

type InvitesTableProps = {
  invites: InviteRow[];
  selectedIds: Set<number>;
  onToggleSelect: (inviteId: number) => void;
  onSelectAll: (select: boolean) => void;
  loading?: boolean;
  onEdit?: (invite: InviteRow) => void;
  onViewDetail?: (invite: InviteRow) => void;
  onCopyLink?: (invite: InviteRow) => void;
};

export const InvitesTable = ({
  invites,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  loading,
  onEdit,
  onViewDetail,
  onCopyLink,
}: InvitesTableProps) => {
  const getStatusLabel = (invite: InviteRow) => {
    const isExpired =
      invite.is_expired ?? (invite.expires_at ? new Date(invite.expires_at).getTime() < Date.now() : false);
    const uses = invite.uses_count ?? invite.current_uses ?? 0;
    const maxUses = invite.max_uses ?? null;
    const isMaxed =
      invite.has_reached_max_uses ?? (typeof maxUses === 'number' && maxUses > 0 ? uses >= maxUses : false);
    if (isExpired) return { label: 'Expired', variant: 'destructive' as const };
    if (isMaxed) return { label: 'Maxed', variant: 'outline' as const };
    if (invite.is_active === false) return { label: 'Disabled', variant: 'secondary' as const };
    if (invite.is_paused) return { label: 'Paused', variant: 'outline' as const };
    return { label: 'Active', variant: 'default' as const };
  };

  return (
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
              <button
                type="button"
                className="block text-left font-medium break-words text-primary underline-offset-4 hover:underline"
                title="Click to copy invite link"
                onClick={() => onCopyLink?.(invite)}
                disabled={!onCopyLink}
              >
                {invite.custom_path || invite.token}
              </button>
              <div className="text-xs text-muted-foreground break-all">{invite.token}</div>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {invite.expires_at ? new Date(invite.expires_at).toLocaleString() : 'Never'}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {invite.current_uses} / {invite.max_uses ?? '∞'}
            </TableCell>
            <TableCell>
              {(() => {
                const status = getStatusLabel(invite);
                return <Badge variant={status.variant}>{status.label}</Badge>;
              })()}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-2">
                {onCopyLink ? (
                  <Button variant="ghost" size="sm" onClick={() => onCopyLink(invite)}>
                    Copy
                  </Button>
                ) : null}
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
};

export default InvitesTable;
