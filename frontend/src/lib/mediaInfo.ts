import { formatBytes, formatRate } from './plexResources';

// The file details a library sync saved for a catalogue item: what the
// Overview's Media info card shows. Every field is optional.
export type MediaInfo = {
  container?: string; bitrate_kbps?: number; video_codec?: string; video_resolution?: string;
  video_frame_rate?: string; audio_codec?: string; audio_channels?: number; size_bytes?: number;
};

const labels = ['container', 'video_codec', 'video_resolution', 'video_frame_rate', 'audio_codec'] as const;
const numbers = ['bitrate_kbps', 'audio_channels', 'size_bytes'] as const;

// readMediaInfo accepts only short labels and positive whole numbers; anything
// else means the record can't be trusted and the card shows nothing.
export function readMediaInfo(raw: unknown): MediaInfo | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid media info.');
  const value = raw as Record<string, unknown>, out: MediaInfo = {};
  for (const key of labels) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || !v || v.length > 32 || v.trim() !== v || /[\u0000-\u001f\u007f]/.test(v)) throw Error('Invalid media info.');
    out[key] = v;
  }
  for (const key of numbers) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw Error('Invalid media info.');
    out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

export const audioChannelsLabel = (channels: number) =>
  ({ 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' } as Record<number, string>)[channels] ?? `${channels} channels`;

export const mediaBitrateLabel = (kbps: number) => formatRate(kbps);
export const mediaSizeLabel = (bytes: number) => formatBytes(bytes);
