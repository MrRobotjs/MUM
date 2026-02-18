import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import type { ActiveSession } from '@/types/streaming';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import { faCompress, faExpand, faLocationDot, faMinus, faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

type StreamingSessionsMapProps = {
  sessions: ActiveSession[];
};

type PositionedSession = ActiveSession & {
  mapLat: number;
  mapLon: number;
};

type SessionCluster = {
  sessions: PositionedSession[];
  mapLat: number;
  mapLon: number;
};

const DEFAULT_CENTER: [number, number] = [20, 0];
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const CLUSTER_DISTANCE_DEGREES = 0.18;
const MAX_CLUSTER_ITEMS = 6;

const SERVICE_COLORS: Record<string, string> = {
  plex: 'var(--color-plex)',
  jellyfin: 'var(--color-jellyfin)',
  emby: 'var(--color-emby)',
  kavita: 'var(--color-kavita)',
  audiobookshelf: 'var(--color-audiobookshelf)',
  komga: 'var(--color-komga)',
  romm: 'var(--color-romm)',
};

const getMarkerColor = (serviceType: string) =>
  SERVICE_COLORS[(serviceType || '').toLowerCase()] ?? 'var(--color-primary)';

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
  const amount = 0.00012 * ((index % 5) - 2);
  return [lat + amount, lon - amount];
};

const distanceDegrees = (aLat: number, aLon: number, bLat: number, bLon: number) => {
  const meanLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const latDiff = aLat - bLat;
  const lonDiff = (aLon - bLon) * Math.cos(meanLat);
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
};

const clusterSessions = (sessions: PositionedSession[]): SessionCluster[] => {
  const clusters: SessionCluster[] = [];

  sessions.forEach((session) => {
    let matchedCluster: SessionCluster | null = null;
    for (const cluster of clusters) {
      if (
        distanceDegrees(session.mapLat, session.mapLon, cluster.mapLat, cluster.mapLon) <=
        CLUSTER_DISTANCE_DEGREES
      ) {
        matchedCluster = cluster;
        break;
      }
    }

    if (!matchedCluster) {
      clusters.push({
        sessions: [session],
        mapLat: session.mapLat,
        mapLon: session.mapLon,
      });
      return;
    }

    matchedCluster.sessions.push(session);
    const count = matchedCluster.sessions.length;
    matchedCluster.mapLat = ((matchedCluster.mapLat * (count - 1)) + session.mapLat) / count;
    matchedCluster.mapLon = ((matchedCluster.mapLon * (count - 1)) + session.mapLon) / count;
  });

  return clusters;
};

