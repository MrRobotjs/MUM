import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The Media Servers page sums each server's libraries and items from the
// library list: the server's count, else the synced catalogue's (Plex reports
// none), and nothing for libraries neither knows.
const load = () => loadFrontend("export * from './src/lib/serversIndex';");

test('servers index library totals', async () => {
  const m = await load();
  const totals = m.serverLibraryTotals([
    {id: 1, server_id: 2, item_count: 120},
    {id: 2, server_id: 2, item_count: null, catalogue: {synced_at: '2026-11-01T00:00:00Z', item_count: 45}},
    {id: 3, server_id: 2, item_count: null, catalogue: {synced_at: null, item_count: 99}},
    {id: 4, server_id: 5, item_count: 0},
    {id: 5},
  ]);
  assert.deepEqual(totals.get(2), {libraries: 3, items: 165});
  assert.deepEqual(totals.get(5), {libraries: 1, items: 0});
  assert.equal(totals.get(7), undefined);
  assert.equal(totals.size, 2);
});
