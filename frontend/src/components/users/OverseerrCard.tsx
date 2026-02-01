import { useEffect, useState } from 'react';
import { requestJson } from '../../util/apiClient';
import { useAlerts } from '../../contexts/AlertContext';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar, faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { Spinner } from '@/components/ui/spinner'

type OverseerrLink = {
  server_id: number;
  server_name?: string;
  overseerr_user_id?: number;
  overseerr_username?: string;
  overseerr_email?: string;
  is_linked: boolean;
  last_sync_at?: string;
  requests?: any[];
  requests_pagination?: Record<string, any> | null;
  request_error?: string | null;
};

type OverseerrCardProps = {
  links: OverseerrLink[];
  loading?: boolean;
  error?: Error | null;
};

export const OverseerrCard = ({ links, loading, error }: OverseerrCardProps) => {
  const { success, error: showError } = useAlerts();
  const [localLinks, setLocalLinks] = useState<OverseerrLink[]>(links);
  const [updatingId, setUpdatingId] = useState<number | null>(null);

  useEffect(() => {
    setLocalLinks(links);
  }, [links]);

  const handleUpdateStatus = async (serverId: number, requestId: number, status: 'approve' | 'decline') => {
    try {
      setUpdatingId(requestId);
      await requestJson('/overseerr-request-update', {
        method: 'POST',
        body: JSON.stringify({ server_id: serverId, request_id: requestId, status }),
      });

      const newStatus = status === 'approve' ? 2 : 4; // map to approved/declined for display
      setLocalLinks((prev) =>
        prev.map((link) => ({
          ...link,
          requests: (link.requests || []).map((r: any) =>
            r.id === requestId ? { ...r, status: newStatus } : r
          ),
        }))
      );
      success(`Request ${status}d`);
    } catch (err) {
      showError(`Failed to ${status} request: ${(err as Error).message}`);
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <>
        <h3 className="text-lg font-semibold">Overseerr Status</h3>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Loading Overseerr data.
          </div>
        ) : error ? (
          <div className="text-sm text-red-600 dark:text-red-400">Failed to load Overseerr data: {error.message}</div>
        ) : localLinks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No Overseerr records found for this user.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {localLinks.map((link) => (
              <li key={link.server_id} className="rounded border border-border bg-muted/40 px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{link.server_name ?? 'Server'}</div>
                    <div className="text-xs text-muted-foreground">
                      {link.overseerr_username ?? 'Unlinked'} ({link.overseerr_email ?? 'No email'})
                    </div>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                      link.is_linked
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {link.is_linked ? 'Linked' : 'Not linked'}
                  </span>
                </div>

                {link.last_sync_at ? (
                  <div className="mt-1 text-xs text-foreground/50">
                    Last sync: {new Date(link.last_sync_at).toLocaleString()}
                  </div>
                ) : null}

                {link.request_error ? (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400">
                    Failed to load requests: {link.request_error}
                  </div>
                ) : null}

                {link.requests && link.requests.length > 0 ? (
                  <div className="mt-3 space-y-3">
                    <div className="text-xs font-semibold text-muted-foreground">Recent Requests</div>
                    <div className="space-y-3">
                      {link.requests.slice(0, 5).map((req: any) => {
                        const media = req.media || {};
                        const details = media.details || {};
                        const title =
                          media.title ||
                          media.name ||
                          media.originalTitle ||
                          media.originalName ||
                          details.title ||
                          details.name ||
                          details.original_title ||
                          details.original_name ||
                          details.originalTitle ||
                          details.originalName ||
                          'Request';
                        const year = (
                          media.releaseDate ||
                          media.firstAirDate ||
                          details.release_date ||
                          details.first_air_date ||
                          details.releaseDate ||
                          details.firstAirDate ||
                          ''
                        )
                          .toString()
                          .slice(0, 4);
                        const type = (media.mediaType || media.media_type || req.type || 'media').toString();
                        const statusCode = req.status ?? media.status;
                        const statusLabel =
                          statusCode === 1
                            ? 'Pending'
                            : statusCode === 2
                            ? 'Approved'
                            : statusCode === 3
                            ? 'Available'
                            : statusCode === 4
                            ? 'Declined'
                            : 'Unknown';
                        const posterPath =
                          media.posterPath ||
                          media.poster_path ||
                          media.backdropPath ||
                          media.backdrop_path ||
                          (media.mediaInfo &&
                            (media.mediaInfo.posterPath ||
                              media.mediaInfo.backdropPath ||
                              media.mediaInfo.poster_path ||
                              media.mediaInfo.backdrop_path)) ||
                          details.posterPath ||
                          details.poster_path ||
                          details.backdropPath ||
                          details.backdrop_path ||
                          details.stillPath ||
                          details.still_path;
                        const posterUrl = posterPath ? `https://image.tmdb.org/t/p/w154${posterPath}` : null;
                        const overview = media.overview || details.overview;
                        const rating = media.voteAverage || details.vote_average || details.voteAverage;
                        const createdAt = req.createdAt || req.created_at;
                        const isPending = statusCode === 1;

                        return (
                          <div
                            key={req.id ?? `${link.server_id}-${title}-${statusCode}`}
                            className="rounded-lg border border-border/60 bg-background p-3"
                          >
                            <div className="flex gap-3">
                              {posterUrl ? (
                                <img src={posterUrl} alt={title} className="h-20 w-14 rounded-md object-cover" />
                              ) : (
                                <div className="h-20 w-14 rounded-md bg-muted flex items-center justify-center text-muted-foreground/60 text-xs">
                                  No Art
                                </div>
                              )}
                              <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="font-semibold text-sm text-foreground truncate">
                                    {title} {year ? <span className="text-muted-foreground text-xs">({year})</span> : null}
                                  </div>
                                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{type}</span>
                                </div>
                                <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                                  <span
                                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                      statusCode === 1
                                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                                        : statusCode === 2 || statusCode === 3
                                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                                        : statusCode === 4
                                        ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300'
                                        : 'bg-muted text-muted-foreground'
                                    }`}
                                  >
                                    {statusLabel}
                                  </span>
                                  {rating ? (
                                    <span className="inline-flex items-center gap-1">
                                      <FontAwesomeIcon icon={faStar} className="text-yellow-500" />
                                      {Number(rating).toFixed(1)}
                                    </span>
                                  ) : null}
                                  {createdAt ? <span>Requested {createdAt.toString().slice(0, 10)}</span> : null}
                                </div>
                                {overview ? (
                                  <p className="text-xs text-muted-foreground/80 line-clamp-2">{overview}</p>
                                ) : null}
                                {isPending ? (
                                  <div className="flex items-center gap-2 pt-1">
                                    <button
                                      className="inline-flex items-center rounded-md bg-green-600 text-white px-2 py-1 text-[11px] font-semibold disabled:opacity-60"
                                      disabled={updatingId === req.id}
                                      onClick={() => handleUpdateStatus(link.server_id, req.id, 'approve')}
                                    >
                                      {updatingId === req.id ? (
                                        <Spinner className="size-3" />
                                      ) : (
                                        <FontAwesomeIcon icon={faCheck} className="mr-1" />
                                      )}
                                      Approve
                                    </button>
                                    <button
                                      className="inline-flex items-center rounded-md bg-rose-600 text-white px-2 py-1 text-[11px] font-semibold disabled:opacity-60"
                                      disabled={updatingId === req.id}
                                      onClick={() => handleUpdateStatus(link.server_id, req.id, 'decline')}
                                    >
                                      {updatingId === req.id ? (
                                        <Spinner className="size-3" />
                                      ) : (
                                        <FontAwesomeIcon icon={faXmark} className="mr-1" />
                                      )}
                                      Decline
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {link.requests.length > 5 ? (
                      <div className="text-xs text-muted-foreground/70">Showing 5 of {link.requests.length} requests.</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-muted-foreground">No requests found.</div>
                )}
              </li>
            ))}
          </ul>
        )}
    </>
  );
};

export default OverseerrCard;
