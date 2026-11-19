import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Libraries page reads each library with its activity on that
// server, for the chosen records.
const load = () => loadFrontend("export * from './src/lib/serverLibraries';export {setAccessToken} from './src/store/authStore';");

const library = (extra = {}) => ({id: 5, external_id: '1', name: 'Movies', library_type: 'movie', item_count: 120, parent_count: null, child_count: null, last_scanned: '2026-11-01T00:00:00Z', catalogue_synced: true,
  plays: 7, watch_seconds: 3600, last_streamed_at: '2026-11-02T00:00:00Z',
  last_played: {title: 'Arrival', parent_title: null, media_type: 'movie', source: 'mum', poster_url: '/api/activity/history-images/3?s=a&e=1&g=b', link: {library_id: 5, media_id: 9, episode_id: null}}, ...extra});
const page = (extra = {}) => ({server_id: 2, server_name: 'Plex++', service_type: 'plex', live: true, records: 'all', items: [library()], ...extra});

test('server libraries adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};
  const m = await load();
  m.setAccessToken('session');

  await t.test('reads the libraries for the chosen records', async () => {
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: page()}); };
    const result = await m.fetchServerLibraries(2, 'all');
    assert.equal(seen.pathname, '/api/servers/2/library-activity');
    assert.deepEqual(Object.fromEntries(seen.searchParams), {records: 'all'});
    assert.equal(result.items[0].name, 'Movies');
    assert.equal(result.items[0].last_played.link.media_id, 9);
    assert.equal(result.items[0].watch_seconds, 3600);
    assert.equal(result.items[0].parent_count, null);
  });

  await t.test('accepts libraries without plays or a known type', async () => {
    globalThis.fetch = async () => Response.json({data: page({records: 'server', items: [library({library_type: null, item_count: null, parent_count: 12, child_count: 693, last_scanned: null, plays: 0, watch_seconds: null, last_streamed_at: null, last_played: null})]})});
    const result = await m.fetchServerLibraries(2, 'server');
    assert.equal(result.items[0].last_played, null);
    assert.equal(result.items[0].child_count, 693);
    assert.equal(result.items[0].item_count, null);
    assert.equal(result.items[0].library_type, null);
  });

  await t.test('refuses bad requests before sending and unexpected replies', async () => {
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    await assert.rejects(m.fetchServerLibraries(0, 'all'));
    await assert.rejects(m.fetchServerLibraries(2, 'both'));
    assert.equal(called, false);
    for (const bad of [page({server_id: 3}), page({records: 'mum'}), page({items: [library(), library()]}), page({items: [library({plays: -1})]}),
      page({items: [library({name: 7})]}), page({items: [library({child_count: -2})]}), page({items: [library({parent_count: '3'})]}), page({items: [library({last_played: {title: 'x', source: 'other', media_type: '', parent_title: null}})]})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.fetchServerLibraries(2, 'all'), /Invalid/);
    }
  });
});
