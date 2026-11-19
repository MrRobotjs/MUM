import { requestJson } from '../util/apiClient';

// A library's Overview tab: its most played items over the last 30 days (MUM's
// recorded plays, as on the Stats tab) and its newest catalogue items.

export type LibraryMostPlayed = Readonly<{ item_id: number; title: string; streams: number; poster_url: string | null }>;
export type LibraryRecentItem = Readonly<{ id: number; title: string; item_type: string | null; year: number | null; thumb: string | null; added_at: string | null }>;

const poster = (v: unknown) => v === null || v === undefined || typeof v === 'string' && v.startsWith('/api/media/images/');
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const validLibrary = (id: number) => { if (!positive(id)) throw new Error('Invalid library'); };

export async function fetchLibraryMostPlayed(library: number, days = 30): Promise<readonly LibraryMostPlayed[]> {
  validLibrary(library);
  const { data } = await requestJson<{ data?: { library_id?: unknown; stats?: { trending_content?: unknown } } }>(`/api/libraries/${library}/stats?days=${days}`);
  const list = data?.stats?.trending_content;
  if (data?.library_id !== library || !Array.isArray(list)) throw new Error('Invalid library stats');
  return Object.freeze(list.map((value: unknown) => {
    const v = value as Record<string, unknown>;
    if (!v || !positive(v.item_id) || typeof v.title !== 'string' || !count(v.streams) || !poster(v.poster_url)) throw new Error('Invalid library stats');
    return Object.freeze({ item_id: v.item_id, title: v.title, streams: v.streams, poster_url: (v.poster_url ?? null) as string | null });
  }));
}

export async function fetchLibraryRecentlyAdded(library: number, size = 12): Promise<readonly LibraryRecentItem[]> {
  validLibrary(library);
  const query = new URLSearchParams({ page: '1', page_size: String(size), sort_by: 'added_desc' });
  const { data } = await requestJson<{ data?: unknown }>(`/api/libraries/${library}/media?${query}`);
  if (!Array.isArray(data)) throw new Error('Invalid library media');
  return Object.freeze(data.map((value: unknown) => {
    const v = value as Record<string, unknown>;
    if (!v || !positive(v.id) || typeof v.title !== 'string' || !poster(v.thumb) || !(v.year === null || v.year === undefined || Number.isSafeInteger(v.year))) throw new Error('Invalid library media');
    return Object.freeze({ id: v.id, title: v.title, item_type: typeof v.item_type === 'string' ? v.item_type : null, year: (v.year ?? null) as number | null,
      thumb: (v.thumb || null) as string | null, added_at: typeof v.added_at === 'string' ? v.added_at : null });
  }));
}
