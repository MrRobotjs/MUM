import { useEffect, useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ServiceIcon } from '@/components/services/ServiceIcon';
import type { ActiveSession } from '@/types/streaming';
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from 'react-leaflet';
import { faLocationDot } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';

type StreamingSessionsMapProps = {
  sessions: ActiveSession[];
};

type PositionedSession = ActiveSession & {
  mapLat: number;
  mapLon: number;
};

const DEFAULT_CENTER: [number, number] = [20, 0];
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';

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

const AutoFit = ({ points }: { points: [number, number][] }) => {
  const map = useMap();

  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 6, { animate: true });
      return;
    }
    map.fitBounds(points, { padding: [36, 36], maxZoom: 8, animate: true });
  }, [map, points]);

  return null;
};

const withJitter = (lat: number, lon: number, index: number): [number, number] => {
  const amount = 0.00012 * ((index % 5) - 2);
  return [lat + amount, lon - amount];
};

export const StreamingSessionsMap = ({ sessions }: StreamingSessionsMapProps) => {
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

  const points = useMemo(() => validSessions.map((session) => [session.mapLat, session.mapLon] as [number, number]), [validSessions]);
  const center = points[0] ?? DEFAULT_CENTER;

  if (!validSessions.length) {
    return (
      <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 p-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <FontAwesomeIcon icon={faLocationDot} className="text-primary" />
          <span>No map points yet. GeoIP will populate as public session IPs are observed.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-primary/10 to-transparent px-4 py-2 text-xs text-muted-foreground">
        <span>Live User Map</span>
        <Badge variant="secondary">{validSessions.length} located</Badge>
      </div>
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
          <AutoFit points={points} />
          <TileLayer
            url={TILE_URL}
            attribution='&copy; OpenStreetMap &copy; CARTO'
            subdomains={['a', 'b', 'c', 'd']}
          />
          {validSessions.map((session, index) => {
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
                    <div className="text-xs text-muted-foreground">{session.location_ip ?? 'IP unavailable'}</div>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
      </div>
    </div>
  );
};
