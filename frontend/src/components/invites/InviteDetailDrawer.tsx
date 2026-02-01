import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { useAlerts } from '../../contexts/AlertContext';
import { requestJson } from '../../util/apiClient';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

type InviteUsageEntry = {
  id: number;
  used_at: string | null;
  ip_address?: string | null;
  plex_username?: string | null;
  plex_email?: string | null;
  discord_username?: string | null;
  discord_user_id?: string | null;
  accepted_invite: boolean;
  status_message?: string | null;
  user_uuid?: string | null;
  plex_auth_successful: boolean;
  discord_auth_successful: boolean;
};

type InviteServerLibrary = {
  id: string;
  name: string;
  library_type?: string | null;
  selected: boolean;
  external_id?: string | null;
  internal_id?: string | null;
};

type InviteServer = {
  id: number;
  server_nickname?: string | null;
  name?: string | null;
  service_type: string;
  url?: string | null;
  public_url?: string | null;
  is_active: boolean;
  libraries: InviteServerLibrary[];
};

type InviteDetail = {
  id: number;
  token: string;
  custom_path?: string | null;
  share_url?: string | null;
  is_active: boolean;
  is_expired: boolean;
  has_reached_max_uses: boolean;
  is_usable: boolean;
  expires_at?: string | null;
  max_uses?: number | null;
  current_uses: number;
  remaining_uses?: number | null;
  allow_downloads: boolean;
  invite_to_plex_home?: boolean;
  allow_live_tv?: boolean;
  require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean;
  membership_duration_days?: number | null;
  library_selection_mode: 'all' | 'custom';
  grant_library_ids?: string[] | null;
  servers: InviteServer[];
  usage: InviteUsageEntry[];
  usage_summary: {
    total: number;
    accepted: number;
    pending: number;
    plex_auth_successful: number;
    discord_auth_successful: number;
    last_used_at?: string | null;
  };
};

type InviteDetailDrawerProps = {
  inviteId: number | null;
  onClose: () => void;
};

type ApiResponse = {
  data?: InviteDetail;
} | InviteDetail;

