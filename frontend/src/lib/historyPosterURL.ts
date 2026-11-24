// Reuse a still-valid signed URL across history refreshes. Never carry a URL
// across sessions, image identities, or changes to non-signature parameters.
export function stableHistoryPosterURL(previous: string | undefined, next: string | undefined, now = Date.now() / 1000): string | undefined {
  if (!previous || !next || previous === next) return next;
  try {
    const a = new URL(previous, 'http://mum.invalid');
    const b = new URL(next, 'http://mum.invalid');
    const expiry = Number(a.searchParams.get('e'));
    if (a.origin !== b.origin || a.pathname !== b.pathname || !a.searchParams.get('s') || !Number.isFinite(expiry) || expiry <= now + 30) return next;
    a.searchParams.delete('e'); a.searchParams.delete('g');
    b.searchParams.delete('e'); b.searchParams.delete('g');
    a.searchParams.sort(); b.searchParams.sort();
    return a.search === b.search ? previous : next;
  } catch { return next; }
}
