import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The user page's History tab reads one server's timeline at a time: MUM's
// plays, the server's imported history or both, with type and stream filters.
// The reply lists the person's servers and the categories they have there.
async function load() {
  return loadFrontend("export * from './src/lib/identityTimeline';export {setAccessToken} from './src/store/authStore';");
}

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const service = '33333333-3333-4333-8333-333333333333';
const mum = {source: 'mum', id: 'mum-7', server_id: '1', service_uuid: service, media_type: 'movie', title: 'Film', parent_title: null, library_name: 'Movies',
  played_at: '2026-11-10T20:00:00.000000000Z', client: 'Plex Web', play_method: 'direct_play', position_ticks: '600', duration_ticks: '1200',
  platform: 'Chrome', player: 'Living room', ip_address: '172.56.183.189', stopped_at: '2026-11-10T20:10:00.000000000Z', paused_seconds: '60', watched_seconds: '540', listened_seconds: null, in_progress: false};
const plex = {source: 'plex', id: 'plex-3', server_id: '1', service_uuid: service, media_type: 'episode', title: 'Pilot', parent_title: 'A Show', library_name: null,
  played_at: '2024-04-30T18:00:00.000000000Z', client: null, play_method: null, position_ticks: null, duration_ticks: null,
  platform: null, player: null, ip_address: null, stopped_at: null, paused_seconds: null, watched_seconds: null, listened_seconds: null, in_progress: false};
const jelly = {...plex, source: 'jellyfin', id: 'jellyfin-4', server_id: '2', title: 'Film', parent_title: null};
const book = {...plex, source: 'audiobookshelf', id: 'audiobookshelf-5', server_id: '3', media_type: 'book', title: 'A Book', parent_title: 'An Author', position_ticks: '900000000', duration_ticks: '36000000000', listened_seconds: '3600'};
const servers = [
  {server_id: '3', name: 'Books', service_type: 'audiobookshelf', live: false, history: true},
  {server_id: '2', name: 'Jelly++', service_type: 'jellyfin', live: true, history: true},
  {server_id: '1', name: 'Plex++', service_type: 'plex', live: true, history: true},
];
const page = (extra = {}) => ({actor_uuid: actor, scope: 'all', target_uuid: target, server_id: '1', records: 'all', servers, categories: ['movies', 'tv'],
  items: [mum, plex], next_before: '2024-04-30T18:00:00.000000000Z_p_3', ...extra});
const all = {records: 'all', filters: {types: [], methods: []}};

