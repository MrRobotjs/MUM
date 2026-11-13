import { ApiError, requestJson } from '../util/apiClient';

// Library item catalogue mutations. Each is sent once with the catalogue
// revision the page displayed; a missing, malformed or non-application reply
// is reported as unconfirmed rather than retried.

export type CatalogueOutcome<T> =
  | { kind: 'committed'; receipt: T }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unconfirmed'; message: string };

export type CatalogueSyncReceipt = {
  libraryId: number;
  revision: number;
  added: number;
  updated: number;
  removed: number;
  total: number;
  message: string;
  /** Present when episodes were requested: whether the background episode
   * run started, and for how many shows. */
  episodes?: { started: boolean; shows: number };
};

export type CataloguePurgeReceipt = { libraryId: number; revision: number; deleted: number };

const UNCONFIRMED = 'The outcome is unconfirmed. Refresh the library and inspect saved items before another attempt. No request was replayed.';

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

async function send<T>(path: string, revision: number, parse: (data: any) => T | null, field = 'expected_catalogue_revision'): Promise<CatalogueOutcome<T>> {
  let response: { data?: unknown };
  try {
    response = await requestJson<{ data?: unknown }>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: revision }),
      retryAuthentication: false,
      signal: AbortSignal.timeout(65000),
    });
  } catch (err) {
    const payload = err instanceof ApiError ? (err.payload as { error?: { code?: unknown } } | undefined) : undefined;
    const code = payload?.error?.code;
    if (err instanceof ApiError && typeof code === 'string' && code !== '') {
      return { kind: 'refused', code, message: err.message };
    }
    return { kind: 'unconfirmed', message: UNCONFIRMED };
  }
  const receipt = parse(response?.data);
  return receipt ? { kind: 'committed', receipt } : { kind: 'unconfirmed', message: UNCONFIRMED };
}

// With episodes, the shows are saved first and the reply says whether their
// episodes are now synchronizing in the background (followed on the sync status).
export function syncLibraryCatalogue(libraryId: number, revision: number, { episodes = false }: { episodes?: boolean } = {}): Promise<CatalogueOutcome<CatalogueSyncReceipt>> {
  return send(`/api/libraries/${libraryId}/sync${episodes ? '?sync_episodes=true' : ''}`, revision, data => {
    const result = data?.result;
    const values = [count(result?.added), count(result?.updated), count(result?.removed), count(result?.total)];
    if (data?.success !== true || data?.library_id !== libraryId || data?.source_revision !== revision || data?.revision !== revision + 1 || values.some(v => v === null)) {
      return null;
    }
    const [added, updated, removed, total] = values as number[];
    const receipt: CatalogueSyncReceipt = { libraryId, revision: data.revision, added, updated, removed, total, message: typeof data.message === 'string' ? data.message : '' };
    if (!episodes) return receipt;
    const started = data?.episodes?.started;
    const shows = count(data?.episodes?.shows);
    if (typeof started !== 'boolean' || shows === null) return null;
    return { ...receipt, episodes: { started, shows } };
  });
}

export function purgeLibraryCatalogue(libraryId: number, revision: number): Promise<CatalogueOutcome<CataloguePurgeReceipt>> {
  return send(`/api/libraries/${libraryId}/purge`, revision, data => {
    const deleted = count(data?.deleted_count);
    if (data?.success !== true || data?.library_id !== libraryId || data?.revision !== revision + 1 || deleted === null) {
      return null;
    }
    return { libraryId, revision: data.revision, deleted };
  });
}

export type EpisodeSyncReceipt = CatalogueSyncReceipt & { itemId: number };
export type EpisodePurgeReceipt = CataloguePurgeReceipt & { itemId: number };

export function syncEpisodeCatalogue(libraryId: number, itemId: number, revision: number): Promise<CatalogueOutcome<EpisodeSyncReceipt>> {
  return send(`/api/libraries/${libraryId}/media/${itemId}/episodes/sync`, revision, data => {
    const result = data?.result;
    const values = [count(result?.added), count(result?.updated), count(result?.removed), count(result?.total)];
    if (data?.success !== true || data?.library_id !== libraryId || data?.item_id !== itemId || data?.source_revision !== revision || data?.revision !== revision + 1 || values.some(v => v === null)) {
      return null;
    }
    const [added, updated, removed, total] = values as number[];
    return { libraryId, itemId, revision: data.revision, added, updated, removed, total, message: typeof data.message === 'string' ? data.message : '' };
  }, 'expected_episode_revision');
}

export function purgeEpisodeCatalogue(libraryId: number, itemId: number, revision: number): Promise<CatalogueOutcome<EpisodePurgeReceipt>> {
  return send(`/api/libraries/${libraryId}/media/${itemId}/episodes/purge`, revision, data => {
    const deleted = count(data?.deleted_count);
    if (data?.success !== true || data?.library_id !== libraryId || data?.item_id !== itemId || data?.revision !== revision + 1 || deleted === null) {
      return null;
    }
    return { libraryId, itemId, revision: data.revision, deleted };
  }, 'expected_episode_revision');
}
