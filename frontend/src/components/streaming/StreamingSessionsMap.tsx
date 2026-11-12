import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
// Registers L.markerClusterGroup on the Leaflet namespace imported above.
import 'leaflet.markercluster';
import { Badge } from '@/components/ui/badge';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { getServiceMeta } from '@/config/pluginMetadata';
import { useTheme } from '@/contexts/ThemeContext';
import { useMediaQuery } from '@/store/mediaQueryStore';
import type { ActiveSession } from '@/types/streaming';
import { getStreamingSessionStats } from './sessionStats';
import { faCompress, faExpand, faLocationDot, faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {apiFetch} from '@/util/apiClient';
import {getAccessToken} from '@/store/authStore';
import {Button} from '@/components/ui/button';
import {StreamingMapKeyDialog, useStreamingMapSettings} from '@/components/settings/StreamingMapSettings';

type StreamingSessionsMapProps = {
  sessions: ActiveSession[];
};

type PositionedSession = ActiveSession & {
  mapLat: number;
  mapLon: number;
};

const DEFAULT_CENTER: [number, number] = [20, 0];
const DARK_TILE_URL = '/api/activity/map-tiles/dark/{z}/{x}/{y}';
const LIGHT_TILE_URL = '/api/activity/map-tiles/light/{z}/{x}/{y}';
const TILE_SUBDOMAINS = ['a', 'b', 'c', 'd'];

const SERVICE_COLORS: Record<string, string> = {
  plex: 'var(--color-plex)',
  jellyfin: 'var(--color-jellyfin)',
  emby: 'var(--color-emby)',
  kavita: 'var(--color-kavita)',
  audiobookshelf: 'var(--color-audiobookshelf)',
  komga: 'var(--color-komga)',
  romm: 'var(--color-romm)',
};

const markerIconCache = new Map<string, L.DivIcon>();

const isSameCoordinate = (left: number, right: number) =>
  left === right || (Number.isNaN(left) && Number.isNaN(right));

const isSameMapSession = (left: ActiveSession, right: ActiveSession) => {
  return (
    left.session_key === right.session_key &&
    (left.service_type ?? '') === (right.service_type ?? '') &&
    (left.server_name ?? '') === (right.server_name ?? '') &&
    (left.user ?? '') === (right.user ?? '') &&
    (left.media_title ?? '') === (right.media_title ?? '') &&
    (left.grandparent_title ?? '') === (right.grandparent_title ?? '') &&
    (left.parent_title ?? '') === (right.parent_title ?? '') &&
    (left.user_avatar_url ?? '') === (right.user_avatar_url ?? '') &&
    (left.location_ip ?? '') === (right.location_ip ?? '') &&
    isSameCoordinate(Number(left.latitude), Number(right.latitude)) &&
    isSameCoordinate(Number(left.longitude), Number(right.longitude))
  );
};

const areMapSessionsEqual = (previous: ActiveSession[], next: ActiveSession[]) => {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (!isSameMapSession(previous[index], next[index])) return false;
  }
  return true;
};

const getMarkerColor = (serviceType: string) =>
  SERVICE_COLORS[(serviceType || '').toLowerCase()] ?? 'var(--color-primary)';