test('identity timeline adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads one server with records, filters and a cursor', async () => {
    const m = await load(); m.setAccessToken('session');
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: page()}); };
    const result = await m.fetchIdentityTimeline(actor, target, 'all', {server: '1', records: 'all', filters: {types: ['tv', 'movies'], methods: ['transcode', 'direct_play']}, before: '2026-11-01T00:00:00.000000000Z_m_9'});
    assert.equal(seen.pathname, `/api/activity/identities/${target}/timeline`);
    assert.deepEqual(Object.fromEntries(seen.searchParams), {scope: 'all', server: '1', records: 'all', types: 'movies,tv', methods: 'direct_play,transcode', before: '2026-11-01T00:00:00.000000000Z_m_9'});
    assert.deepEqual(result.items.map(item => item.source), ['mum', 'plex']);
    assert.equal(result.server_id, '1');
    assert.deepEqual(result.categories, ['movies', 'tv']);
    assert.deepEqual(result.servers.map(s => s.name), ['Books', 'Jelly++', 'Plex++']);
    assert.equal(result.next_before, '2024-04-30T18:00:00.000000000Z_p_3');
  });

  await t.test('lets the server choose when none is named', async () => {
    const m = await load(); m.setAccessToken('session');
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: page({server_id: '3', items: [book], categories: ['books']})}); };
    const result = await m.fetchIdentityTimeline(actor, target, 'all', all);
    assert.deepEqual(Object.fromEntries(seen.searchParams), {scope: 'all', records: 'all'});
    assert.equal(result.server_id, '3');
    assert.equal(result.items[0].listened_seconds, '3600');
  });

  await t.test('keeps the signed poster link of an imported play', async () => {
    const m = await load(); m.setAccessToken('session');
    const poster = '/api/activity/imported-history-images/3?s=x&e=1&g=y';
    globalThis.fetch = async () => Response.json({data: page({items: [{...plex, poster_url: poster}]})});
    const result = await m.fetchIdentityTimeline(actor, target, 'all', all);
    assert.equal(result.items[0].poster_url, poster);
  });

  await t.test('reads a person with no servers', async () => {
    const m = await load(); m.setAccessToken('session');
    globalThis.fetch = async () => Response.json({data: page({server_id: null, servers: [], categories: [], items: [], next_before: null})});
    const result = await m.fetchIdentityTimeline(actor, target, 'all', all);
    assert.equal(result.server_id, null);
    assert.equal(result.items.length, 0);
  });

  await t.test('rejects bad input before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    await assert.rejects(m.fetchIdentityTimeline(actor, 'not-a-uuid', 'all', all));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, records: 'both'}));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, server: '0'}));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, filters: {types: ['games'], methods: []}}));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, filters: {types: ['tv', 'tv'], methods: []}}));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, filters: {types: [], methods: ['copy']}}));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, before: 'yesterday'}));
    assert.equal(called, false);
  });

  await t.test('rejects pages that do not match the request or mix the sources up', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const bad of [page({actor_uuid: target}), page({target_uuid: actor}), page({records: 'mum'}), page({server_id: '9'}), page({server_id: null}),
      page({servers: [...servers, servers[0]]}), page({servers: [{...servers[0], live: 'yes'}]}), page({categories: ['games']}), page({categories: ['tv', 'movies']}),
      page({items: [{...plex, client: 'Plex Web'}]}), page({items: [{...plex, position_ticks: '5'}]}), page({items: [{...mum, source: 'other'}]}), page({items: [mum, mum]}),
      page({items: [{...plex, id: 'mum-3'}]}), page({items: [{...plex, poster_url: '/api/activity/history-images/3?s=x'}]}),
      page({items: [{...plex, poster_url: 'http://plex.test/library/metadata/1/thumb'}]}), page({items: [{...jelly, position_ticks: '5'}]}), page({items: [{...jelly, client: 'Web'}]}),
      page({items: [{...plex, platform: 'Chrome'}]}), page({items: [{...plex, stopped_at: '2024-04-30T18:00:00.000000000Z'}]}), page({items: [{...mum, stopped_at: null}]}),
      page({items: [{...mum, stopped_at: 'later'}]}), page({items: [{...mum, paused_seconds: '-1'}]}), page({items: [{...mum, watched_seconds: null}]}), page({items: [{...mum, ip_address: 7}]}),
      page({items: [{...plex, listened_seconds: '5'}]}), page({items: [{...plex, in_progress: true}]}), page({items: [{...mum, in_progress: 'no'}]}), page({items: [{...jelly, source: 'kavita', id: 'kavita-4'}]})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', {...all, server: '1'}), /Invalid history/);
    }
  });

  await t.test('deletes plays once, with no retry', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push([req.method, new URL(req.url).pathname, await req.text()]); return Response.json({data: {deleted: 2}}); };
    assert.equal(await m.deleteTimelinePlays(target, ['mum-7', 'plex-3']), 2);
    assert.deepEqual(calls, [['POST', `/api/activity/identities/${target}/timeline/delete`, JSON.stringify({ids: ['mum-7', 'plex-3']})]]);
    await assert.rejects(m.deleteTimelinePlays(target, []));
    await assert.rejects(m.deleteTimelinePlays(target, Array.from({length: 501}, (_, i) => `mum-${i + 1}`)));
    await assert.rejects(m.deleteTimelinePlays(target, ['nope']));
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => Response.json({data: {deleted: 5}});
    await assert.rejects(m.deleteTimelinePlays(target, ['mum-7']));
  });
});
