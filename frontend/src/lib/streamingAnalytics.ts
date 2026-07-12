import type { ActiveSession } from '@/types/streaming';
import type { StreamingServerBreakdown } from '@/hooks/useStreamingSummary';
import { getStreamingSessionStats } from '@/components/streaming/sessionStats';

export type QualityBucket = '4K' | '1080p' | '720p' | '480p' | 'SD' | 'Unknown';

const QUALITY_ORDER: QualityBucket[] = ['4K', '1080p', '720p', '480p', 'SD', 'Unknown'];

export const formatDurationSeconds = (seconds: number) => {
  if (!seconds) return '0m';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

export const parseQualityBucket = (session: ActiveSession): QualityBucket => {
  const detail = (session.quality_detail || '').toLowerCase();
  const resolution = String(session.media_video_resolution || '').toLowerCase();
  const height = session.media_height;

  if (
    detail.includes('4k') ||
    detail.includes('2160') ||
    resolution.includes('4k') ||
    resolution.includes('2160') ||
    (typeof height === 'number' && height >= 2160)
  ) {
    return '4K';
  }
  if (
    detail.includes('1080') ||
    resolution.includes('1080') ||
    (typeof height === 'number' && height >= 1080)
  ) {
    return '1080p';
  }
  if (
    detail.includes('720') ||
    resolution.includes('720') ||
    (typeof height === 'number' && height >= 720)
  ) {
    return '720p';
  }
  if (
    detail.includes('480') ||
    resolution.includes('480') ||
    (typeof height === 'number' && height >= 480)
  ) {
    return '480p';
  }
  if (typeof height === 'number' && height > 0) {
    return 'SD';
  }
  if (detail || resolution) {
    return 'Unknown';
  }
  return 'Unknown';
};

export type QualityBreakdownItem = {
  label: QualityBucket;
  count: number;
};

export const buildQualityBreakdown = (sessions: ActiveSession[]): QualityBreakdownItem[] => {
  const buckets = new Map<QualityBucket, number>();
  for (const bucket of QUALITY_ORDER) {
    buckets.set(bucket, 0);
  }

  for (const session of sessions) {
    const bucket = parseQualityBucket(session);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }

  return QUALITY_ORDER.map((label) => ({
    label,
    count: buckets.get(label) ?? 0,
  })).filter((item) => item.count > 0);
};

export type TranscodeBreakdown = {
  directPlay: number;
  transcode: number;
  total: number;
  directPercent: number;
  transcodePercent: number;
};

export const buildTranscodeBreakdown = (sessions: ActiveSession[]): TranscodeBreakdown => {
  const stats = getStreamingSessionStats(sessions);
  const total = stats.totalSessions;
  const directPlay = stats.directPlayCount;
  const transcode = stats.transcodeCount;
  const directPercent = total > 0 ? Math.round((directPlay / total) * 100) : 0;

  return {
    directPlay,
    transcode,
    total,
    directPercent,
    transcodePercent: total > 0 ? 100 - directPercent : 0,
  };
};

/** Avoid empty spread / zero-width bars in metric visualizations. */
export const safeBarMax = (values: number[], fallback = 1): number => {
  if (values.length === 0) return fallback;
  return Math.max(...values, fallback);
};

export type ServerShareItem = StreamingServerBreakdown & {
  percent: number;
};

export const buildServerShare = (servers: StreamingServerBreakdown[]): ServerShareItem[] => {
  const total = servers.reduce((acc, server) => acc + server.count, 0);

  return servers
    .map((server) => ({
      ...server,
      percent: total > 0 ? Math.round((server.count / total) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);
};