export const InviteDetailDrawer = ({ inviteId, onClose }: InviteDetailDrawerProps) => {
  const { success, error: showError } = useAlerts();
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<InviteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      if (!inviteId) {
        setDetail(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const json = await requestJson<ApiResponse>(`/api/v2/invites/${inviteId}`);
        const payload = (json as any)?.data ?? (json as any);
        const normalized: InviteDetail = {
          ...(payload as InviteDetail),
          servers: (payload as any)?.servers ?? [],
          usage: (payload as any)?.usage ?? [],
          usage_summary: (payload as any)?.usage_summary ?? {
            total: 0,
            accepted: 0,
            pending: 0,
            plex_auth_successful: 0,
            discord_auth_successful: 0,
            last_used_at: null
          }
        };
        setDetail(normalized);
      } catch (err) {
        const message = (err as Error).message || 'Failed to load invite details';
        setError(message);
        showError('Invite detail failed: ' + message);
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [inviteId]);

  const handleCopyShareUrl = async () => {
    if (!detail?.share_url) return;
    try {
      await navigator.clipboard.writeText(detail.share_url);
      success('Link copied');
    } catch (err) {
      showError('Copy failed: ' + String(err));
    }
  };

  const openInvite = () => {
    if (!detail) return;
    const path = encodeURIComponent(detail.custom_path || detail.token);
    window.open(`/invite/${path}`, '_blank', 'noopener');
  };

  const statusLabel = detail
    ? detail.is_usable
      ? 'Usable'
      : detail.is_expired
        ? 'Expired'
        : detail.has_reached_max_uses
          ? 'Maxed'
          : detail.is_active
            ? 'Active'
            : 'Disabled'
    : '';

  return (
    <div
      className={cn(
        'fixed inset-0 z-40 flex justify-end bg-background/60 backdrop-blur transition-opacity',
        inviteId ? 'opacity-100 visible' : 'opacity-0 invisible'
      )}
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-3xl transform bg-background shadow-2xl transition-transform duration-200 ease-out"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold">Invite Detail</h2>
            {detail ? (
              <p className="text-sm text-muted-foreground">
                {detail.custom_path || detail.token} • Status: {statusLabel}
              </p>
            ) : null}
          </div>
          <Button variant='ghost' onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="h-full overflow-y-auto px-6 py-4 space-y-6">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              Loading invite...
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {!loading && !error && !detail ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Select an invite to view its details.
            </div>
          ) : null}

          {detail ? (
            <>
              <section className="rounded-xl border p-4 shadow-sm space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('inline-flex items-center rounded-md px-2 py-1 text-xs font-medium uppercase', detail.is_usable ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20')}>
                    {statusLabel}
                  </span>
                  <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">{detail.is_active ? 'Active' : 'Disabled'}</span>
                  {detail.require_discord_auth ? <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium border">Discord required</span> : null}
                  {detail.allow_downloads ? <span className="inline-flex items-center rounded-md px-2 py-1 text-xs font-medium border">Downloads</span> : null}
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="font-medium">Token:</span>{' '}
                    <span className="font-mono text-muted-foreground break-all">{detail.token}</span>
                  </div>
                  {detail.custom_path ? (
                    <div>
                      <span className="font-medium">Custom path:</span>{' '}
                      <span className="font-mono text-muted-foreground break-all">{detail.custom_path}</span>
                    </div>
                  ) : null}
                  <div>
                    <span className="font-medium">Expires at:</span>{' '}
                    {detail.expires_at ? new Date(detail.expires_at).toLocaleString() : 'Never'}
                  </div>
                  <div>
                    <span className="font-medium">Usage:</span>{' '}
                    {detail.current_uses} / {detail.max_uses ?? '∞'}
                    {detail.remaining_uses !== null ? ` (${detail.remaining_uses} remaining)` : null}
                  </div>
                  {detail.share_url ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">Share link:</span>
                      <a
                        className="text-primary underline-offset-4 hover:underline break-all"
                        href={detail.share_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {detail.share_url}
                      </a>
                      <Button variant="ghost" size="sm" onClick={handleCopyShareUrl}>
                        Copy
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="ghost" onClick={openInvite}>
                      Open Public Wizard
                    </Button>
                  </div>
                </div>
              </section>

              <section className="space-y-3">
                <header className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Servers & Libraries</h3>
                  <span className="text-xs uppercase text-muted-foreground">
                    {detail.library_selection_mode === 'all' ? 'All libraries granted' : 'Custom selection'}
                  </span>
                </header>
                <div className="space-y-3">
                  {(detail.servers?.length ?? 0) === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No servers are linked to this invite yet.
                    </div>
                  ) : null}
                  {detail.servers?.map((server) => (
                    <div key={server.id} className="rounded-lg border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="font-semibold">{server.server_nickname || server.name || 'Server'}</div>
                          <div className="text-xs text-muted-foreground uppercase">
                            {server.service_type}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={cn('inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium', server.is_active ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-gray-500/10 text-gray-400 border-gray-500/20')}>
                            {server.is_active ? 'Active' : 'Inactive'}
                          </span>
                          {server.public_url ? (
                            <a className="text-sm text-primary underline-offset-4 hover:underline" href={server.public_url} target="_blank" rel="noreferrer">
                              Public URL
                            </a>
                          ) : null}
                        </div>
                      </div>
                      <ul className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                        {(server.libraries || []).map((lib) => (
                          <li key={lib.id} className="rounded-md border px-3 py-2">
                            <div className="font-medium">{lib.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {lib.library_type ?? 'Library'} • {lib.selected ? 'Granted' : 'Not granted'}
                            </div>
                          </li>
                        ))}
                        {(server.libraries || []).length === 0 ? (
                          <li className="text-xs text-muted-foreground">No libraries synced.</li>
                        ) : null}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <header className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Usage</h3>
                  {(detail.usage_summary?.total ?? 0) > 0 ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{detail.usage_summary?.total ?? 0} total</span>
                      <span>{detail.usage_summary?.accepted ?? 0} accepted</span>
                      <span>{detail.usage_summary?.pending ?? 0} pending</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">No usage yet</span>
                  )}
                </header>
                <div className="rounded-xl border">
                  <div className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Plex</TableHead>
                          <TableHead>Discord</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>User</TableHead>
                          <TableHead>IP</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.usage?.map((usage) => (
                          <TableRow key={usage.id}>
                            <TableCell className="whitespace-nowrap">
                              {usage.used_at ? new Date(usage.used_at).toLocaleString() : '-'}
                            </TableCell>
                            <TableCell>
                              {usage.plex_username ? (
                                <div className="flex flex-col">
                                  <span>{usage.plex_username}</span>
                                  <span className="text-xs text-muted-foreground">{usage.plex_email ?? '-'}</span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {usage.plex_auth_successful ? 'Success' : 'Pending'}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              {usage.discord_username ? (
                                <div className="flex flex-col">
                                  <span>{usage.discord_username}</span>
                                  <span className="text-xs text-muted-foreground">{usage.discord_user_id ?? '-'}</span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {usage.discord_auth_successful ? 'Success' : 'Pending'}
                                </span>
                              )}
                            </TableCell>
                            <TableCell>
                              <span
                                className={cn(
                                  'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium',
                                  usage.accepted_invite ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-gray-500/10 text-gray-400 border border-gray-500/20'
                                )}
                              >
                                {usage.accepted_invite ? 'Accepted' : 'Pending'}
                              </span>
                              {usage.status_message ? (
                                <div className="text-xs text-muted-foreground">{usage.status_message}</div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground break-all">
                              {usage.user_uuid ?? '-'}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{usage.ip_address ?? '-'}</TableCell>
                          </TableRow>
                        ))}
                        {(detail.usage?.length ?? 0) === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} className="py-6 text-center text-xs text-muted-foreground">
                              No usage records yet.
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
};

export default InviteDetailDrawer;
