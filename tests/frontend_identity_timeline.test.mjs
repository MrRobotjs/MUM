import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The user page's History tab reads one timeline of MUM's plays and plays
// imported from Plex's history, chosen by source, each marked with its source.
async function load() {
  return loadFrontend("export * from './src/lib/identityTimeline';export {setAccessToken} from './src/store/authStore';");
}

const actor = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const service = '33333333-3333-4333-8333-333333333333';
const mum = {source: 'mum', id: 'mum-7', server_id: '1', service_uuid: service, media_type: 'movie', title: 'Film', parent_title: null, library_name: 'Movies',
  played_at: '2026-11-10T20:00:00.000000000Z', client: 'Plex Web', play_method: 'direct_play', position_ticks: '600', duration_ticks: '1200'};
const plex = {source: 'plex', id: 'plex-3', server_id: '1', service_uuid: service, media_type: 'episode', title: 'Pilot', parent_title: 'A Show', library_name: null,
  played_at: '2024-04-30T18:00:00.000000000Z', client: null, play_method: null, position_ticks: null, duration_ticks: null};
const page = (extra = {}) => ({actor_uuid: actor, scope: 'all', target_uuid: target, source: 'all', items: [mum, plex], next_before: '2024-04-30T18:00:00.000000000Z_p_3', ...extra});

test('identity timeline adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads a page for the chosen source and cursor', async () => {
    const m = await load(); m.setAccessToken('session');
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: page({source: 'plex'})}); };
    const result = await m.fetchIdentityTimeline(actor, target, 'all', 'plex', '2026-11-01T00:00:00.000000000Z_m_9');
    assert.equal(seen.pathname, `/api/activity/identities/${target}/timeline`);
    assert.deepEqual(Object.fromEntries(seen.searchParams), {scope: 'all', source: 'plex', before: '2026-11-01T00:00:00.000000000Z_m_9'});
    assert.deepEqual(result.items.map(item => item.source), ['mum', 'plex']);
    assert.equal(result.next_before, '2024-04-30T18:00:00.000000000Z_p_3');
  });

  await t.test('rejects bad input before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    await assert.rejects(m.fetchIdentityTimeline(actor, 'not-a-uuid', 'all', 'all'));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', 'both'));
    await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', 'all', 'yesterday'));
    assert.equal(called, false);
  });

  await t.test('rejects pages that do not match the request or mix the sources up', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const bad of [page({actor_uuid: target}), page({target_uuid: actor}), page({source: 'mum'}), page({items: [{...plex, client: 'Plex Web'}]}),
      page({items: [{...plex, position_ticks: '5'}]}), page({items: [{...mum, source: 'other'}]}), page({items: [mum, mum]}), page({items: [{...plex, id: 'mum-3'}]})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.fetchIdentityTimeline(actor, target, 'all', 'all'), /Invalid history/);
    }
  });
});
