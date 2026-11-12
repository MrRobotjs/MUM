import { useEffect, useRef } from 'react';
import { getAccessToken } from '../store/authStore';

// One mounted catalogue view owns its reads and mutation admission. Replacing
// a query invalidates its old result even when fetch ignores AbortSignal.
export class CatalogueView {
  private active = true;
  private reads = new Map<string, { key: string; abort: AbortController; timer: ReturnType<typeof setTimeout> }>();
  private queries: Record<string, string> = {};
  private mutation: object | null = null;
  private blocked = false;
  private inspection = 0;
  constructor(private readonly token: string | null) {}
  current = () => this.active && !!this.token && getAccessToken() === this.token;
  update(queries: Record<string, string>) {
    for (const [channel, run] of this.reads) {
      if (queries[channel] !== run.key) { run.abort.abort(); clearTimeout(run.timer); this.reads.delete(channel); }
    }
    this.queries = queries;
  }
  begin(channel: string, key = this.queries[channel]) {
    if (key !== this.queries[channel] || !this.current()) {
      const abort = new AbortController(); abort.abort();
      return {signal: abort.signal, current: () => false, finish: () => {}};
    }
    const old = this.reads.get(channel);
    if (old) { old.abort.abort(); clearTimeout(old.timer); }
    const abort = new AbortController();
    const run = {key, abort, timer: setTimeout(() => abort.abort(), 15000)};
    this.reads.set(channel, run);
    return {signal: abort.signal, current: () => this.current() && this.reads.get(channel) === run,
      finish: () => clearTimeout(run.timer)};
  }
  beginMutation() {
    if (!this.current() || this.mutation || this.blocked) return null;
    const run = {}; this.mutation = run;
    return {current: () => this.current() && this.mutation === run,
      finish: () => { if (this.mutation === run) this.mutation = null; }};
  }
  requireInspection() { this.blocked = true; this.inspection++; }
  inspectionRevision() { return this.inspection; }
  inspected(revision: number) {
    if (revision !== this.inspection) return false;
    this.blocked = false; return true;
  }
  activate() { this.active = true; }
  dispose() {
    this.active = false;
    for (const run of this.reads.values()) { run.abort.abort(); clearTimeout(run.timer); }
    this.reads.clear();
  }
}

export function useCatalogueView(queries: Record<string, string>) {
  const view = useRef<CatalogueView | null>(null);
  if (!view.current) view.current = new CatalogueView(getAccessToken());
  view.current.update(queries);
  useEffect(() => { const current = view.current!; current.activate(); return () => current.dispose(); }, []);
  return view.current;
}
