import { useEffect, useMemo, useState } from 'react';
import {
  IconBrandDiscord,
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconUser,
} from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/timeFormat';
import { buildInviteShareUrl, copyInviteShareUrl } from '@/lib/inviteLinks';
import { Button } from '../ui/button';
import { useAlerts } from '../../contexts/AlertContext';
import { requestJson } from '../../util/apiClient';
import { useInviteUsages } from '../../hooks/useInviteUsages';

type InviteLibrary = {
  id: string;
  name: string;
  server_name?: string | null;
  service_type?: string | null;
};

type InviteServer = {
  id: number;
  server_nickname?: string | null;
  name?: string | null;
  service_type: string;
  is_active?: boolean;
  plugin_enabled?: boolean;
  effective_active?: boolean;
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
  is_effectively_usable?: boolean;
  is_paused?: boolean;
  expires_at?: string | null;
  max_uses?: number | null;
  current_uses: number;
  allow_downloads: boolean;
  require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean;
  membership_duration_days?: number | null;
  grants_all_libraries?: boolean;
  grant_library_ids?: string[] | null;
  libraries?: InviteLibrary[];
  servers: InviteServer[];
  disabled_servers?: InviteServer[];
  effective_server_count?: number;
  disabled_server_count?: number;
};

type InviteDetailDrawerProps = {
  inviteId: number | null;
  onClose: () => void;
};

type ApiResponse = {
  data?: InviteDetail;
} | InviteDetail;

const usageDisplayName = (usage: {
  plex_username?: string | null;
  discord_username?: string | null;
  plex_email?: string | null;
}): string =>
  usage.plex_username || usage.discord_username || usage.plex_email || 'Unknown user';

