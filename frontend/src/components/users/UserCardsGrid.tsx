import { useMemo } from 'react';
import { UserCard, type UserNowPlaying } from './UserCard';
import { Pagination } from '../common/Pagination';
import type { UserRow } from './UsersTable';
import { Skeleton } from '../ui/skeleton';
import { Card, CardContent } from '../ui/card';
import { useStreamingWebSocket } from '../../hooks/useStreamingWebSocket';
import type { UnifiedSession } from '../../types/realtime';

interface UserCardsGridProps {
  users: UserRow[];
  loading?: boolean;
  selectedUserIds?: Set<string>;
  onToggleSelection?: (userId: string) => void;
  currentPage?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
}

const UserCardSkeleton = () => (
  <Card className="shadow-lg">
    <CardContent className="p-4">
      <div className="flex flex-row items-center mb-3">
        <Skeleton className="w-10 h-10 rounded-full mr-3" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <div className="mt-3 flex gap-1">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>
    </CardContent>
  </Card>
);

const getSessionPriority = (state?: string) => {
  const normalized = state?.toLowerCase();
  if (normalized === 'playing' || normalized === 'listening') return 4;
  if (normalized === 'buffering') return 3;
  if (normalized === 'paused') return 2;
  if (normalized) return 1;
  return 0;
};

export const UserCardsGrid = ({
  users,
  loading,
  selectedUserIds = new Set(),
  onToggleSelection,
  currentPage = 1,
  totalPages = 1,
  onPageChange
}: UserCardsGridProps) => {
  const { lastSessionData } = useStreamingWebSocket({ autoConnect: false });
  const nowPlayingByUser = useMemo(() => {
    const sessions = lastSessionData?.sessions ?? [];
    const nowPlaying = new Map<string, UserNowPlaying>();
    if (!sessions.length) {
      return nowPlaying;
    }

    const grouped = new Map<string, UnifiedSession[]>();
    sessions.forEach((session) => {
      const userUuid = session.user?.uuid;
      if (!userUuid) {
        return;
      }
      const key = String(userUuid);
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(session);
      } else {
        grouped.set(key, [session]);
      }
    });

    grouped.forEach((userSessions, userUuid) => {
      const sorted = [...userSessions].sort(
        (left, right) => getSessionPriority(right.state) - getSessionPriority(left.state)
      );
      const primary = sorted[0];
      if (!primary) {
        return;
      }
      nowPlaying.set(userUuid, {
        state: primary.state ?? 'unknown',
        mediaTitle: primary.item?.title ?? 'Unknown Title',
        serviceType: primary.server?.service ?? null,
        serverName: primary.server?.name ?? null,
        sessionCount: userSessions.length,
      });
    });

    return nowPlaying;
  }, [lastSessionData?.sessions]);

  return (
    <div className="space-y-4">
      {users.length === 0 && !loading ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">No users match the current filters.</p>
        </div>
      ) : (
        <>
          {loading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, idx) => (
                <UserCardSkeleton key={idx} />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {users.map((user) => (
                <UserCard
                  key={user.uuid}
                  user={user}
                  nowPlaying={nowPlayingByUser.get(user.uuid)}
                  isSelected={selectedUserIds.has(user.uuid)}
                  onToggleSelection={onToggleSelection}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {onPageChange && totalPages > 1 && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={onPageChange}
              loading={loading}
            />
          )}
        </>
      )}
    </div>
  );
};
