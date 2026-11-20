import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A library's Overview reads its most played items (30 days) and its newest
// catalogue items; posters must be this server's signed catalogue links.
const load = () => loadFrontend("export * from './src/lib/libraryOverview';export {setAccessToken} from './src/store/authStore';");

test('library overview adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};
  const m = await load();
  m.setAccessToken('session');
  const entry = (extra = {}) => ({title: 'WALL·E', streams: 42, item_id: 9, poster_url: '/api/media/images/9?s=a&e=1&g=b', ...extra});
  const item = (extra = {}) => ({id: 9, external_id: 'x', title: 'WALL·E', item_type: 'movie', year: 2008, thumb: '/api/media/images/9?s=a&e=1&g=b', added_at: '2026-11-01T00:00:00Z', ...extra});

  await t.test('most played over the last 30 days', async () => {
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: {library_id: 4, days: 30, stats: {trending_content: [entry(), entry({item_id: 10, title: 'The Show', poster_url: null, streams: 3})]}}}); };
    const result = await m.fetchLibraryMostPlayed(4);
    assert.equal(seen.pathname, '/api/libraries/4/stats');
    assert.equal(seen.searchParams.get('days'), '30');
    assert.deepEqual(result.map(r => [r.item_id, r.streams, r.poster_url === null]), [[9, 42, false], [10, 3, true]]);
  });

  await t.test('newest catalogue items', async () => {
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: [item(), item({id: 10, thumb: null, year: null, added_at: null})]}); };
    const result = await m.fetchLibraryRecentlyAdded(4);
    assert.equal(seen.pathname, '/api/libraries/4/media');
    assert.deepEqual(Object.fromEntries(seen.searchParams), {page: '1', page_size: '12', sort_by: 'added_desc'});
    assert.equal(result[1].thumb, null);
  });

  await t.test('refuses replies that do not match or carry outside posters', async () => {
    for (const bad of [{data: {library_id: 5, stats: {trending_content: []}}}, {data: {library_id: 4, stats: {trending_content: [entry({poster_url: 'https://plex.tv/x.jpg'})]}}},
      {data: {library_id: 4, stats: {trending_content: [entry({item_id: 0})]}}}, {data: {library_id: 4, stats: {trending_content: [entry({streams: -1})]}}}]) {
      globalThis.fetch = async () => Response.json(bad);
      await assert.rejects(m.fetchLibraryMostPlayed(4), /Invalid/);
    }
    for (const bad of [{data: [item({thumb: 'https://plex.tv/x.jpg'})]}, {data: [item({id: 'x'})]}, {data: 'nope'}]) {
      globalThis.fetch = async () => Response.json(bad);
      await assert.rejects(m.fetchLibraryRecentlyAdded(4), /Invalid/);
    }
    await assert.rejects(m.fetchLibraryMostPlayed(0), /Invalid/);
  });
});

// A title's Overview figures come from its item read's play summary; a
// summary that doesn't add up is shown as unknown rather than trusted.
test('title play summary', async () => {
  const m = await load();
  const good = {plays: 4, recorded_plays: 2, imported_plays: 2, watch_seconds: 5400, viewers: 1, last_played_at: '2026-11-19T10:00:00.000000000Z', last_played_title: 'Pilot', last_viewer: 'alex'};
  assert.deepEqual(m.readItemPlays(good), good);
  const none = {plays: 0, recorded_plays: 0, imported_plays: 0, watch_seconds: 0, viewers: 0, last_played_at: null, last_played_title: null, last_viewer: null};
  assert.deepEqual(m.readItemPlays(none), none);
  for (const bad of [null, undefined, 'x', {...good, plays: 5}, {...good, viewers: 9}, {...good, watch_seconds: -1}, {...good, plays: 1.5, recorded_plays: 1.5, imported_plays: 0},
    {...good, last_played_at: null}, {...none, last_played_at: '2026-11-19T10:00:00Z'}, {...good, last_viewer: 7}, {...good, last_played_title: 'x'.repeat(2000)}]) {
    assert.equal(m.readItemPlays(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});
