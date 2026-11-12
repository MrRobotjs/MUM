// Graph datasets the server does not record are listed in meta.unavailable;
// their empty charts must not claim there was no history.
export function graphUnavailable(meta: { unavailable?: unknown } | undefined, dataset: string): boolean {
  return Array.isArray(meta?.unavailable) && meta.unavailable.includes(dataset);
}

export function graphEmptyMessage(meta: { unavailable?: unknown } | undefined, dataset: string, fallback: string): string {
  return graphUnavailable(meta, dataset) ? 'This data is not recorded yet.' : fallback;
}
