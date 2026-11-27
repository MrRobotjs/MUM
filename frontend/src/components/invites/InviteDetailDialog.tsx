import { useEffect, useRef, useState, type ReactNode } from 'react';
import { mutate as mutateSWR } from 'swr';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare, faBan, faBoxArchive, faCalendarDays, faCircleInfo, faCopy, faHashtag, faPen, faPhotoFilm,
  faPlay, faServer, faTicketSimple, faTriangleExclamation, faUsers, type IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import { faDiscord } from '@fortawesome/free-brands-svg-icons';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Spinner } from '../ui/spinner';
import { ResponsiveDialog } from '../ui/responsive-dialog';
import { ServiceIcon } from '../services/ServiceIcon';
import { ProvisioningReviewDialog } from './ProvisioningReviewDialog';
import { useAlerts } from '../../contexts/AlertContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { useMediaQuery } from '../../store/mediaQueryStore';
import { appLinks } from '../../router/appLinks';
import { inviteLinkWarning } from '../../lib/publicAddress';
import { capacityTone, fullServersWarning, homeCapacityLabel, memberCapacityLabel, serverIsFullForInvite, type MemberCapacity } from '../../lib/memberCapacity';
import { INVITATIONS_CACHE_KEY, applyInvitationAction, invitationDetail, invitationShareURL, openInvitation } from '../../lib/invitations';

// An invite's details: what it grants, its link and who used it, with the
// actions for it. On a desktop the sections sit beside a sidebar; on a phone
// they stack in the bottom sheet.

type InviteUsage = {
  id: string; used_at: string | null; status?: string; accepted_invite: boolean; plex_review_available?: boolean;
  user_uuid?: string | null; username?: string | null; error_code?: string | null;
};
type InviteLibrary = { id: string; name: string; selected: boolean };
type InviteServer = {
  id: number; server_nickname?: string | null; name?: string | null; service_type: string; is_active: boolean; service_enabled?: boolean;
  effective_active?: boolean; member_capacity?: MemberCapacity | null; invite_to_plex_home?: boolean; all_libraries?: boolean;
  allow_downloads?: boolean; allow_4k_transcode?: boolean; libraries: InviteLibrary[];
};
type InviteDetail = {
  id: number; token: string; custom_path?: string | null; share_url?: string | null; is_active: boolean; is_expired: boolean;
  has_reached_max_uses: boolean; is_usable: boolean; is_paused?: boolean; is_archived?: boolean; expires_at?: string | null;
  max_uses?: number | null; current_uses: number; remaining_uses?: number | null; require_discord_auth?: boolean;
  require_discord_guild_membership?: boolean; membership_duration_days?: number | null; servers: InviteServer[]; usage: InviteUsage[];
};
type Section = 'overview' | 'servers' | 'usage';

const serverName = (s: InviteServer) => s.server_nickname || s.name || `Server #${s.id}`;

// One status for the invite, with what it means.
function inviteStatus(d: InviteDetail): { label: string; tone: string; note: string } {
  if (d.is_archived) return { label: 'Archived', tone: 'text-muted-foreground', note: 'Archived: kept for its history; the link no longer works.' };
  if (!d.is_active) return { label: 'Disabled', tone: 'text-muted-foreground', note: 'Disabled: the link doesn’t work until you enable it.' };
  if (d.is_expired) return { label: 'Expired', tone: 'text-destructive', note: 'Expired: the link no longer works.' };
  if (d.has_reached_max_uses) return { label: 'Maxed', tone: 'text-amber-500', note: 'Every use has been taken.' };
  if (d.is_paused) return { label: 'Paused', tone: 'text-amber-500', note: 'No server on this invite can take new members right now.' };
  if (d.servers.some(serverIsFullForInvite)) return { label: 'Server full', tone: 'text-amber-500', note: 'Some servers are full; new members can still join the others.' };
  return { label: 'Active', tone: 'text-emerald-600', note: 'Anyone with the link can join.' };
}

function usageStatus(u: InviteUsage): { label: string; tone: string; review: boolean } {
  if (u.accepted_invite) return { label: 'Completed', tone: 'text-emerald-600', review: Boolean(u.plex_review_available) };
  if (u.status === 'failed') return { label: 'Needs review', tone: 'text-destructive', review: true };
  if (u.status === 'cancelled') return { label: 'Cancelled', tone: 'text-muted-foreground', review: true };
  return { label: 'In progress', tone: 'text-amber-500', review: Boolean(u.plex_review_available) };
}

