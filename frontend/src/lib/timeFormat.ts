const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const formatTimeAgo = (iso?: string | null): string => {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = Date.now() - date.getTime();
  if (diffMs < MINUTE_MS) return 'just now';
  if (diffMs < HOUR_MS) {
    const minutes = Math.floor(diffMs / MINUTE_MS);
    return `${minutes}m ago`;
  }
  if (diffMs < DAY_MS) {
    const hours = Math.floor(diffMs / HOUR_MS);
    return `${hours}h ago`;
  }
  const days = Math.floor(diffMs / DAY_MS);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const formatMediaTypeLabel = (mediaType?: string | null): string => {
  const normalized = (mediaType || '').toLowerCase();
  if (!normalized) return 'Media';
  if (normalized.includes('movie') || normalized === 'film') return 'Movie';
  if (normalized.includes('episode') || normalized.includes('show') || normalized === 'tv') {
    return 'Show';
  }
  if (normalized.includes('track') || normalized.includes('audio')) return 'Audio';
  if (normalized.includes('book')) return 'Book';
  return mediaType ?? 'Media';
};

export const formatDurationSeconds = (seconds?: number | null): string => {
  if (!seconds || seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};
