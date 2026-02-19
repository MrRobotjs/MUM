import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import MarkerClusterGroup from 'react-leaflet-cluster';
import { Badge } from '@/components/ui/badge';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useTheme } from '@/contexts/ThemeContext';
import { useMediaQuery } from '@/store/mediaQueryStore';
import type { ActiveSession } from '@/types/streaming';
import { getStreamingSessionStats } from './sessionStats';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import { faCompress, faExpand, faLocationDot, faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

type StreamingSessionsMapProps = {
  sessions: ActiveSession[];
};

type PositionedSession = ActiveSession & {
  mapLat: number;
  mapLon: number;
};

const DEFAULT_CENTER: [number, number] = [20, 0];
const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const LIGHT_TILE_URL = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

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

const getClusterServiceColor = (cluster: any) => {
  const markers: Array<{ options?: { title?: string } }> = cluster.getAllChildMarkers?.() ?? [];
  if (!markers.length) return 'var(--color-primary)';

  const counts = new Map<string, number>();
  markers.forEach((marker) => {
    const serviceType = String(marker.options?.title ?? '').toLowerCase();
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

const createClusterCustomIcon = (cluster: any) => {
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

export const StreamingSessionsMap = ({ sessions }: StreamingSessionsMapProps) => {
  const { theme } = useTheme();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const [enableClustering, setEnableClustering] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPseudoFullscreen, setIsPseudoFullscreen] = useState(false);
  const mapFrameRef = useRef<HTMLDivElement | null>(null);
  const resolvedTheme = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  const tileUrl = resolvedTheme === 'dark' ? DARK_TILE_URL : LIGHT_TILE_URL;

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
        {locationCount === 0 ? (
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
                <MapContainer
                  center={center}
                  zoom={3}
                  minZoom={2}
                  maxZoom={12}
                  scrollWheelZoom
                  style={{ height: '100%', width: '100%', background: 'hsl(var(--card))' }}
                  zoomControl={false}
                  attributionControl={false}
                >
                  <AutoFit points={points} signature={pointsSignature} />
                  <CustomZoomControl isFullscreen={isMapExpanded} onToggleFullscreen={handleToggleFullscreen} />
                  <TileLayer
                    key={resolvedTheme}
                    url={tileUrl}
                    attribution="&copy; OpenStreetMap &copy; CARTO"
                    subdomains={['a', 'b', 'c', 'd']}
                  />

                  {enableClustering ? (
                    <MarkerClusterGroup
                      chunkedLoading
                      iconCreateFunction={createClusterCustomIcon}
                      maxClusterRadius={35}
                      spiderfyOnMaxZoom
                      showCoverageOnHover={false}
                    >
                      {validSessions.map((session) => (
                        <Marker
                          key={`${session.session_key}:${session.service_type}:${session.server_name}`}
                          position={[session.mapLat, session.mapLon]}
                          icon={getSessionMarkerIcon(session.service_type)}
                          title={(session.service_type || '').toLowerCase()}
                        >
                          <Popup>
                            <div className="min-w-[180px] space-y-1 text-sm">
                              <div className="flex items-center gap-2 font-semibold">
                                <ServiceIcon serviceType={session.service_type} className="h-3.5 w-3.5" />
                                <span>{session.user}</span>
                              </div>
                              <div className="text-xs text-muted-foreground">{session.media_title}</div>
                              <div className="text-xs text-muted-foreground">
                                {session.server_name} · {session.service_type.toUpperCase()}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {session.location_ip ?? 'IP unavailable'}
                              </div>
                            </div>
                          </Popup>
                        </Marker>
                      ))}
                    </MarkerClusterGroup>
                  ) : (
                    validSessions.map((session, index) => {
                      const [lat, lon] = withJitter(session.mapLat, session.mapLon, index);
                      return (
                        <Marker
                          key={`${session.session_key}:${session.service_type}:${session.server_name}:${index}`}
                          position={[lat, lon]}
                          icon={getSessionMarkerIcon(session.service_type)}
                          title={(session.service_type || '').toLowerCase()}
                        >
                          <Popup>
                            <div className="min-w-[180px] space-y-1 text-sm">
                              <div className="flex items-center gap-2 font-semibold">
                                <ServiceIcon serviceType={session.service_type} className="h-3.5 w-3.5" />
                                <span>{session.user}</span>
                              </div>
                              <div className="text-xs text-muted-foreground">{session.media_title}</div>
                              <div className="text-xs text-muted-foreground">
                                {session.server_name} · {session.service_type.toUpperCase()}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {session.location_ip ?? 'IP unavailable'}
                              </div>
                            </div>
                          </Popup>
                        </Marker>
                      );
                    })
                  )}

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
                  `}</style>
                </MapContainer>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
