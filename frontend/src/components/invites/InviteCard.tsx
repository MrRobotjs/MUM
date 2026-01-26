import { type ReactNode } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { InviteRow, InviteServer, InviteServerFeature } from './InvitesTable';

type FeatureKey = 'allow_downloads' | 'invite_to_plex_home' | 'allow_live_tv' | 'allow_4k_transcode';

export type FeatureMeta = {
  key: FeatureKey;
  label: string;
  icon: string;
  className: string;
  onlyServices?: string[];
  hideIfUniformTrue?: boolean;
};

type InviteCardProps = {
  invite: InviteRow;
  selected: boolean;
  onToggleSelect: (inviteId: number) => void;
  onEdit: (invite: InviteRow) => void;
  onViewDetail: (invite: InviteRow) => void;
  onCopyLink: (invite: InviteRow) => void;
  featureMeta: FeatureMeta[];
  getServiceBadgeClass: (serviceType: string) => string;
  getServiceIcon: (serviceType: string, className?: string) => ReactNode;
};

const getInviteStatusMeta = (invite: InviteRow) => {
  const isExpired = invite.expires_at ? new Date(invite.expires_at).getTime() < Date.now() : false;
  const uses = invite.uses_count ?? invite.current_uses ?? 0;
  const maxUses = invite.max_uses ?? null;
  const isMaxed = typeof maxUses === 'number' && maxUses > 0 ? uses >= maxUses : false;

  if (isExpired) {
    return { label: 'Expired', className: 'bg-destructive/10 text-destructive border-destructive/20' };
  }
  if (isMaxed) {
    return { label: 'Maxed', className: 'bg-amber-500/10 text-amber-600 border-amber-500/20' };
  }
  if (invite.is_active === false) {
    return { label: 'Inactive', className: 'bg-muted text-muted-foreground border-border' };
  }
  return { label: 'Active', className: 'bg-green-500/10 text-green-600 border-green-500/20' };
};

const resolveServerFeatures = (invite: InviteRow): InviteServerFeature[] => {
  const fromApi = invite.server_features ?? [];
  const map = new Map<number, typeof fromApi[number]>();
  fromApi.forEach((sf) => map.set(sf.server_id, sf));

  return (invite.servers ?? []).map((server) => {
    const existing = map.get(server.id);
    return {
      server_id: server.id,
      allow_downloads: existing?.allow_downloads ?? invite.allow_downloads ?? false,
      invite_to_plex_home: existing?.invite_to_plex_home ?? invite.invite_to_plex_home ?? false,
      allow_live_tv: existing?.allow_live_tv ?? invite.allow_live_tv ?? false,
      allow_4k_transcode: existing?.allow_4k_transcode ?? invite.allow_4k_transcode ?? true,
      server_nickname: existing?.server_nickname ?? server.server_nickname ?? server.name ?? null,
      service_type: existing?.service_type ?? server.service_type,
      is_override: existing?.is_override ?? false
    };
  });
};

