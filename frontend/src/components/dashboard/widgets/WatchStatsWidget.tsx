import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { useAdminApi } from '@/hooks/useAdminApi';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChrome,
  faFirefoxBrowser,
  faSafari,
  faEdge,
  faAndroid,
  faApple,
  faWindows,
  faOpera,
} from '@fortawesome/free-brands-svg-icons';
import {
  faDesktop,
  faFilm,
  faMobileScreenButton,
  faRotate,
  faTabletScreenButton,
  faTv,
} from '@fortawesome/free-solid-svg-icons';
import { IconDeviceTv, IconMovie } from '@tabler/icons-react';
import { BentoTile, BentoTileBody, BentoTileFooter, BentoTileHeader } from '../bento';

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

type MediaItem = {
  title?: string;
  name?: string;
  plays: number;
  duration: string;
  poster_url?: string;
};

const getPlatformIcon = (platform: string) => {
  const platformLower = platform.toLowerCase();

  if (platformLower.includes('chrome')) return <FontAwesomeIcon icon={faChrome} className="h-5 w-5" />;
  if (platformLower.includes('firefox')) {
    return <FontAwesomeIcon icon={faFirefoxBrowser} className="h-5 w-5" />;
  }
  if (platformLower.includes('safari')) return <FontAwesomeIcon icon={faSafari} className="h-5 w-5" />;
  if (platformLower.includes('edge')) return <FontAwesomeIcon icon={faEdge} className="h-5 w-5" />;
  if (platformLower.includes('opera')) return <FontAwesomeIcon icon={faOpera} className="h-5 w-5" />;
  if (platformLower.includes('android')) return <FontAwesomeIcon icon={faAndroid} className="h-5 w-5" />;
  if (
    platformLower.includes('ios') ||
    platformLower.includes('iphone') ||
    platformLower.includes('ipad') ||
    platformLower.includes('macos') ||
    platformLower.includes('mac os')
  ) {
    return <FontAwesomeIcon icon={faApple} className="h-5 w-5" />;
  }
  if (platformLower.includes('windows')) return <FontAwesomeIcon icon={faWindows} className="h-5 w-5" />;
  if (platformLower.includes('mobile') || platformLower.includes('phone')) {
    return <FontAwesomeIcon icon={faMobileScreenButton} className="h-5 w-5" />;
  }
  if (platformLower.includes('tablet')) {
    return <FontAwesomeIcon icon={faTabletScreenButton} className="h-5 w-5" />;
  }

  return <FontAwesomeIcon icon={faDesktop} className="h-5 w-5" />;
};

const TotalsSkeleton = () => (
  <div className="grid gap-3 sm:grid-cols-3">
    {Array.from({ length: 3 }).map((_, index) => (
      <div key={index} className="h-[72px] animate-pulse rounded-md border border-border bg-muted" />
    ))}
  </div>
);

const ColumnSkeleton = () => (
  <div className="space-y-2">
    {Array.from({ length: 4 }).map((_, index) => (
      <div key={index} className="h-14 animate-pulse rounded-md border border-border bg-muted" />
    ))}
  </div>
);

const StatBlock = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-md border border-border bg-background px-4 py-3">
    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
    <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
  </div>
);

const MediaList = ({
  items,
  type,
  emptyLabel,
}: {
  items: MediaItem[];
  type: 'movie' | 'show';
  emptyLabel: string;
}) => {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item, index) => {
        const title = item.title ?? item.name ?? 'Unknown';

        return (
          <li
            key={`${title}-${index}`}
            className="flex items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2"
          >
            <Avatar className="h-11 w-11 shrink-0 rounded-md border border-border">
              <AvatarImage src={item.poster_url || ''} alt={title} className="object-cover" />
              <AvatarFallback className="rounded-md bg-muted text-muted-foreground">
                {type === 'movie' ? (
                  <FontAwesomeIcon icon={faFilm} className="h-4 w-4" />
                ) : (
                  <FontAwesomeIcon icon={faTv} className="h-4 w-4" />
                )}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{title}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {item.plays} plays · {item.duration}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
};

const PlatformList = ({ items }: { items: Array<{ name: string; plays: number; duration: string }> }) => {
  if (items.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        No platform data for this period.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li
          key={`${item.name}-${index}`}
          className="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
            {getPlatformIcon(item.name)}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {item.plays} plays · {item.duration}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
};

const WatchColumn = ({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) => (
  <section className="flex min-h-0 flex-col gap-3">
    <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
      {icon}
      {title}
    </h3>
    {children}
  </section>
);

export const WatchStatsWidget = () => {
  const { data, loading, error, mutate } = useAdminApi<WatchStatsResponse>(
    '/statistics/watch?days=7',
  );

  const totals = data?.data.totals;
  const topMovies = data?.data.top_movies ?? [];
  const topShows = data?.data.top_shows ?? [];
  const topPlatforms = data?.data.top_platforms ?? [];
  const isEmptyDataset = !loading && !error && (totals?.total_plays ?? 0) === 0;

  return (
    <BentoTile span={{ col: 12, mdCol: 6 }} label="Watch statistics">
      <BentoTileHeader
        title="Watch statistics"
        description="Top titles and platforms over the last 7 days."
        action={
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => mutate()} disabled={loading}>
            <FontAwesomeIcon icon={faRotate} className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        }
      />

      <BentoTileBody className="gap-6">
        {loading ? (
          <>
            <TotalsSkeleton />
            <div className="grid gap-6 lg:grid-cols-3">
              <ColumnSkeleton />
              <ColumnSkeleton />
              <ColumnSkeleton />
            </div>
          </>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            Failed to load watch statistics: {error}
          </div>
        ) : data ? (
          <>
            {isEmptyDataset ? (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No watch activity in the last 7 days. Statistics will appear after users start streaming.
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-3">
              <StatBlock label="Total plays" value={totals?.total_plays ?? 0} />
              <StatBlock label="Total duration" value={totals?.total_duration ?? '0 min'} />
              <StatBlock label="Avg session" value={totals?.avg_session_length ?? '0 min'} />
            </div>

            <div className="grid gap-6 lg:grid-cols-3">
              <WatchColumn
                title="Top movies"
                icon={<IconMovie className="h-4 w-4 text-muted-foreground" stroke={1.75} />}
              >
                <MediaList items={topMovies} type="movie" emptyLabel="No movie plays recorded." />
              </WatchColumn>

              <WatchColumn
                title="Top shows"
                icon={<IconDeviceTv className="h-4 w-4 text-muted-foreground" stroke={1.75} />}
              >
                <MediaList items={topShows} type="show" emptyLabel="No show plays recorded." />
              </WatchColumn>

              <WatchColumn
                title="Top platforms"
                icon={<FontAwesomeIcon icon={faDesktop} className="h-4 w-4 text-muted-foreground" />}
              >
                <PlatformList items={topPlatforms} />
              </WatchColumn>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No watch data available.</p>
        )}
      </BentoTileBody>

      {totals && !loading && !error && (totals.total_plays ?? 0) > 0 ? (
        <BentoTileFooter>
          <p className="text-xs text-muted-foreground">
            {totals.unique_users} unique viewers · {totals.unique_titles} unique titles · peak day{' '}
            {totals.peak_day_streams} streams
          </p>
        </BentoTileFooter>
      ) : null}
    </BentoTile>
  );
};
