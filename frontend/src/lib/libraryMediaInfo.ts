import { requestJson } from '../util/apiClient';
import { readMediaInfo, type MediaInfo } from './mediaInfo';

// A library's Media Info tab: each file in the library (movies and videos, a
// TV library's episodes, a music library's tracks) with the details the last
// library sync saved, its plays and when it was last played.

export type MediaInfoSort = 'added' | 'title' | 'container' | 'bitrate' | 'video_codec' | 'video_resolution' | 'video_frame_rate'
  | 'audio_codec' | 'audio_channels' | 'size' | 'last_played' | 'plays';
export const mediaInfoSorts: readonly MediaInfoSort[] = ['added', 'title', 'container', 'bitrate', 'video_codec', 'video_resolution', 'video_frame_rate',
  'audio_codec', 'audio_channels', 'size', 'last_played', 'plays'];

export type LibraryMediaInfoRow = Readonly<{
  id: number; item_type: string; title: string;
  /** The show or album the episode or track belongs to. */
  parent_id: number | null; parent_title: string | null;
  season_number: number | null; episode_number: number | null; year: number | null;
  added_at: string | null; media_info: MediaInfo | null; plays: number; last_played_at: string | null;
}>;
export type LibraryMediaInfoPage = Readonly<{ items: readonly LibraryMediaInfoRow[]; page: number; total_items: number; total_pages: number }>;
export type LibraryMediaInfoQuery = { page: number; pageSize: number; sort: MediaInfoSort; desc: boolean; search: string };

const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const optionalCount = (v: unknown) => v === undefined || v === null || count(v);
const optionalText = (v: unknown) => v === undefined || v === null || typeof v === 'string' && v.length <= 1024;
const date = (v: unknown) => v === null || v === undefined || typeof v === 'string' && Number.isFinite(Date.parse(v));

export async function fetchLibraryMediaInfo(library: number, query: LibraryMediaInfoQuery, signal?: AbortSignal): Promise<LibraryMediaInfoPage> {
  if (!positive(library) || !positive(query.page) || !positive(query.pageSize) || query.pageSize > 100 || !mediaInfoSorts.includes(query.sort) || query.search.length > 200) {
    throw new Error('Invalid media info request');
  }
  const params = new URLSearchParams({ page: String(query.page), page_size: String(query.pageSize), sort: query.sort, order: query.desc ? 'desc' : 'asc' });
  if (query.search.trim()) params.set('search', query.search.trim());
  const { data } = await requestJson<{ data?: { items?: unknown; pagination?: Record<string, unknown> } }>(`/api/libraries/${library}/media-info?${params}`, { signal });
  const list = data?.items, pages = data?.pagination;
  if (!Array.isArray(list) || list.length > query.pageSize || !pages || !positive(pages.page) || !count(pages.total_items) || !positive(pages.total_pages)) throw new Error('Invalid media info');
  const items = list.map((value: unknown) => {
    const v = value as Record<string, unknown>;
    if (!v || !positive(v.id) || typeof v.item_type !== 'string' || typeof v.title !== 'string' || !(v.parent_id === null || positive(v.parent_id)) || !optionalText(v.parent_title)
      || !optionalCount(v.season_number) || !optionalCount(v.episode_number) || !optionalCount(v.year) || !date(v.added_at) || !count(v.plays) || !date(v.last_played_at)) {
      throw new Error('Invalid media info');
    }
    return Object.freeze({
      id: v.id, item_type: v.item_type, title: v.title, parent_id: (v.parent_id ?? null) as number | null, parent_title: (v.parent_title ?? null) as string | null,
      season_number: (v.season_number ?? null) as number | null, episode_number: (v.episode_number ?? null) as number | null, year: (v.year ?? null) as number | null,
      added_at: (v.added_at ?? null) as string | null, media_info: readMediaInfo(v.media_info), plays: v.plays, last_played_at: (v.last_played_at ?? null) as string | null,
    });
  });
  return Object.freeze({ items: Object.freeze(items), page: pages.page, total_items: pages.total_items, total_pages: pages.total_pages });
}