export const InviteDetailDrawer = ({ inviteId, onClose }: InviteDetailDrawerProps) => {
  const { success, error: showError } = useAlerts();
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<InviteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    usages,
    summary,
    pagination,
    loading: usagesLoading,
    error: usagesError,
  } = useInviteUsages(inviteId, page, 5);

  useEffect(() => {
    setPage(1);
  }, [inviteId]);

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
        const payload = ((json as ApiResponse)?.data ?? json) as InviteDetail;
        const normalized: InviteDetail = {
          ...payload,
          servers: payload.servers ?? [],
          libraries: payload.libraries ?? [],
          share_url: buildInviteShareUrl(payload.token, payload.custom_path),
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
  }, [inviteId, showError]);

  const librariesByServer = useMemo(() => {
    const map = new Map<number, InviteLibrary[]>();
    if (!detail) return map;

    for (const server of detail.servers ?? []) {
      const matched = (detail.libraries ?? []).filter(
        (library) =>
          library.server_name === server.server_nickname ||
          library.server_name === server.name,
      );
      map.set(server.id, matched);
    }
    return map;
  }, [detail]);

  const handleCopyShareUrl = async () => {
    if (!detail) return;
    try {
      await copyInviteShareUrl(detail.token, detail.custom_path);
      success('Invite link copied');
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
    ? detail.is_paused
      ? 'Paused'
      : detail.is_effectively_usable ?? detail.is_usable
        ? 'Usable'
        : detail.is_expired
          ? 'Expired'
          : detail.has_reached_max_uses
            ? 'Maxed'
            : detail.is_active
              ? 'Active'
              : 'Disabled'
    : '';

  const librarySelectionLabel = detail?.grants_all_libraries
    ? 'All libraries granted'
    : 'Custom selection';

  return (
    <div
      className={cn(
        'fixed inset-0 z-40 flex justify-end bg-background/60 backdrop-blur transition-opacity',
        inviteId ? 'visible opacity-100' : 'invisible opacity-0',
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
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="h-full space-y-6 overflow-y-auto px-6 py-4">
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
              <section className="space-y-4 rounded-xl border p-4 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium uppercase',
                      detail.is_paused
                        ? 'border-slate-500/20 bg-slate-500/10 text-slate-500'
                        : detail.is_usable
                          ? 'border-green-500/20 bg-green-500/10 text-green-400'
                          : 'border-yellow-500/20 bg-yellow-500/10 text-yellow-400',
                    )}
                  >
                    {statusLabel}
                  </span>
                  <span className="inline-flex items-center rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-xs font-medium text-blue-400">
                    {detail.is_active ? 'Active' : 'Disabled'}
                  </span>
                  {detail.require_discord_auth ? (
                    <span className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium">
                      Discord required
                    </span>
                  ) : null}
                  {detail.allow_downloads ? (
                    <span className="inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium">
                      Downloads
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="font-medium">Token:</span>{' '}
                    <button
                      type="button"
                      className="break-all font-mono text-primary underline-offset-4 hover:underline"
                      title="Click to copy invite link"
                      onClick={() => void handleCopyShareUrl()}
                    >
                      {detail.token}
                    </button>
                  </div>
                  {detail.custom_path ? (
                    <div>
                      <span className="font-medium">Custom path:</span>{' '}
                      <button
                        type="button"
                        className="break-all font-mono text-primary underline-offset-4 hover:underline"
                        title="Click to copy invite link"
                        onClick={() => void handleCopyShareUrl()}
                      >
                        {detail.custom_path}
                      </button>
                    </div>
                  ) : null}
                  <div>
                    <span className="font-medium">Expires at:</span>{' '}
                    {detail.expires_at ? new Date(detail.expires_at).toLocaleString() : 'Never'}
                  </div>
                  <div>
                    <span className="font-medium">Usage:</span> {detail.current_uses} /{' '}
                    {detail.max_uses ?? '∞'}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Share link:</span>
                    <a
                      className="break-all text-primary underline-offset-4 hover:underline"
                      href={detail.share_url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {detail.share_url}
                    </a>
                    <Button variant="ghost" size="sm" onClick={handleCopyShareUrl}>
                      Copy
                    </Button>
                  </div>
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
                  <span className="text-xs uppercase text-muted-foreground">{librarySelectionLabel}</span>
                </header>
                <div className="space-y-3">
                  {(detail.servers?.length ?? 0) === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No servers are linked to this invite yet.
                    </div>
                  ) : null}
                  {detail.servers?.map((server) => {
                    const serverLibraries = librariesByServer.get(server.id) ?? [];
                    return (
                      <div key={server.id} className="rounded-lg border p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-semibold">
                              {server.server_nickname || server.name || 'Server'}
                            </div>
                            <div className="text-xs uppercase text-muted-foreground">
                              {server.service_type}
                            </div>
                          </div>
                          <span
                            className={cn(
                              'inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium',
                              server.effective_active === false
                                ? 'border-amber-500/20 bg-amber-500/10 text-amber-500'
                                : server.is_active
                                  ? 'border-green-500/20 bg-green-500/10 text-green-400'
                                  : 'border-gray-500/20 bg-gray-500/10 text-gray-400',
                            )}
                          >
                            {server.effective_active === false
                              ? 'Unavailable'
                              : server.is_active
                                ? 'Active'
                                : 'Inactive'}
                          </span>
                        </div>
                        <ul className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                          {serverLibraries.map((library) => (
                            <li key={`${server.id}-${library.id}`} className="rounded-md border px-3 py-2">
                              <div className="font-medium">{library.name}</div>
                              <div className="text-xs text-muted-foreground">Granted</div>
                            </li>
                          ))}
                          {serverLibraries.length === 0 ? (
                            <li className="text-xs text-muted-foreground">
                              {detail.grants_all_libraries
                                ? 'All libraries on this server.'
                                : 'No specific libraries selected.'}
                            </li>
                          ) : null}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-3">
                {summary ? (
                  <div className="grid grid-cols-2 gap-2 border-b border-border pb-4">
                    <div className="border border-border bg-muted/30 p-3">
                      <span className="block text-xs font-medium uppercase text-muted-foreground">
                        Claims
                      </span>
                      <span className="text-xl font-bold tabular-nums text-foreground">
                        {summary.accepted}{' '}
                        <span className="text-xs font-normal text-muted-foreground">
                          / {summary.total}
                        </span>
                      </span>
                    </div>
                    <div className="border border-border bg-muted/30 p-3">
                      <span className="block text-xs font-medium uppercase text-muted-foreground">
                        Discord linked
                      </span>
                      <span className="text-xl font-bold tabular-nums text-foreground">
                        {summary.discord_auth_successful}
                      </span>
                    </div>
                  </div>
                ) : null}

                <h4 className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <IconClock className="h-3.5 w-3.5" />
                  Recent usage history
                </h4>

                {usagesLoading ? (
                  <div className="space-y-2">
                    {[...Array(3)].map((_, index) => (
                      <div
                        key={index}
                        className="h-16 w-full animate-pulse border border-border bg-muted"
                      />
                    ))}
                  </div>
                ) : null}

                {usagesError ? (
                  <p className="text-xs font-medium text-destructive">Failed to load log history.</p>
                ) : null}

                {!usagesLoading && !usagesError && usages.length === 0 ? (
                  <p className="border border-dashed border-border bg-muted/10 p-4 text-center text-xs text-muted-foreground/60">
                    This invite link hasn&apos;t been claimed yet.
                  </p>
                ) : null}

                {!usagesLoading && usages.length > 0 ? (
                  <div className="divide-y divide-border border border-border bg-card">
                    {usages.map((usage) => (
                      <div
                        key={usage.id}
                        className="space-y-1 p-3 text-xs transition-colors hover:bg-muted/20"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 font-medium text-foreground">
                            <IconUser className="h-3.5 w-3.5 text-muted-foreground" />
                            {usageDisplayName(usage)}
                          </div>
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {formatTimeAgo(usage.used_at)}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center justify-between pt-0.5 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">{usage.ip_address ?? '—'}</span>
                          {usage.discord_username ? (
                            <span className="flex items-center gap-1 text-primary/80">
                              <IconBrandDiscord className="h-3 w-3" />
                              {usage.discord_username}
                            </span>
                          ) : null}
                        </div>
                        {usage.status_message ? (
                          <p className="text-[11px] text-muted-foreground">{usage.status_message}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {pagination && pagination.total_pages > 1 ? (
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      Page {pagination.page} of {pagination.total_pages}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page <= 1 || usagesLoading}
                        onClick={() => setPage((current) => current - 1)}
                      >
                        <IconChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={page >= pagination.total_pages || usagesLoading}
                        onClick={() => setPage((current) => current + 1)}
                      >
                        <IconChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
};

export default InviteDetailDrawer;