export const InviteCard = ({
  invite,
  selected,
  onToggleSelect,
  onEdit,
  onViewDetail,
  onCopyLink,
  featureMeta,
  getServiceBadgeClass,
  getServiceIcon
}: InviteCardProps) => {
  const perServerFeatures = resolveServerFeatures(invite);
  const hasMembershipDuration = Boolean(invite.membership_duration_days);
  const statusMeta = getInviteStatusMeta(invite);

  return (
    <Card
      className={`relative gap-2 py-3 overflow-hidden border transition-all duration-200 ease-in-out group cursor-pointer ${
        selected ? 'ring-2 ring-primary shadow-xl translate-y-[-2px]' : 'hover:shadow-lg'
      }`}
      onClick={() => onToggleSelect(invite.id)}
    >

      {/* Selection Checkbox */}
      <div className={`absolute top-2 right-2 z-10 transition-opacity duration-200 ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelect(invite.id)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <CardHeader className="relative z-10 gap-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="font-semibold text-primary text-left hover:underline underline-offset-4 p-0"
              title="Click to copy invite link"
              onClick={(e) => {
                e.stopPropagation();
                onCopyLink(invite);
              }}
            >
              {invite.custom_path || invite.token.substring(0, 12)}
            </button>
            <a
              href={`/invite/${invite.custom_path || invite.token}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground p-1"
              title="Open link in new tab"
              onClick={(e) => e.stopPropagation()}
            >
              <i className="fa-solid fa-external-link-alt fa-xs" />
            </a>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium ${statusMeta.className}`}
          >
            <i className="fa-solid fa-circle-dot fa-xs" />
            {statusMeta.label}
          </span>
        </div>
      </CardHeader>

      <CardContent className="relative z-10 flex h-full flex-col space-y-4">
        {/* Dates + Usage */}
        <div className="space-y-2 text-xs text-muted-foreground">
          <div>
            <i className="fa-solid fa-calendar-plus fa-fw mr-1" />
            {invite.created_at ? new Date(invite.created_at).toLocaleDateString() : 'Created: N/A'}
          </div>
          <div className={invite.status === 'expired' ? 'text-destructive' : ''}>
            <i className="fa-solid fa-clock fa-fw mr-1" />
            {invite.expires_at ? new Date(invite.expires_at).toLocaleDateString() : 'Never expires'}
          </div>
          <div className="flex items-center gap-2 font-semibold bg-muted/40 border border-border px-2 py-1 rounded-full w-fit">
            <i className="fa-solid fa-users-line fa-fw" />
            <span>{invite.uses_count ?? invite.current_uses ?? 0} / {invite.max_uses ?? '\u221e'} uses</span>
          </div>
        </div>

        {/* Content: Servers, Libraries, Features */}
        <div className="space-y-3 text-sm flex-1">
          {/* Server Details grouped by server */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              <i className="fa-solid fa-server fa-fw" /> Server Access
            </div>
            <div className="space-y-2">
              {invite.servers?.length ? (
                invite.servers
                  .slice()
                  .sort((a, b) => (a.server_nickname || a.name || '').localeCompare(b.server_nickname || b.name || ''))
                  .map((server) => {
                    const libs =
                      invite.grants_all_libraries ||
                      invite.servers?.length === 1 && invite.libraries?.length
                        ? invite.libraries ?? []
                        : (invite.libraries ?? []).filter((lib) => {
                            const serverName = (server.server_nickname || server.name || '').toLowerCase();
                            return lib.server_name?.toLowerCase() === serverName || lib.service_type.toLowerCase() === server.service_type.toLowerCase();
                          });

                    const serverFeatures = perServerFeatures.find((sf) => sf.server_id === server.id);

                    const featureBadges = featureMeta
                      .filter((meta) => {
                        if (meta.onlyServices?.length && !meta.onlyServices.includes((server.service_type || '').toLowerCase())) {
                          return false;
                        }
                        return Boolean((serverFeatures as any)?.[meta.key]);
                      })
                      .map((meta) => (
                        <span
                          key={`${server.id}-${meta.key}`}
                          className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${meta.className}`}
                        >
                          <i className={`${meta.icon} w-3 h-3`} />
                          {meta.label}
                        </span>
                      ));

                    return (
                      <div
                        key={server.id}
                        className="rounded-lg border border-border/60 bg-muted/40 px-3 py-2 space-y-2"
                      >
                        <div className="flex items-center gap-2 pb-1 border-b border-border/40">
                          {getServiceIcon(server.service_type, 'w-4 h-4 text-muted-foreground')}
                          <span className="text-sm font-semibold text-foreground">
                            {server.server_nickname || server.name || 'Unnamed server'}
                          </span>
                          <span className={`ml-auto text-[10px] uppercase tracking-wider font-medium ${getServiceBadgeClass(server.service_type).replace('border', '').replace('bg-', 'text-').split(' ').find(c => c.startsWith('text-')) || 'text-muted-foreground'}`}>
                            {server.service_type}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {invite.grants_all_libraries ? (
                            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold bg-green-500/10 text-green-500 border-green-500/20">
                              <i className="fa-solid fa-infinity w-3 h-3" />
                              All Libraries
                            </span>
                          ) : libs.length ? (
                            libs.map((library) => (
                              <span
                                key={`${server.id}-${library.id}-${library.name}`}
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${getServiceBadgeClass(library.service_type)}`}
                                title={`${library.name} (${library.server_name})`}
                              >
                                {getServiceIcon(library.service_type, 'w-3 h-3')}
                                {library.name}
                              </span>
                            ))
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold bg-muted text-muted-foreground border-border">
                              <i className="fa-solid fa-question w-3 h-3" />
                              No Libraries
                            </span>
                          )}
                          {featureBadges}
                        </div>
                      </div>
                    );
                  })
              ) : (
                <span className="text-xs text-muted-foreground">No servers</span>
              )}
            </div>
          </div>

          {/* Membership Duration */}
          {hasMembershipDuration && (
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold bg-orange-500/10 text-orange-500 border-orange-500/20">
                <i className="fa-solid fa-clock w-3 h-3" />
                {invite.membership_duration_days} days
              </span>
            </div>
          )}

          {/* Discord Requirements */}
          {(invite.require_discord_auth || invite.require_discord_guild_membership) && (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <i className="fa-brands fa-discord fa-fw" /> Discord
              </div>
              <div className="flex flex-wrap gap-2">
                {invite.require_discord_auth && (
                  <span className="inline-flex items-center gap-1 text-[11px] rounded-full border px-2 py-1 text-xs font-semibold bg-[#5865F2]/10 text-[#5865F2] border-[#5865F2]/20">
                    <i className="fa-solid fa-link w-3 h-3" />
                    Auth Required
                  </span>
                )}
                {invite.require_discord_guild_membership && (
                  <span className="inline-flex items-center gap-1 text-[11px] rounded-full border px-2 py-1 text-xs font-semibold bg-[#5865F2]/10 text-[#5865F2] border-[#5865F2]/20">
                    <i className="fa-solid fa-users w-3 h-3" />
                    Guild Required
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions Footer */}
        <div className="flex justify-end gap-2 pt-3 border-t" onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            title="View Usages"
            onClick={(e) => {
              e.stopPropagation();
              onViewDetail(invite);
            }}
          >
            <i className="fa-solid fa-chart-line" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Edit Invite"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(invite);
            }}
          >
            <i className="fa-solid fa-pen-to-square" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

export default InviteCard;