function SummaryTile({ icon, label, value, note }: { icon: IconDefinition; label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><FontAwesomeIcon icon={icon} className="w-4" />{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

export function InviteDetailDialog({ inviteId, onClose, onEdit }: { inviteId: number | null; onClose: () => void; onEdit: (inviteId: number) => void }) {
  const { formatTimestamp } = useAccountDisplay();
  const { success, warning, error: showError } = useAlerts();
  const desktop = useMediaQuery('(min-width: 1024px)');
  const activeInvite = useRef(inviteId);
  activeInvite.current = inviteId;
  const [detail, setDetail] = useState<InviteDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<Section>('overview');
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);

  // Reads the invite again, keeping the link already read when the share key is unavailable.
  const load = async (id: number, keep?: InviteDetail | null) => {
    const next = await invitationDetail(id) as InviteDetail;
    let shared = { ...next, share_url: keep?.share_url ?? null, token: keep?.token ?? next.token };
    try {
      const share_url = await invitationShareURL(id);
      shared = { ...next, share_url, token: new URL(share_url).pathname.split('/').pop() ?? next.token };
    } catch { /* The details stay readable without the separate share key. */ }
    if (activeInvite.current === id) setDetail(shared);
  };

  useEffect(() => {
    setReviewJobId(null);
    setSection('overview');
    setDetail(null);
    setError(null);
    if (!inviteId) return;
    setLoading(true);
    load(inviteId).catch(err => {
      if (activeInvite.current !== inviteId) return;
      const message = (err as Error).message || 'Failed to load invite details';
      setError(message);
      showError('Invite details failed: ' + message);
    }).finally(() => { if (activeInvite.current === inviteId) setLoading(false); });
  }, [inviteId]);

  const copyLink = async () => {
    if (!detail?.share_url) return;
    try {
      await navigator.clipboard.writeText(detail.share_url);
      const caution = [inviteLinkWarning(detail.share_url), fullServersWarning(detail.servers)].filter(Boolean).join(' ');
      if (caution) warning(`Link copied. ${caution}`, 10000); else success('Link copied');
    } catch (err) {
      showError('Copy failed: ' + String(err));
    }
  };
  const openWizard = async () => {
    if (!inviteId) return;
    try { await openInvitation(inviteId); } catch (err) { showError('Open failed: ' + String(err)); }
  };
  const act = async (action: 'enable' | 'disable' | 'delete') => {
    if (!detail) return;
    setBusy(true);
    try {
      await applyInvitationAction([detail.id], action);
      await mutateSWR(INVITATIONS_CACHE_KEY);
      success(action === 'delete' ? 'Invite archived; its history is kept' : action === 'enable' ? 'Invite enabled' : 'Invite disabled');
      if (action === 'delete') {
        setConfirmArchive(false);
        onClose();
      } else {
        await load(detail.id, detail);
      }
    } catch (err) {
      showError('Could not update the invite: ' + String(err));
    } finally {
      setBusy(false);
    }
  };

  const status = detail ? inviteStatus(detail) : null;
  const grantedLibraries = detail ? detail.servers.reduce((n, s) => n + s.libraries.filter(l => l.selected).length, 0) : 0;
  const linkWarnings = detail?.share_url ? [inviteLinkWarning(detail.share_url), fullServersWarning(detail.servers)].filter(Boolean) as string[] : [];
  const sections: { id: Section; label: string; hint: string; icon: IconDefinition }[] = [
    { id: 'overview', label: 'Overview', hint: 'Link, limits and requirements', icon: faCircleInfo },
    { id: 'servers', label: 'Servers & access', hint: 'What each server grants', icon: faServer },
    { id: 'usage', label: `Usage${detail ? ` (${detail.usage.length})` : ''}`, hint: 'Who used this invite', icon: faUsers },
  ];

  const overview = detail && status && (
    <div className="space-y-4">
      <p className={`text-sm ${status.tone}`}>{status.note}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile icon={faServer} label="Servers" value={detail.servers.length} />
        <SummaryTile icon={faPhotoFilm} label="Libraries" value={grantedLibraries} />
        <SummaryTile icon={faCalendarDays} label="Expires" value={detail.expires_at ? formatTimestamp(detail.expires_at, 'date') : 'Never'} />
        <SummaryTile icon={faHashtag} label="Uses" value={`${detail.current_uses} / ${detail.max_uses ?? '∞'}`}
          note={detail.remaining_uses !== null && detail.remaining_uses !== undefined ? `${detail.remaining_uses} left` : undefined} />
      </div>
      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="text-xs text-muted-foreground">Invite link</div>
        {detail.share_url
          ? <div className="flex flex-wrap items-center gap-2"><a href={detail.share_url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 break-all text-sm text-primary hover:underline">{detail.share_url}</a>
            <Button variant="outline" size="sm" onClick={() => void copyLink()}><FontAwesomeIcon icon={faCopy} className="mr-1" />Copy</Button></div>
          : <p className="text-sm text-muted-foreground">The link can’t be shown: the invitation key is unavailable.</p>}
        {linkWarnings.map(text => <p key={text} className="flex items-start gap-2 text-xs text-amber-500"><FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5" />{text}</p>)}
      </div>
      <div className="rounded-lg border bg-card p-3 space-y-1 text-sm">
        <div className="text-xs text-muted-foreground">Requirements</div>
        <p className="flex items-center gap-2"><FontAwesomeIcon icon={faDiscord} className="w-4 text-muted-foreground" />
          {detail.require_discord_guild_membership ? 'Discord sign-in and membership of your Discord server' : detail.require_discord_auth ? 'Discord sign-in' : 'No Discord sign-in'}</p>
        <p className="flex items-center gap-2"><FontAwesomeIcon icon={faCalendarDays} className="w-4 text-muted-foreground" />
          {detail.membership_duration_days ? `Access lasts ${detail.membership_duration_days} day${detail.membership_duration_days === 1 ? '' : 's'}` : 'Access doesn’t expire'}</p>
        <p className="flex items-center gap-2"><FontAwesomeIcon icon={faTicketSimple} className="w-4 text-muted-foreground" />
          {detail.custom_path ? `Custom path: ${detail.custom_path}` : `Code: ${detail.token}`}</p>
      </div>
    </div>
  );

  const servers = detail && (
    <div className="space-y-3">
      {detail.servers.length === 0 && <p className="text-sm text-muted-foreground">No servers are linked to this invite.</p>}
      {detail.servers.map(server => {
        const granted = server.libraries.filter(l => l.selected);
        const c = server.member_capacity;
        const closed = server.effective_active === false ? (server.is_active === false ? 'Server disabled' : server.service_enabled === false ? 'Service disabled' : 'Unavailable')
          : c?.state === 'full' ? 'Full' : server.invite_to_plex_home && c?.home_state === 'full' ? 'Plex Home full' : null;
        const settings = [
          server.allow_downloads ? 'Downloads allowed' : 'No downloads',
          ...(server.allow_4k_transcode === false ? ['4K transcodes blocked'] : []),
          ...(server.invite_to_plex_home ? ['Joins Plex Home'] : []),
        ];
        return (
          <div key={server.id} className="rounded-lg border bg-card p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ServiceIcon serviceType={server.service_type} className="h-4 w-4 shrink-0" />
                <span className="font-semibold">{serverName(server)}</span>
                <span className="text-xs capitalize text-muted-foreground">{server.service_type}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {c && <span className={capacityTone(c.state)} title={`${homeCapacityLabel(c)} in Plex Home`}>{memberCapacityLabel(c)}</span>}
                <Badge variant="outline" className={closed ? 'text-amber-500' : 'text-emerald-600'}>{closed ?? 'Open'}</Badge>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">{settings.map(text => <span key={text} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]">{text}</span>)}</div>
            <div>
              <div className="mb-1 text-xs text-muted-foreground">
                {server.all_libraries ? 'Every library, including ones added later' : `${granted.length} ${granted.length === 1 ? 'library' : 'libraries'}`}
              </div>
              {granted.length > 0
                ? <div className="flex flex-wrap gap-2">{granted.map(l => <span key={l.id} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-[11px]">{l.name}</span>)}</div>
                : <p className="text-xs text-muted-foreground">No libraries synced yet.</p>}
            </div>
          </div>
        );
      })}
    </div>
  );

  const usage = detail && (
    <div className="space-y-2">
      {detail.usage.length === 0 && <p className="text-sm text-muted-foreground">Nobody has used this invite yet.</p>}
      {detail.usage.map(u => {
        const s = usageStatus(u);
        return (
          <div key={u.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-3">
            <div className="min-w-0">
              {u.user_uuid
                ? <Link {...appLinks.user(u.user_uuid)} className="font-medium hover:underline">{u.username || 'Unnamed account'}</Link>
                : <span className="font-medium">{u.username || 'No account yet'}</span>}
              <div className="text-xs text-muted-foreground">{u.used_at ? formatTimestamp(u.used_at) : 'Date not recorded'}{u.error_code ? ` · ${u.error_code}` : ''}</div>
            </div>
            {s.review
              ? <Button variant="outline" size="sm" className={s.tone} onClick={() => setReviewJobId(u.id)}>{s.label}</Button>
              : <span className={`text-sm ${s.tone}`}>{s.label}</span>}
          </div>
        );
      })}
    </div>
  );

  const content: Record<Section, ReactNode> = { overview, servers, usage };
  const actions = detail && (
    <div className="flex flex-wrap items-center gap-2">
      {detail.share_url && <Button variant="outline" size="sm" onClick={() => void copyLink()}><FontAwesomeIcon icon={faCopy} className="mr-1" />Copy link</Button>}
      <Button variant="outline" size="sm" onClick={() => void openWizard()}><FontAwesomeIcon icon={faArrowUpRightFromSquare} className="mr-1" />Open invite page</Button>
      {!detail.is_archived && <>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => onEdit(detail.id)}><FontAwesomeIcon icon={faPen} className="mr-1" />Edit</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(detail.is_active ? 'disable' : 'enable')}>
          <FontAwesomeIcon icon={detail.is_active ? faBan : faPlay} className="mr-1" />{detail.is_active ? 'Disable' : 'Enable'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} className="text-destructive" onClick={() => setConfirmArchive(true)}><FontAwesomeIcon icon={faBoxArchive} className="mr-1" />Archive</Button>
      </>}
    </div>
  );

  return (
    <>
      <ResponsiveDialog open={inviteId !== null} onOpenChange={open => { if (!open) onClose(); }} size="lg"
        title={<span className="flex flex-wrap items-center gap-2">Invite {detail ? <span className="font-mono">{detail.custom_path || detail.token}</span> : null}
          {status && <Badge variant="outline" className={status.tone}>{status.label}</Badge>}</span>}
        description={detail ? `${detail.servers.length} ${detail.servers.length === 1 ? 'server' : 'servers'} · ${detail.current_uses} ${detail.current_uses === 1 ? 'use' : 'uses'}` : 'Invite details'}
        bodyClassName={desktop && detail ? 'overflow-hidden' : undefined}
        footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
        {loading && !detail ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading invite…</div>
          : error ? <p className="text-sm text-destructive">{error}</p>
          : !detail ? null
          : desktop ? (
            <div className="space-y-4">
              {actions}
              <div className="flex gap-6">
                <nav aria-label="Invite sections" className="w-56 shrink-0 space-y-1 border-r border-border pr-4">
                  {sections.map(item => {
                    const selected = item.id === section;
                    return (
                      <button key={item.id} type="button" aria-current={selected ? 'true' : undefined} onClick={() => setSection(item.id)}
                        className={`flex w-full items-start gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${selected ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
                        <FontAwesomeIcon icon={item.icon} className="mt-0.5 w-4 shrink-0" />
                        <span className="min-w-0"><span className="block">{item.label}</span><span className="block text-xs font-normal text-muted-foreground">{item.hint}</span></span>
                      </button>
                    );
                  })}
                </nav>
                <div className="min-w-0 flex-1 max-h-[70vh] overflow-y-auto pr-2">{content[section]}</div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {actions}
              {sections.map(item => <section key={item.id} className="space-y-3"><h3 className="font-medium text-lg">{item.label}</h3>{content[item.id]}</section>)}
            </div>
          )}
      </ResponsiveDialog>
      <ResponsiveDialog open={confirmArchive} onOpenChange={setConfirmArchive} title="Archive this invite?" description="The link stops working."
        footer={<><Button variant="outline" onClick={() => setConfirmArchive(false)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void act('delete')}>Archive</Button></>}>
        <p className="text-sm">Archived invites keep their history and can be found under the Archived filter.</p>
      </ResponsiveDialog>
      <ProvisioningReviewDialog jobId={reviewJobId} onClose={() => setReviewJobId(null)} onChanged={async () => {
        const id = activeInvite.current;
        await mutateSWR(INVITATIONS_CACHE_KEY);
        if (id && detail) await load(id, detail);
      }} />
    </>
  );
}
