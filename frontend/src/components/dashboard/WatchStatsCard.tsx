import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAdminApi } from '../../hooks/useAdminApi';
import { DashboardCard } from './DashboardLayout';
// Images use cookie-based auth; no token param needed
import {
  IconRefresh,
  IconMovie,
  IconDeviceTv,
  IconTrendingUp,
  IconBrandChrome,
  IconBrandFirefox,
  IconBrandSafari,
  IconBrandEdge,
  IconBrandAndroid,
  IconBrandApple,
  IconBrandWindows,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDeviceTablet,
  IconBrandOpera
} from '@tabler/icons-react';

type WatchStatsResponse = {
  data: {
    top_movies: Array<{ title: string; plays: number; duration: string; poster_url?: string }>;
    top_shows: Array<{ title: string; plays: number; duration: string; poster_url?: string }>;
    top_platforms: Array<{ name: string; plays: number; duration: string }>;
    totals: {
      total_plays: number;
      total_duration: string;
      unique_titles: number;
      unique_users: number;
      avg_session_length: string;
      peak_day_streams: number;
    };
  };
};

const getPlatformIcon = (platform: string) => {
  const platformLower = platform.toLowerCase();

  // Browsers
  if (platformLower.includes('chrome')) return <IconBrandChrome className="h-5 w-5" />;
  if (platformLower.includes('firefox')) return <IconBrandFirefox className="h-5 w-5" />;
  if (platformLower.includes('safari')) return <IconBrandSafari className="h-5 w-5" />;
  if (platformLower.includes('edge')) return <IconBrandEdge className="h-5 w-5" />;
  if (platformLower.includes('opera')) return <IconBrandOpera className="h-5 w-5" />;

  // Operating Systems / Devices
  if (platformLower.includes('android')) return <IconBrandAndroid className="h-5 w-5" />;
  if (platformLower.includes('ios') || platformLower.includes('iphone') || platformLower.includes('ipad')) {
    return <IconBrandApple className="h-5 w-5" />;
  }
  if (platformLower.includes('macos') || platformLower.includes('mac os')) return <IconBrandApple className="h-5 w-5" />;
  if (platformLower.includes('windows')) return <IconBrandWindows className="h-5 w-5" />;

  // Device types
  if (platformLower.includes('mobile') || platformLower.includes('phone')) return <IconDeviceMobile className="h-5 w-5" />;
  if (platformLower.includes('tablet') || platformLower.includes('ipad')) return <IconDeviceTablet className="h-5 w-5" />;

  // Default
  return <IconDeviceDesktop className="h-5 w-5" />;
};

const MediaList = ({ items, type }: { items: Array<{ title?: string; name?: string; plays: number; duration: string; poster_url?: string }>; type: 'movie' | 'show' }) => (
  <ul className="space-y-3">
    {items.map((item, index) => {
      const title = item.title ?? item.name ?? 'Unknown';
      const initials = title.substring(0, 2).toUpperCase();

      return (
        <li key={index} className="flex items-center gap-3 rounded-lg border bg-card p-2 transition-colors hover:bg-accent/50">
          <Avatar className="h-12 w-12 rounded-md">
            <AvatarImage src={item.poster_url || ''} alt={title} className="object-cover" />
            <AvatarFallback className="rounded-md bg-primary/10 text-primary">
              {type === 'movie' ? <IconMovie className="h-5 w-5" /> : <IconDeviceTv className="h-5 w-5" />}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate text-sm">{title}</p>
            <p className="text-xs text-muted-foreground">{item.plays} plays · {item.duration}</p>
          </div>
          <IconTrendingUp className="h-4 w-4 text-muted-foreground shrink-0" />
        </li>
      );
    })}
  </ul>
);

const PlatformList = ({ items }: { items: Array<{ name: string; plays: number; duration: string }> }) => (
  <ul className="space-y-2">
    {items.map((item, index) => (
      <li key={index} className="flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/50">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {getPlatformIcon(item.name)}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{item.name}</p>
          <p className="text-xs text-muted-foreground">{item.plays} plays · {item.duration}</p>
        </div>
      </li>
    ))}
  </ul>
);

export const WatchStatsCard = () => {
  const { data, loading, error, mutate } = useAdminApi<WatchStatsResponse>('/statistics/watch?days=7');

  return (
    <DashboardCard title="Watch Statistics (7 days)">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          Calculating watch stats…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load watch statistics: {error}
        </div>
      ) : data ? (
        <div className="space-y-6">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-gradient-to-br from-primary/10 to-primary/5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Total Plays</p>
              <p className="text-2xl font-bold mt-1">{data.data.totals.total_plays}</p>
            </div>
            <div className="rounded-lg border bg-gradient-to-br from-blue-500/10 to-blue-500/5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Total Duration</p>
              <p className="text-2xl font-bold mt-1">{data.data.totals.total_duration}</p>
            </div>
            <div className="rounded-lg border bg-gradient-to-br from-green-500/10 to-green-500/5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Avg Session</p>
              <p className="text-2xl font-bold mt-1">{data.data.totals.avg_session_length}</p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <IconMovie className="h-4 w-4 text-primary" />
                Top Movies
              </h3>
              <MediaList items={data.data.top_movies} type="movie" />
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <IconDeviceTv className="h-4 w-4 text-primary" />
                Top Shows
              </h3>
              <MediaList items={data.data.top_shows} type="show" />
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Top Platforms</h3>
              <PlatformList items={data.data.top_platforms} />
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No watch data available.</p>
      )}

      <div className="flex justify-end pt-4">
        <Button variant="ghost" size="sm" onClick={() => mutate()}>
          <IconRefresh className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>
    </DashboardCard>
  );
};
