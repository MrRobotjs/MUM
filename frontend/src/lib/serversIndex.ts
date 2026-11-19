// The Media Servers page (/admin/servers): one card per server.

type LibraryCount = { server_id?: number; item_count?: number | null; catalogue?: { synced_at?: string | null; item_count?: number | null } };

/**
 * Each server's library count and items: a library's own count, else its
 * synced catalogue's (Plex reports none), else nothing. Libraries without a
 * server are skipped.
 */
export function serverLibraryTotals(libraries: readonly LibraryCount[]): Map<number, { libraries: number; items: number }> {
  const totals = new Map<number, { libraries: number; items: number }>();
  for (const library of libraries) {
    if (typeof library.server_id !== 'number') continue;
    const items = library.item_count ?? (library.catalogue?.synced_at ? library.catalogue.item_count ?? 0 : 0);
    const current = totals.get(library.server_id) ?? { libraries: 0, items: 0 };
    totals.set(library.server_id, { libraries: current.libraries + 1, items: current.items + items });
  }
  return totals;
}
