import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import useSWR from 'swr';
import { Link } from '@tanstack/react-router';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faChevronRight, faCircleInfo, faClock, faClockRotateLeft, faFilm, faLayerGroup, faPlay, faPlus, faStar, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useAuth } from '../../contexts/AuthContext';
import { useAccountDisplay } from '../../hooks/useAccountDisplay';
import { getAuthSnapshot, subscribeToAuthStore } from '../../store/authStore';
import { fetchServerLibraries } from '../../lib/serverLibraries';
import { fetchLibraryMostPlayed, fetchLibraryRecentlyAdded } from '../../lib/libraryOverview';
import { watchTime } from '../../lib/identityPlayTotals';
import { SettingIcon, TabHeading } from '../users/AccountSettings';
import { libraryTypeIcon } from '../servers/ServerLibrariesCard';
import '../dashboard/ServerHealth.css';

// A library's Overview tab: status tiles, its details, then its most played
// items over the last 30 days and its newest items. Figures are this library's on
// its server, as on the server's Libraries page.

export type LibraryOverviewLibrary = {
  id: number; name: string; external_id: string; library_type?: string | null; last_scanned?: string | null;
  server?: { server_nickname: string; server_name?: string | null };
  catalogue?: { synced_at?: string | null; item_count?: number | null };
};

/** A poster with a film icon when there's none or it fails to load. */
export const Poster = ({ url, title, className }: { url: string | null; title: string; className: string }) => {
  const [failed, setFailed] = useState(false);
  return <div className={cn(className, 'rounded bg-muted/30 flex items-center justify-center overflow-hidden')}>
    {url && !failed ? <img src={url} alt={title || 'Media poster'} className="w-full h-full object-cover" onError={() => setFailed(true)} />
      : <FontAwesomeIcon icon={faFilm} className="text-muted-foreground/40 text-sm" />}
  </div>;
};

/** A status tile in the server Overview's style (also the library Stats tab's). */
export const Tile = ({ icon, label, value, note }: { icon: IconDefinition; label: string; value: ReactNode; note?: ReactNode }) => (
  <div className="dashboard-health-tile dashboard-overview-tile">
    <SettingIcon className="bg-primary/20 text-primary"><FontAwesomeIcon icon={icon} className="w-4 h-4" /></SettingIcon>
    <div className="dashboard-health-body">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
      {note ? <span className="dashboard-health-note">{note}</span> : null}
    </div>
  </div>
);

/** A label and value line in a Details card. */
export const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex justify-between gap-4">
    <span className="text-muted-foreground whitespace-nowrap">{label}:</span>
    <span className="font-medium text-right break-words min-w-0">{children}</span>
  </div>
);

