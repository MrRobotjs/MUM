import type { ActiveSession } from '@/types/streaming';

export type StreamingSessionStats = {
  totalSessions: number;
  transcodeCount: number;
  directPlayCount: number;
  totalBandwidthMbps: number;
  lanBandwidthMbps: number;
  wanBandwidthMbps: number;
};

export const getSessionBandwidthMbps = (session: ActiveSession) => {
  const detail = session.bandwidth_detail ?? '';
  const gbps = detail.match(/(\d+(\.\d+)?)\s*Gbps/i);
  if (gbps) return parseFloat(gbps[1]) * 1000;
  const mbps = detail.match(/(\d+(\.\d+)?)\s*Mbps/i);
  if (mbps) return parseFloat(mbps[1]);
  const kbps = detail.match(/(\d+(\.\d+)?)\s*Kbps/i);
  if (kbps) return parseFloat(kbps[1]) / 1000;
  return 0;
};

export const isLanSession = (session: ActiveSession) => {
  const locationType = String(session.location_type_calc ?? '').trim().toLowerCase();
  if (locationType === 'lan') return true;
  if (locationType === 'wan') return false;
  if (locationType.includes('lan')) return true;
  if (locationType.includes('wan')) return false;
  if (typeof session.is_public_ip === 'boolean') return !session.is_public_ip;
  const detail = String(session.location_detail ?? '').toLowerCase();
  if (detail.includes('remote')) return false;
  if (detail.includes('wan')) return false;
  if (detail.includes('lan')) return true;
  return true;
};

export const getStreamingSessionStats = (sessions: ActiveSession[]): StreamingSessionStats => {
  const totalSessions = sessions.length;
  const transcodeCount = sessions.filter(
    (s) => s.is_transcode_calc || s.transcode_reason || s.stream_detail.toLowerCase().includes('transcode')
  ).length;
  const directPlayCount = totalSessions - transcodeCount;

  const totalBandwidthMbps = sessions.reduce((acc, s) => acc + getSessionBandwidthMbps(s), 0);
  const lanBandwidthMbps = sessions.reduce(
    (acc, s) => (isLanSession(s) ? acc + getSessionBandwidthMbps(s) : acc),
    0
  );
  const wanBandwidthMbps = sessions.reduce(
    (acc, s) => (!isLanSession(s) ? acc + getSessionBandwidthMbps(s) : acc),
    0
  );

  return {
    totalSessions,
    transcodeCount,
    directPlayCount,
    totalBandwidthMbps,
    lanBandwidthMbps,
    wanBandwidthMbps,
  };
};
