import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Users page reads one page of its accounts with their activity on
// that server, for the chosen records.
async function load() {
  return loadFrontend("export * from './src/lib/serverAccounts';export {setAccessToken} from './src/store/authStore';");
}

const account = (extra = {}) => ({uuid: '33333333-3333-4333-8333-333333333333', username: 'AllGas', duplicate_username: false, email: 'a@example.test', is_active: true, access_expires_at: null,
  plays: 4, watch_seconds: 2400, last_streamed_at: '2026-11-01T04:00:00.000000000Z', last_played: {title: 'Plex four', parent_title: 'A Show', media_type: 'episode', source: 'plex'},
  last_ip: '172.56.183.189', last_platform: 'Roku', last_player: 'Living room', linked_profile: {uuid: '44444444-4444-4444-8444-444444444444', name: 'allbass'},
  libraries: ['Movies'], has_all_libraries: false, library_policy_known: true, avatar_url: '/api/service-avatars/9?s=a&e=1&g=b', ...extra});
const page = (extra = {}) => ({server_id: 2, server_name: 'Plex++', service_type: 'plex', live: true, records: 'all', items: [account()], page: 1, page_size: 100, total_items: 1, total_pages: 1, ...extra});

test('server accounts adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads one page with records, search, sort and page', async () => {
    const m = await load(); m.setAccessToken('session');
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: page()}); };
    const result = await m.fetchServerAccounts(2, {records: 'all', search: ' gas ', sort: 'plays_desc', page: 1, pageSize: 25});
    assert.equal(seen.pathname, '/api/servers/2/accounts');
    assert.deepEqual(Object.fromEntries(seen.searchParams), {records: 'all', sort: 'plays_desc', page: '1', page_size: '25', search: 'gas'});
    assert.equal(result.items[0].last_played.title, 'Plex four');
    assert.equal(result.items[0].watch_seconds, 2400);
    assert.equal(result.total_items, 1);
  });

  await t.test('accepts accounts without activity, links or pictures', async () => {
    const m = await load(); m.setAccessToken('session');
    globalThis.fetch = async () => Response.json({data: page({records: 'server', items: [account({watch_seconds: null, last_streamed_at: null, last_played: null, last_ip: null, last_platform: null, last_player: null, linked_profile: null, avatar_url: undefined, email: null, plays: 0})]})});
    const result = await m.fetchServerAccounts(2, {records: 'server', search: '', sort: 'username_asc', page: 1, pageSize: 25});
    assert.equal(result.items[0].avatar_url, null);
    assert.equal(result.items[0].last_played, null);
  });

  await t.test('reads the last play’s poster and library page', async () => {
    const m = await load(); m.setAccessToken('session');
    const lastPlayed = {title: 'Plex four', parent_title: 'A Show', media_type: 'episode', source: 'plex', poster_url: '/api/activity/imported-history-images/7?s=a&e=1&g=b', link: {library_id: 3, media_id: 10, episode_id: 11}};
    globalThis.fetch = async () => Response.json({data: page({items: [account({last_played: lastPlayed})]})});
    const result = await m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 25});
    assert.deepEqual(result.items[0].last_played.link, {library_id: 3, media_id: 10, episode_id: 11});
    assert.equal(result.items[0].last_played.poster_url, lastPlayed.poster_url);
    globalThis.fetch = async () => Response.json({data: page({items: [account({last_played: {...lastPlayed, poster_url: undefined, link: {library_id: 3, media_id: 12, episode_id: null}}})]})});
    const movie = await m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 25});
    assert.equal(movie.items[0].last_played.poster_url, null);
    assert.equal(movie.items[0].last_played.link.episode_id, null);
    for (const bad of [{poster_url: 'https://plex.tv/poster.jpg'}, {poster_url: '/api/service-avatars/1'}, {link: {library_id: 0, media_id: 1, episode_id: null}}, {link: {library_id: 1, media_id: '2', episode_id: null}}]) {
      globalThis.fetch = async () => Response.json({data: page({items: [account({last_played: {...lastPlayed, ...bad}})]})});
      await assert.rejects(m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 25}), /Invalid/);
    }
  });

  await t.test('rejects bad input before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    await assert.rejects(m.fetchServerAccounts(0, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 25}));
    await assert.rejects(m.fetchServerAccounts(2, {records: 'both', search: '', sort: 'username_asc', page: 1, pageSize: 25}));
    await assert.rejects(m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'email', page: 1, pageSize: 25}));
    await assert.rejects(m.fetchServerAccounts(2, {records: 'all', search: 'x'.repeat(201), sort: 'username_asc', page: 1, pageSize: 25}));
    await assert.rejects(m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 30}));
    assert.equal(called, false);
  });

  await t.test('rejects replies that do not match the request or carry unexpected values', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const bad of [page({server_id: 3}), page({records: 'mum'}), page({items: [account(), account()]}), page({items: [account({plays: -1})]}),
      page({items: [account({avatar_url: 'https://plex.tv/a.png'})]}), page({items: [account({last_played: {title: 'x', source: 'other', media_type: '', parent_title: null}})]}),
      page({items: [account({uuid: 'nope'})]}), page({total_items: 'many'})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.fetchServerAccounts(2, {records: 'all', search: '', sort: 'username_asc', page: 1, pageSize: 25}), /Invalid|picture/);
    }
  });
});