const getSessionMarkerIcon = (serviceType: string) => {
  const color = getMarkerColor(serviceType);
  const cached = markerIconCache.get(color);
  if (cached) return cached;

  const icon = L.divIcon({
    className: 'mum-map-session-icon',
    html: `
      <div class="mum-map-dot">
        <span class="mum-map-dot-pulse" style="background:${color};"></span>
        <span class="mum-map-dot-glow" style="background:${color};"></span>
        <span class="mum-map-dot-core" style="background:${color}; box-shadow:0 0 10px ${color};"></span>
      </div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  markerIconCache.set(color, icon);
  return icon;
};

const getClusterServiceColor = (cluster: L.MarkerCluster) => {
  const markers: Array<{ options?: { alt?: string } }> = cluster.getAllChildMarkers?.() ?? [];
  if (!markers.length) return 'var(--color-primary)';

  const counts = new Map<string, number>();
  markers.forEach((marker) => {
    const serviceType = String(marker.options?.alt ?? '').toLowerCase();
    if (!serviceType) return;
    counts.set(serviceType, (counts.get(serviceType) ?? 0) + 1);
  });

  let dominantService = '';
  let dominantCount = 0;
  counts.forEach((count, serviceType) => {
    if (count > dominantCount) {
      dominantService = serviceType;
      dominantCount = count;
    }
  });

  return dominantService ? getMarkerColor(dominantService) : 'var(--color-primary)';
};

const createClusterCustomIcon = (cluster: L.MarkerCluster) => {
  const count = cluster.getChildCount?.() ?? 1;
  const color = getClusterServiceColor(cluster);
  const size = count > 50 ? 46 : count > 10 ? 40 : 34;
  const fontSize = count > 50 ? 15 : count > 10 ? 13 : 12;

  return L.divIcon({
    className: 'mum-map-cluster-icon',
    html: `
      <div class="mum-map-cluster-wrap">
        <span class="mum-map-cluster-pulse" style="background:${color};"></span>
        <span class="mum-map-cluster-ring" style="background:${color};"></span>
        <div class="mum-map-cluster-core" style="width:${size}px; height:${size}px; border-color:${color}; color:${color}; box-shadow:0 0 18px ${color};">
          <span style="font-size:${fontSize}px;">${count}</span>
        </div>
      </div>
    `,
    iconSize: L.point(size, size, true),
    iconAnchor: [size / 2, size / 2],
  });
};

const tryGetSeasonLabel = (parentTitle?: string) => {
  if (!parentTitle) return undefined;

  const seasonMatch = parentTitle.match(/season\s*(\d{1,3})/i);
  if (seasonMatch) return `Season ${Number(seasonMatch[1])}`;

  const compactMatch = parentTitle.match(/\bS(\d{1,3})(?:E\d{1,3})?\b/i);
  if (compactMatch) return `Season ${Number(compactMatch[1])}`;

  return undefined;
};

const SessionPopupContent = ({ session }: { session: ActiveSession }) => {
  const [failedAvatar,setFailedAvatar]=useState<string|null>(null);
  const serviceMeta = getServiceMeta(session.service_type);
  const avatarBgClass = serviceMeta.palette?.avatar ?? 'bg-muted-foreground/20';
  const avatarTextClass = serviceMeta.palette?.avatar ? 'text-white' : 'text-muted-foreground';
  const seasonLabel = tryGetSeasonLabel(session.parent_title);
  const showLine = session.grandparent_title
    ? seasonLabel
      ? `${session.grandparent_title} - ${seasonLabel}`
      : session.grandparent_title
    : null;

  return (
    <div className="min-w-[220px] rounded-lg border border-border/70 bg-card p-3 text-card-foreground shadow-xl">
      <div className="flex items-start gap-2">
        <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-full">
          {session.user_avatar_url && failedAvatar!==session.user_avatar_url ? (
            <img onError={()=>setFailedAvatar(session.user_avatar_url??null)} src={session.user_avatar_url} alt={session.user} className="h-full w-full object-cover" />
          ) : (
            <div className={`flex h-full w-full items-center justify-center font-bold ${avatarBgClass} ${avatarTextClass}`}>
              {session.user?.[0]?.toUpperCase() ?? 'U'}
            </div>
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{session.user || 'Unknown User'}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <ServiceIcon serviceType={session.service_type} className="h-3.5 w-3.5" />
            <span className="truncate">{session.server_name || 'Unknown Server'}</span>
          </div>
        </div>
      </div>

      <div className="mt-2 line-clamp-2 text-sm">{session.media_title || 'Unknown Title'}</div>

      {showLine ? (
        <div className="mt-1 truncate text-xs text-muted-foreground" title={showLine}>
          {showLine}
        </div>
      ) : null}

      <div className="mt-1 text-xs text-muted-foreground">{session.location_ip ?? 'IP unavailable'}</div>
    </div>
  );
};

// Plain Leaflet bindings (Leaflet is BSD-2-Clause). They replace react-leaflet,
// whose Hippocratic licence cannot be combined with MUM's AGPL-3.0 licence.
const LeafletMapContext = createContext<L.Map | null>(null);

const useMap = () => {
  const map = useContext(LeafletMapContext);
  if (!map) throw new Error('useMap must be used inside LeafletMap');
  return map;
};

type LeafletMapProps = {
  center: [number, number];
  zoom: number;
  minZoom: number;
  maxZoom: number;
  style: CSSProperties;
  children: ReactNode;
};

// Like react-leaflet's MapContainer: the map is created once with the initial
// view, and children render inside the map container once the map exists.
const LeafletMap = ({ center, zoom, minZoom, maxZoom, style, children }: LeafletMapProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<L.Map | null>(null);
  const initialViewRef = useRef({ center, zoom, minZoom, maxZoom });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const view = initialViewRef.current;
    const instance = L.map(container, {
      center: view.center,
      zoom: view.zoom,
      minZoom: view.minZoom,
      maxZoom: view.maxZoom,
      scrollWheelZoom: true,
      zoomControl: false,
      attributionControl: false,
    });
    setMap(instance);
    return () => {
      instance.remove();
      setMap(null);
    };
  }, []);

  return (
    <div ref={containerRef} style={style}>
      {map ? <LeafletMapContext.Provider value={map}>{children}</LeafletMapContext.Provider> : null}
    </div>
  );
};

const MapTileLayer = ({ url, attribution, subdomains, onError }: { url: string; attribution: string; subdomains: string[]; onError: () => void }) => {
  const map = useMap();

  useEffect(() => {
    const controllers = new Map<HTMLElement, AbortController>();
    const blobs = new Map<HTMLElement, string>();
    const token = getAccessToken();
    class AuthenticatedTileLayer extends L.TileLayer {
    createTile(coords: L.Coords, done: L.DoneCallback) {
      const img = document.createElement('img');
      img.alt = '';
      const controller = new AbortController();
      controllers.set(img, controller);
      img.onload = () => done?.(undefined, img);
      img.onerror = () => done?.(new Error('Map tile unavailable'), img);
      const path = url.replace('{z}', String(coords.z)).replace('{x}', String(coords.x)).replace('{y}', String(coords.y));
      void apiFetch(path, {signal: controller.signal, retryAuthentication: false}).then(async response => {
        if (!response.ok) throw Error('Map tile unavailable');
        const blob = await response.blob();
        if (controller.signal.aborted || token !== getAccessToken()) return;
        const source = URL.createObjectURL(blob);
        blobs.set(img, source);
        img.src = source;
      }).catch(() => {if (!controller.signal.aborted) done?.(new Error('Map tile unavailable'), img);});
      return img;
    }
    }
    const layer = new AuthenticatedTileLayer(url, { attribution, subdomains });
    layer.on('tileerror', onError);
    layer.on('tileunload', event => {
      controllers.get(event.tile)?.abort(); controllers.delete(event.tile);
      const blob = blobs.get(event.tile); if (blob) URL.revokeObjectURL(blob); blobs.delete(event.tile);
    });
    layer.addTo(map);
    return () => {
      layer.remove();
      controllers.forEach(controller => controller.abort());
      blobs.forEach(blob => URL.revokeObjectURL(blob));
    };
  }, [attribution, map, subdomains, url, onError]);

  return null;
};

type MapMarkerEntry = {
  key: string;
  session: PositionedSession;
  position: [number, number];
};

type OpenPopup = { key: string; node: HTMLElement; popup: L.Popup };

const SessionMarkers = ({ entries, clustered }: { entries: MapMarkerEntry[]; clustered: boolean }) => {
  const map = useMap();
  const groupRef = useRef<L.LayerGroup | null>(null);
  const markersRef = useRef(new Map<string, { marker: L.Marker; position: [number, number]; serviceType: string }>());
  const [openPopup, setOpenPopup] = useState<OpenPopup | null>(null);

  // One layer per mode, matching the previous remount when grouping toggles.
  useEffect(() => {
    const group = clustered
      ? L.markerClusterGroup({
          chunkedLoading: true,
          iconCreateFunction: createClusterCustomIcon,
          maxClusterRadius: 35,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
        })
      : L.layerGroup();
    group.addTo(map);
    groupRef.current = group;
    const markers = markersRef.current;
    return () => {
      group.remove();
      groupRef.current = null;
      markers.clear();
      setOpenPopup(null);
    };
  }, [clustered, map]);

  // Keyed updates keep unchanged markers (and an open popup) across session refreshes.
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const markers = markersRef.current;
    const wanted = new Set(entries.map((entry) => entry.key));
    markers.forEach((value, key) => {
      if (!wanted.has(key)) {
        group.removeLayer(value.marker);
        markers.delete(key);
      }
    });
    entries.forEach((entry) => {
      const serviceType = (entry.session.service_type || '').toLowerCase();
      const existing = markers.get(entry.key);
      if (
        existing &&
        existing.serviceType === serviceType &&
        existing.position[0] === entry.position[0] &&
        existing.position[1] === entry.position[1]
      ) {
        return;
      }
      if (existing) group.removeLayer(existing.marker);
      const marker = L.marker(entry.position, {
        icon: getSessionMarkerIcon(entry.session.service_type),
        alt: serviceType,
      });
      const node = document.createElement('div');
      const popup = L.popup({ className: 'mum-map-popup' }).setContent(node);
      marker.bindPopup(popup);
      marker.on('popupopen', () => setOpenPopup({ key: entry.key, node, popup }));
      marker.on('popupclose', () =>
        setOpenPopup((current) => (current && current.popup === popup ? null : current))
      );
      group.addLayer(marker);
      markers.set(entry.key, { marker, position: entry.position, serviceType });
    });
  }, [entries, clustered]);

  const openSession = openPopup ? entries.find((entry) => entry.key === openPopup.key)?.session : undefined;

  // Re-measure after React fills the popup, as react-leaflet's Popup did.
  useLayoutEffect(() => {
    openPopup?.popup.update();
  }, [openPopup, openSession]);

  return openPopup && openSession ? createPortal(<SessionPopupContent session={openSession} />, openPopup.node) : null;
};

const AutoFit = ({ points, signature }: { points: [number, number][]; signature: string }) => {
  const map = useMap();
  const lastAppliedSignatureRef = useRef<string>('');

  useEffect(() => {
    if (signature === lastAppliedSignatureRef.current) return;
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 6, { animate: true });
      lastAppliedSignatureRef.current = signature;
      return;
    }
    map.fitBounds(points, { padding: [36, 36], maxZoom: 8, animate: true });
    lastAppliedSignatureRef.current = signature;
  }, [map, points, signature]);

  return null;
};

type CustomZoomControlProps = {
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
};

const CustomZoomControl = ({ isFullscreen, onToggleFullscreen }: CustomZoomControlProps) => {
  const map = useMap();

  useEffect(() => {
    map.invalidateSize({ animate: false });
  }, [isFullscreen, map]);

  return (
    <div className="absolute right-3 top-3 z-[500] flex flex-col gap-2">
      <button
        type="button"
        onClick={onToggleFullscreen}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-card text-primary shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors"
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        <FontAwesomeIcon icon={isFullscreen ? faCompress : faExpand} className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => map.zoomIn()}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-card text-primary shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors"
        aria-label="Zoom in"
      >
        <FontAwesomeIcon icon={faPlus} className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => map.zoomOut()}
        className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 bg-card text-primary shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors"
        aria-label="Zoom out"
      >
        <FontAwesomeIcon icon={faMinus} className="h-3 w-3" />
      </button>
    </div>
  );
};

const withJitter = (lat: number, lon: number, index: number): [number, number] => {
  const amount = 0.0001 * ((index % 5) - 2);
  return [lat + amount, lon - amount];
};

const StreamingSessionsMapComponent = ({ sessions }: StreamingSessionsMapProps) => {
  const { theme } = useTheme();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [enableClustering, setEnableClustering] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const mapFrameRef = useRef<HTMLDivElement | null>(null);
  const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  const mapSettings = useStreamingMapSettings();
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [tileFailed, setTileFailed] = useState(false);
  const onTileError = useCallback(() => setTileFailed(true), []);
  useEffect(() => setTileFailed(false), [mapSettings.data?.revision, mapSettings.sessionToken]);
  const tileUrl = (resolvedTheme === 'dark' ? DARK_TILE_URL : LIGHT_TILE_URL) + `?revision=${mapSettings.data?.revision ?? 0}`;

  const validSessions = useMemo<PositionedSession[]>(() => {
    return sessions
      .map((session) => {
        const lat = Number(session.latitude);
        const lon = Number(session.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return {
          ...session,
          mapLat: lat,
          mapLon: lon,
        };
      })
      .filter((session): session is PositionedSession => Boolean(session));
  }, [sessions]);

  const points = useMemo(
    () => validSessions.map((session) => [session.mapLat, session.mapLon] as [number, number]),
    [validSessions]
  );

  const pointsSignature = useMemo(
    () =>
      points
        .map(([lat, lon]) => `${lat.toFixed(4)}:${lon.toFixed(4)}`)
        .sort()
        .join('|'),
    [points]
  );

  const clusteredEntries = useMemo<MapMarkerEntry[]>(
    () =>
      validSessions.map((session) => ({
        key: `${session.session_key}:${session.service_type}:${session.server_name}`,
        session,
        position: [session.mapLat, session.mapLon],
      })),
    [validSessions]
  );

  const spreadEntries = useMemo<MapMarkerEntry[]>(
    () =>
      validSessions.map((session, index) => ({
        key: `${session.session_key}:${session.service_type}:${session.server_name}:${index}`,
        session,
        position: withJitter(session.mapLat, session.mapLon, index),
      })),
    [validSessions]
  );

  const center = points[0] ?? DEFAULT_CENTER;
  const locationCount = validSessions.length;
  const streamStats = useMemo(() => getStreamingSessionStats(sessions), [sessions]);

  const isMapFullscreen = useCallback(() => {
    const host = mapFrameRef.current;
    const fullscreenElement = document.fullscreenElement;
    if (!host || !fullscreenElement) return false;
    return fullscreenElement === host || host.contains(fullscreenElement);
  }, []);

  const isMapExpanded = isFullscreen || isPseudoFullscreen;

  const exitFullscreen = useCallback(async () => {
    if (isMapFullscreen()) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }
    setIsPseudoFullscreen(false);
  }, [isMapFullscreen]);

  const handleToggleFullscreen = useCallback(async () => {
    const host = mapFrameRef.current;
    if (!host) return;

    if (isMapExpanded) {
      await exitFullscreen();
      return;
    }

    try {
      if (typeof host.requestFullscreen === 'function') {
        await host.requestFullscreen();
        return;
      }
    } catch {
      // Fallback below handles browsers like iOS Safari with restricted fullscreen support.
    }

    setIsPseudoFullscreen(true);
  }, [exitFullscreen, isMapExpanded]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(isMapFullscreen());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isMapExpanded) return;
      exitFullscreen().catch(() => undefined);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    onFullscreenChange();
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exitFullscreen, isMapExpanded, isMapFullscreen]);

  useEffect(() => {
    if (!isPseudoFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isPseudoFullscreen]);

  return (
    <Card className="pt-0 gap-0 overflow-hidden border border-border/60 shadow-md">
      <CardHeader className="pt-6 border-b border-border/60 bg-gradient-to-r from-primary/5 via-transparent to-transparent pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-inner">
              <FontAwesomeIcon icon={faLocationDot} className="text-lg" />
            </div>
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-2xl text-foreground">
                Live User Map
                <Badge variant="secondary">{locationCount}</Badge>
              </CardTitle>
              <CardDescription className="text-sm text-muted-foreground space-y-1">
                <p>Approximate stream locations based on active session IP geolocation.</p>
              </CardDescription>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-5">
        {tileFailed && mapSettings.data?.configured && <div role="alert" className="mb-3 space-y-2 text-sm text-muted-foreground">Map tiles could not be loaded. Check your CARTO key, quota and server internet connection. <Button variant="outline" onClick={() => setKeyDialogOpen(true)}>Change map key</Button></div>}
        {!mapSettings.data?.configured ? (
          <div className="relative flex min-h-[280px] items-center justify-center rounded-xl border border-border/60 bg-muted/20 p-6 sm:min-h-[320px]">
            <div className="space-y-3 text-center">
              <p className="font-semibold">{mapSettings.error ? 'Map settings unavailable' : !mapSettings.canConfigure ? 'Live User Map requires administrator access' : !mapSettings.data ? 'Loading map settings...' : 'CARTO map key missing'}</p>
              <p className="text-sm text-muted-foreground">Add a CARTO basemap key to display the map background. Public stream locations will appear when available.</p>
              {mapSettings.canConfigure && <Button onClick={() => setKeyDialogOpen(true)}>Set up map key</Button>}
            </div>
          </div>
        ) : locationCount === 0 ? (
          <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <FontAwesomeIcon icon={faLocationDot} className="text-primary" />
              <span>No map points yet. GeoIP will populate as public session IPs are observed.</span>
            </div>
          </div>
        ) : (
          <div
            ref={mapFrameRef}
            className={isPseudoFullscreen ? 'fixed inset-0 z-[1200] bg-background/95 backdrop-blur-sm' : ''}
            style={
              isPseudoFullscreen
                ? {
                    paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
                    paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
                    paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
                    paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
                  }
                : undefined
            }
          >
            <div
              // Keep Leaflet panes/controls below portalled dialogs and sheets.
              style={{ isolation: 'isolate' }}
              className={`relative overflow-hidden border border-border/60 ${
                isMapExpanded ? 'h-full rounded-xl bg-card shadow-lg' : 'rounded-xl'
              }`}
            >
              {isMapExpanded ? (
                <div className="pointer-events-none absolute left-3 top-3 z-[550] flex items-center gap-2">
                  <div className="rounded-md border border-border/60 bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Active Streams
                    </p>
                    <p className="text-sm font-bold text-foreground">{streamStats.totalSessions}</p>
                  </div>
                  <div className="rounded-md border border-border/60 bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Bandwidth
                    </p>
                    <p className="text-sm font-bold text-foreground">
                      {streamStats.totalBandwidthMbps.toFixed(1)} Mbps
                    </p>
                  </div>
                </div>
              ) : null}

              {isMapExpanded ? (
                <button
                  type="button"
                  onClick={() => {
                    exitFullscreen().catch(() => undefined);
                  }}
                  className="absolute bottom-3 right-3 z-[550] flex h-8 items-center gap-2 rounded-md border border-border/60 bg-card px-3 text-xs font-medium text-primary shadow-sm hover:bg-primary hover:text-primary-foreground transition-colors"
                  aria-label="Exit fullscreen"
                >
                  <FontAwesomeIcon icon={faCompress} className="h-3 w-3" />
                  <span>Exit</span>
                </button>
              ) : null}

              <div className="absolute bottom-3 left-3 z-[550] rounded-md border border-border/60 bg-card/95 px-3 py-1.5 shadow-sm backdrop-blur">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-medium text-muted-foreground">Group</span>
                  <Switch
                    checked={enableClustering}
                    onCheckedChange={setEnableClustering}
                    aria-label="Toggle grouped map markers"
                  />
                </div>
              </div>

              <div className={isMapExpanded ? 'h-full w-full' : 'h-[280px] w-full sm:h-[320px]'}>
                <LeafletMap
                  center={center}
                  zoom={3}
                  minZoom={2}
                  maxZoom={12}
                  style={{ height: '100%', width: '100%', background: 'var(--card)' }}
                >
                  <AutoFit points={points} signature={pointsSignature} />
                  <CustomZoomControl isFullscreen={isMapExpanded} onToggleFullscreen={handleToggleFullscreen} />
                  <MapTileLayer
                    key={`${resolvedTheme}:${mapSettings.data.revision}:${mapSettings.sessionToken}`}
                    url={tileUrl}
                    attribution="&copy; OpenStreetMap &copy; CARTO"
                    subdomains={TILE_SUBDOMAINS}
                    onError={onTileError}
                  />

                  <SessionMarkers
                    entries={enableClustering ? clusteredEntries : spreadEntries}
                    clustered={enableClustering}
                  />

                  <style>{`
                    @keyframes mum-map-dot-pulse {
                      0% { transform: scale(0.85); opacity: 0.5; }
                      70% { transform: scale(1.6); opacity: 0; }
                      100% { transform: scale(1.6); opacity: 0; }
                    }

                    @keyframes mum-map-cluster-pulse {
                      0% { transform: scale(0.95); opacity: 0.35; }
                      70% { transform: scale(1.2); opacity: 0; }
                      100% { transform: scale(1.2); opacity: 0; }
                    }

                    .mum-map-dot {
                      position: relative;
                      width: 20px;
                      height: 20px;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    }

                    .mum-map-dot-pulse {
                      position: absolute;
                      width: 100%;
                      height: 100%;
                      border-radius: 9999px;
                      animation: mum-map-dot-pulse 2.1s ease-out infinite;
                    }

                    .mum-map-dot-glow {
                      position: absolute;
                      width: 10px;
                      height: 10px;
                      border-radius: 9999px;
                      opacity: 0.45;
                      filter: blur(1.5px);
                    }

                    .mum-map-dot-core {
                      position: relative;
                      width: 7px;
                      height: 7px;
                      border-radius: 9999px;
                      border: 1px solid rgba(255, 255, 255, 0.45);
                    }

                    .mum-map-cluster-wrap {
                      position: relative;
                      width: 100%;
                      height: 100%;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                    }

                    .mum-map-cluster-pulse {
                      position: absolute;
                      width: 100%;
                      height: 100%;
                      border-radius: 9999px;
                      opacity: 0.24;
                      animation: mum-map-cluster-pulse 2.2s ease-out infinite;
                    }

                    .mum-map-cluster-ring {
                      position: absolute;
                      width: 112%;
                      height: 112%;
                      border-radius: 9999px;
                      opacity: 0.14;
                    }

                    .mum-map-cluster-core {
                      position: relative;
                      border-radius: 9999px;
                      background: color-mix(in hsl, hsl(var(--card)) 82%, black 18%);
                      border: 2px solid;
                      display: flex;
                      align-items: center;
                      justify-content: center;
                      font-weight: 700;
                      line-height: 1;
                      backdrop-filter: blur(4px);
                      transition: transform 160ms ease;
                    }

                    .mum-map-cluster-wrap:hover .mum-map-cluster-core {
                      transform: scale(1.06);
                    }

                    .leaflet-marker-icon.mum-map-cluster-icon {
                      background: transparent;
                      border: none;
                    }

                    .leaflet-popup.mum-map-popup .leaflet-popup-content-wrapper,
                    .leaflet-popup.mum-map-popup .leaflet-popup-tip {
                      background: transparent;
                      box-shadow: none;
                      padding: 0;
                    }

                    .leaflet-popup.mum-map-popup .leaflet-popup-content {
                      margin: 0;
                    }
                  `}</style>
                </LeafletMap>
              </div>
            </div>
          </div>
        )}
      </CardContent>
      <StreamingMapKeyDialog open={keyDialogOpen} onClose={() => setKeyDialogOpen(false)} />
    </Card>
  );
};

const areStreamingSessionsMapPropsEqual = (
  previousProps: StreamingSessionsMapProps,
  nextProps: StreamingSessionsMapProps
) => areMapSessionsEqual(previousProps.sessions, nextProps.sessions);

export const StreamingSessionsMap = memo(StreamingSessionsMapComponent, areStreamingSessionsMapPropsEqual);
StreamingSessionsMap.displayName = 'StreamingSessionsMap';