export const StreamingSessionsMap = ({ sessions }: StreamingSessionsMapProps) => {
  const [enableClustering, setEnableClustering] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const mapFrameRef = useRef<HTMLDivElement | null>(null);

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

  const visibleSessions = validSessions;

  const clusters = useMemo(
    () => (enableClustering ? clusterSessions(visibleSessions) : []),
    [enableClustering, visibleSessions]
  );

  const points = useMemo(() => {
    if (enableClustering) {
      return clusters.map((cluster) => [cluster.mapLat, cluster.mapLon] as [number, number]);
    }
    return visibleSessions.map((session) => [session.mapLat, session.mapLon] as [number, number]);
  }, [clusters, enableClustering, visibleSessions]);

  const pointsSignature = useMemo(
    () =>
      points
        .map(([lat, lon]) => `${lat.toFixed(4)}:${lon.toFixed(4)}`)
        .sort()
        .join('|'),
    [points]
  );

  const center = points[0] ?? DEFAULT_CENTER;
  const locationCount = visibleSessions.length;
  const clusterCount = enableClustering ? clusters.filter((cluster) => cluster.sessions.length > 1).length : 0;

  const isMapFullscreen = useCallback(() => {
    const host = mapFrameRef.current;
    const fullscreenElement = document.fullscreenElement;
    if (!host || !fullscreenElement) return false;
    return fullscreenElement === host || host.contains(fullscreenElement);
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    const host = mapFrameRef.current;
    if (!host) return;

    try {
      if (isMapFullscreen()) {
        await document.exitFullscreen();
      } else {
        await host.requestFullscreen();
      }
    } catch {
      // No-op: browser may reject fullscreen outside direct gesture.
    }
  }, [isMapFullscreen]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(isMapFullscreen());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!isMapFullscreen()) return;
      document.exitFullscreen().catch(() => undefined);
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeyDown);
    onFullscreenChange();
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isMapFullscreen]);

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
                {enableClustering && clusterCount > 0 ? (
                  <p className="font-mono text-xs text-primary/80">
                    Clusters active: {clusterCount}
                  </p>
                ) : null}
              </CardDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-md border border-border/60 bg-background/70 px-3 py-1.5">
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Cluster markers</span>
                <Switch checked={enableClustering} onCheckedChange={setEnableClustering} />
              </div>
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
          <div ref={mapFrameRef} className="overflow-hidden rounded-xl border border-border/60">
            <div className="h-[280px] w-full sm:h-[320px]">
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
                <CustomZoomControl
                  isFullscreen={isFullscreen}
                  onToggleFullscreen={handleToggleFullscreen}
                />
                <TileLayer
                  url={TILE_URL}
                  attribution="&copy; OpenStreetMap &copy; CARTO"
                  subdomains={['a', 'b', 'c', 'd']}
                />

                {enableClustering
                  ? clusters.map((cluster, index) => {
                      const count = cluster.sessions.length;
                      const primary = cluster.sessions[0];
                      const color =
                        count > 1 ? 'var(--color-primary)' : getMarkerColor(primary.service_type);
                      const radius = count > 1 ? Math.min(18, 8 + Math.log2(count + 1) * 3) : 8;

                      return (
                        <CircleMarker
                          key={`cluster:${index}:${cluster.mapLat}:${cluster.mapLon}`}
                          center={[cluster.mapLat, cluster.mapLon]}
                          radius={radius}
                          pathOptions={{
                            color,
                            fillColor: color,
                            fillOpacity: count > 1 ? 0.6 : 0.72,
                            weight: 2,
                          }}
                        >
                          <Popup>
                            {count === 1 ? (
                              <div className="min-w-[180px] space-y-1 text-sm">
                                <div className="flex items-center gap-2 font-semibold">
                                  <ServiceIcon serviceType={primary.service_type} className="h-3.5 w-3.5" />
                                  <span>{primary.user}</span>
                                </div>
                                <div className="text-xs text-muted-foreground">{primary.media_title}</div>
                                <div className="text-xs text-muted-foreground">
                                  {primary.server_name} · {primary.service_type.toUpperCase()}
                                </div>
                                <div className="text-xs text-muted-foreground">
                                  {primary.location_ip ?? 'IP unavailable'}
                                </div>
                              </div>
                            ) : (
                              <div className="min-w-[220px] space-y-2 text-sm">
                                <div className="font-semibold">{count} nearby sessions</div>
                                <div className="space-y-1">
                                  {cluster.sessions.slice(0, MAX_CLUSTER_ITEMS).map((session) => (
                                    <div
                                      key={`${session.session_key}:${session.service_type}:${session.server_name}`}
                                      className="flex items-center gap-2 text-xs"
                                    >
                                      <ServiceIcon serviceType={session.service_type} className="h-3.5 w-3.5" />
                                      <span className="truncate">
                                        {session.user} · {session.media_title}
                                      </span>
                                    </div>
                                  ))}
                                  {count > MAX_CLUSTER_ITEMS ? (
                                    <div className="text-xs text-muted-foreground">
                                      +{count - MAX_CLUSTER_ITEMS} more
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            )}
                          </Popup>
                        </CircleMarker>
                      );
                    })
                  : visibleSessions.map((session, index) => {
                      const [lat, lon] = withJitter(session.mapLat, session.mapLon, index);
                      const color = getMarkerColor(session.service_type);
                      return (
                        <CircleMarker
                          key={`${session.session_key}:${session.service_type}:${session.server_name}:${index}`}
                          center={[lat, lon]}
                          radius={8}
                          pathOptions={{
                            color,
                            fillColor: color,
                            fillOpacity: 0.72,
                            weight: 2,
                          }}
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
                        </CircleMarker>
                      );
                    })}
              </MapContainer>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