// A card whose posters scroll sideways, with left and right buttons; a
// button is disabled at its end of the row.
function PosterCarousel({ icon, title, description, label, children, empty }: {
  icon: IconDefinition; title: string; description: string; label: string; children: ReactNode; empty?: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    setEnds({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, children]);
  const scroll = (direction: number) => row.current?.scrollBy({ left: direction * row.current.clientWidth * 0.8 });
  return <Card>
    <CardHeader>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <TabHeading icon={icon} title={title} description={description} />
        {!empty && <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label={`Scroll ${label} left`} disabled={ends.start} onClick={() => scroll(-1)}><FontAwesomeIcon icon={faChevronLeft} /></Button>
          <Button type="button" variant="ghost" size="icon" aria-label={`Scroll ${label} right`} disabled={ends.end} onClick={() => scroll(1)}><FontAwesomeIcon icon={faChevronRight} /></Button>
        </div>}
      </div>
    </CardHeader>
    <CardContent>{empty ?? <div ref={row} className="account-recent-row" onScroll={measure}>{children}</div>}</CardContent>
  </Card>;
}

export function LibraryOverview({ serverId, serviceLabel, library }: { serverId: number; serviceLabel: string; library: LibraryOverviewLibrary }) {
  const { user, isAdministrator } = useAuth();
  const session = useSyncExternalStore(subscribeToAuthStore, getAuthSnapshot, getAuthSnapshot);
  const { formatTimestamp, formatRelative } = useAccountDisplay();
  const actor = isAdministrator && user?.uuid && session.accessToken ? [user.uuid, session.accessToken] as const : null;
  const figures = useSWR(actor ? ['library-overview-figures', ...actor, serverId] as const : null, ([, , , id]) => fetchServerLibraries(id, 'all'));
  const mostPlayed = useSWR(actor ? ['library-overview-most-played', ...actor, library.id] as const : null, ([, , , id]) => fetchLibraryMostPlayed(id));
  const recent = useSWR(actor ? ['library-overview-recent', ...actor, library.id] as const : null, ([, , , id]) => fetchLibraryRecentlyAdded(id, 20));
  const row = figures.data?.items.find(item => item.id === library.id);
  const type = (library.library_type ?? '').replace(/_/g, ' ');
  const shows = row?.parent_count !== null && row?.parent_count !== undefined && /show|tv|series/i.test(library.library_type ?? '');
  const mediaLink = (id: number) => ({ to: '/admin/servers/$serverId/libraries/$libraryId/$mediaId' as const, params: { serverId: String(serverId), libraryId: String(library.id), mediaId: String(id) } });
  const watch = (seconds: number | null | undefined) => seconds === null || seconds === undefined ? '—' : watchTime(String(seconds)).map(([value, unit]) => `${value} ${unit}`).join(' ');

  return <div className="space-y-6">
    <div className="dashboard-overview-grid">
      <Tile icon={libraryTypeIcon(library.library_type ?? null)} label="Items" value={row?.item_count?.toLocaleString() ?? '—'} note={<span className="capitalize">{type || 'Library'}</span>} />
      {row?.child_count !== null && row?.child_count !== undefined && (
        <Tile icon={faLayerGroup} label={shows ? 'Episodes' : 'Tracks'} value={row.child_count.toLocaleString()}
          note={`${(row.parent_count ?? 0).toLocaleString()} ${shows ? 'seasons' : 'albums'}`} />
      )}
      <Tile icon={faPlay} label="Plays" value={row ? row.plays.toLocaleString() : '—'} note="All plays on this server" />
      <Tile icon={faClock} label="Watch time" value={watch(row?.watch_seconds)} note="Recorded by MUM" />
      <Tile icon={faClockRotateLeft} label="Last streamed" value={row?.last_streamed_at ? formatRelative(row.last_streamed_at) : 'Never'}
        note={row?.last_played?.title || (row?.last_streamed_at ? formatTimestamp(row.last_streamed_at) : undefined)} />
    </div>

    <Card>
      <CardHeader><TabHeading icon={faCircleInfo} title="Details" description="This library and its catalogue in MUM." /></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Library</p>
            <Row label="Name">{library.name}</Row>
            <Row label="Type"><span className="capitalize">{type || 'Unknown'}</span></Row>
            <Row label="Server">{library.server?.server_name || library.server?.server_nickname || '—'}</Row>
            <Row label="Service">{serviceLabel}</Row>
            <Row label="External ID"><span className="font-mono text-sm">{library.external_id}</span></Row>
          </div>
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Catalogue</p>
            <Row label="Synced">{library.catalogue?.synced_at ? formatTimestamp(library.catalogue.synced_at) : 'Not synced yet'}</Row>
            <Row label="Items in catalogue">{library.catalogue?.synced_at ? (library.catalogue.item_count ?? 0).toLocaleString() : '—'}</Row>
            <Row label="Last scanned">{library.last_scanned ? formatTimestamp(library.last_scanned) : 'Not available'}</Row>
          </div>
        </div>
      </CardContent>
    </Card>

    <PosterCarousel icon={faStar} title="Most played" description="The last 30 days, from plays MUM recorded." label="most played"
      empty={mostPlayed.error ? <p className="text-sm text-destructive">Couldn’t load the most played items.</p>
        : !mostPlayed.data ? <p className="text-sm text-muted-foreground">Loading…</p>
        : mostPlayed.data.length === 0 ? <p className="text-muted-foreground text-center py-4">No plays in the last 30 days.</p> : undefined}>
      {mostPlayed.data?.map(item => <Link key={item.item_id} {...mediaLink(item.item_id)} className="account-recent-item" title={item.title}>
        <div className="account-recent-poster">
          <Poster url={item.poster_url} title={item.title} className="w-full h-full" />
          <div className="account-recent-when">{item.streams.toLocaleString()} {item.streams === 1 ? 'play' : 'plays'}</div>
        </div>
        <div className="mt-2 text-sm font-medium truncate">{item.title}</div>
      </Link>)}
    </PosterCarousel>

    <PosterCarousel icon={faPlus} title="Recently added" description="The newest items in this library." label="recently added"
      empty={recent.error ? <p className="text-sm text-destructive">Couldn’t load the newest items.</p>
        : !recent.data ? <p className="text-sm text-muted-foreground">Loading…</p>
        : recent.data.length === 0 ? <p className="text-muted-foreground text-center py-4">No items yet. Sync this library’s catalogue on the Media tab.</p> : undefined}>
      {recent.data?.map(item => <Link key={item.id} {...mediaLink(item.id)} className="account-recent-item" title={item.added_at ? `Added ${formatTimestamp(item.added_at)}` : item.title}>
        <div className="account-recent-poster">
          <Poster url={item.thumb} title={item.title} className="w-full h-full" />
          {item.added_at && <div className="account-recent-when">Added {formatRelative(item.added_at).replace(/^Just now$/, 'just now')}</div>}
        </div>
        <div className="mt-2 text-sm font-medium truncate" title={item.title}>{item.title}</div>
        {item.year ? <div className="text-xs text-muted-foreground truncate">{item.year}</div> : null}
      </Link>)}
    </PosterCarousel>
  </div>;
}
