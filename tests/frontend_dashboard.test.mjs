import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function load() {
  
  const m = await loadFrontend("export * from './src/lib/dashboard';export {setAccessToken} from './src/store/authStore';");
  m.setAccessToken('session');
  return m;
}

async function loadHook() {
  
  return loadFrontend("export * from './src/lib/dashboard';export {setAccessToken} from './src/store/authStore';",{mock:{filter:/^(react|swr)$|contexts\/AuthContext$/,module:path=>(args => ({ contents: args.path === 'react'
      ? 'export const useSyncExternalStore = (subscribe, read) => read();'
      : args.path === 'swr'
        ? 'export default function useSWR(key, fetcher) { globalThis.dashboardHook.key=key;globalThis.dashboardHook.fetcher=fetcher;return {data:globalThis.dashboardHook.cache.get(JSON.stringify(key)),error:globalThis.dashboardHook.error,isLoading:false,mutate:()=>{}}; }'
        : 'export const useAuth = () => globalThis.dashboardHook.auth;' }))({path}).contents}});
}
const actor = '12345678-1234-1234-1234-123456789abc';
const server = (id, extra = {}) => ({ id, server_nickname: `Server ${id}`, service_type: 'jellyfin', effective_active: true, last_status: true, last_version: '10.9', last_status_check: '2026-11-05T00:00:00Z', api_key: 'never-shown', ...extra });

function route(handlers) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://mum.test');
    const method = init.method ?? (typeof input === 'string' ? 'GET' : input.method);
    calls.push(`${method} ${url.pathname}${url.search}`);
    const handler = handlers[`${method} ${url.pathname}`];
    return handler ? handler(url) : Response.json({ error: { code: 'NOT_FOUND', message: 'missing' } }, { status: 404 });
  };
  return calls;
}

test('dashboard adapters', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };

  await t.test('server health is derived from stored status; refresh probes active servers only', async () => {
    const m = await load();
    let probed = false;
    const calls = route({
      'GET /api/servers': () => Response.json({ data: [server(1), server(2, { last_status: probed ? true : false }), server(3, { effective_active: false, last_status: null }), server(4, { last_status: null, last_version: '' })] }),
      'POST /api/servers/1/test-connection': () => Response.json({ data: {} }),
      'POST /api/servers/2/test-connection': () => { probed = true; return Response.json({ data: {} }); },
      'POST /api/servers/4/test-connection': () => Response.json({ error: { code: 'UPSTREAM_FAILED', message: 'down' } }, { status: 502 }),
    });
    const stored = await m.fetchServerHealth();
    // A server turned off in MUM, or not checked yet, is not "offline".
    assert.deepEqual(stored.data.summary, { total_servers: 4, online: 1, offline: 1, disabled: 1, unchecked: 1 });
    assert.deepEqual(stored.data.servers.map(s => s.status), ['online', 'offline', 'disabled', 'unchecked']);
    assert.deepEqual(stored.data.servers[0], { id: 1, name: 'Server 1', service_type: 'jellyfin', status: 'online', version: '10.9', checked_at: '2026-11-05T00:00:00Z' });
    assert.equal(stored.data.servers[3].version, undefined);
    assert.equal(stored.data.servers[2].checked_at, '2026-11-05T00:00:00Z');
    assert.equal(JSON.stringify(stored).includes('never-shown'), false);
    assert.equal(calls.filter(c => c.startsWith('POST')).length, 0);
    const refreshed = await m.fetchServerHealth(true);
    assert.deepEqual(calls.filter(c => c.startsWith('POST')).sort(), ['POST /api/servers/1/test-connection', 'POST /api/servers/2/test-connection', 'POST /api/servers/4/test-connection']);
    assert.equal(refreshed.data.summary.online, 2);
    for (const bad of [[server(1), server(1)], [server(1, { last_status: 'yes' })], { not: 'array' }]) {
      route({ 'GET /api/servers': () => Response.json({ data: bad }) });
      await assert.rejects(m.fetchServerHealth(), /Invalid server list/);
    }
  });

  await t.test('recent events and watch statistics are validated', async () => {
    const m = await load();
    route({ 'GET /api/audit-events': () => Response.json({ data: [{ id: 3, timestamp: '2026-11-05T00:00:00Z', event_type: 'server.save', message: 'A media server was saved', details: { secret: 'x' } }] }) });
    const events = await m.fetchRecentEvents(5);
    assert.deepEqual(events.data, [{ id: 3, timestamp: '2026-11-05T00:00:00Z', event_type: 'server.save', message: 'A media server was saved' }]);
    for (const bad of [[{ id: 0, timestamp: 'x', event_type: 'a', message: 'b' }], Array.from({ length: 6 }, (_, i) => ({ id: i + 1, timestamp: '2026-11-05T00:00:00Z', event_type: 'a', message: 'b' }))]) {
      route({ 'GET /api/audit-events': () => Response.json({ data: bad }) });
      await assert.rejects(m.fetchRecentEvents(5), /Invalid recent activity/);
    }
    const stats = { days: 7, totals: { plays: 12, seconds: 7200, people: 3, titles: 9 },
      sections: [
        { kind: 'movies', items: [{ server_id: 2, title: 'Popular', subtitle: null, plays: 2, seconds: 5400, people: 1, played_at: null, user_uuid: null, library_id: null, library_type: null,  poster_url: '/api/activity/history-images/4?s=a&e=1&g=b', link: { library_id: 7, media_id: 70, episode_id: null } }] },
        { kind: 'users', items: [{ server_id: 0, title: 'viewer', subtitle: null, plays: 5, seconds: 900, people: 1, played_at: '2026-11-18T00:00:00Z', user_uuid: '11111111-1111-4111-8111-111111111111', library_id: null, library_type: null, poster_url: null, server_ids: [2, 4] }] },
        { kind: 'audiobooks', items: [{ server_id: 4, title: 'A Book', subtitle: 'An Author', plays: 1, seconds: 1200, people: 1, played_at: null, user_uuid: null, library_id: null, library_type: null,  poster_url: '/api/activity/imported-history-images/9?s=a&e=1&g=b' }] },
      ],
      platforms: [{ name: 'Roku', plays: 2, seconds: 600, server_ids: [2] }], server_id: null, order: 'plays',
      servers: [{ server_id: 2, name: 'Plex++', service_type: 'plex', imported_at: null }, { server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: null }],
      unreported: [{ server_id: 3, name: 'Comics', service_type: 'kavita', imported_at: null }],
      imported: [{ server_id: 4, name: 'Books', service_type: 'audiobookshelf', imported_at: '2026-11-17T00:00:00Z' }] };
    route({ 'GET /api/activity/statistics': url => { assert.equal(url.searchParams.get('days'), '7'); return Response.json({ data: stats }); } });
    const activity = await m.fetchActivityStats(7);
    assert.equal(activity.totals.plays, 12);
    assert.deepEqual(activity.sections.map(s => s.kind), ['movies', 'users', 'audiobooks']);
    assert.equal(activity.sections[1].items[0].user_uuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(activity.platforms[0].seconds, 600);
    assert.equal(activity.sections[2].items[0].subtitle, 'An Author');
    assert.equal(activity.unreported[0].name, 'Comics');
    assert.equal(activity.imported[0].imported_at, '2026-11-17T00:00:00Z');
    assert.equal(activity.sections[0].items[0].server_id, 2);
    assert.deepEqual(activity.servers.map(s => s.name), ['Plex++', 'Books']);
    // Catalogue links, and the servers a person or platform used.
    assert.deepEqual(activity.sections[0].items[0].link, { library_id: 7, media_id: 70, episode_id: null });
    assert.equal(activity.sections[2].items[0].link, null);
    assert.deepEqual(activity.sections[1].items[0].server_ids, [2, 4]);
    assert.deepEqual(activity.sections[0].items[0].server_ids, []);
    assert.deepEqual(activity.platforms[0].server_ids, [2]);
    // All time is days 0.
    route({ 'GET /api/activity/statistics': url => { assert.equal(url.searchParams.get('days'), '0'); return Response.json({ data: { ...stats, days: 0 } }); } });
    assert.equal((await m.fetchActivityStats(0)).days, 0);
    route({ 'GET /api/activity/statistics': url => { assert.equal(url.searchParams.get('order'), 'duration'); return Response.json({ data: { ...stats, order: 'duration' } }); } });
    assert.equal((await m.fetchActivityStats(7, null, 'duration')).order, 'duration');
    // One server: the filter is sent and the reply must be for that server.
    let asked;
    route({ 'GET /api/activity/statistics': url => { asked = url.searchParams.get('server'); return Response.json({ data: { ...stats, server_id: 4 } }); } });
    assert.equal((await m.fetchActivityStats(7, 4)).server_id, 4);
    assert.equal(asked, '4');
    route({ 'GET /api/activity/statistics': () => Response.json({ data: { ...stats, server_id: 2 } }) });
    await assert.rejects(m.fetchActivityStats(7, 4), /Invalid activity statistics/);
    for (const bad of [{ ...stats, days: 30 }, { ...stats, totals: { ...stats.totals, plays: -1 } }, { ...stats, sections: [{ kind: 'games', items: [] }] },
      { ...stats, sections: [{ kind: 'movies', items: [{ title: 'x', subtitle: null, plays: 1, seconds: 1, poster_url: 'https://plex.tv/p.jpg' }] }] },
      { ...stats, platforms: [{ name: 'x', plays: 'many', seconds: 1 }] }, { ...stats, order: 'duration' }, { ...stats, sections: [{ kind: 'movies', items: [{ server_id: 0, title: 'x', subtitle: null, plays: 1, seconds: 1, poster_url: null }] }] }, { ...stats, unreported: [{ server_id: 0, name: 'x', service_type: 'kavita', imported_at: null }] },
      { ...stats, sections: [{ kind: 'movies', items: [{ ...stats.sections[0].items[0], link: { library_id: 0, media_id: 1, episode_id: null } }] }] },
      { ...stats, sections: [{ kind: 'users', items: [{ ...stats.sections[1].items[0], server_ids: ['2'] }] }] }]) {
      route({ 'GET /api/activity/statistics': () => Response.json({ data: bad }) });
      await assert.rejects(m.fetchActivityStats(7), /Invalid activity statistics/);
    }
  });

  await t.test('late reads after session replacement are rejected and authentication failures are never replayed', async () => {
    const m = await load();
    let finish;
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = m.fetchRecentEvents();
    m.setAccessToken('replacement');
    finish(Response.json({ data: [] }));
    await assert.rejects(pending, /session changed/);
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ error: { message: 'Sign in' } }, { status: 401 }); };
    await assert.rejects(m.fetchActivityStats());
    assert.equal(requests, 1);
  });

  await t.test('account changes stop further server probes and final reads', async () => {
    const m = await load();
    const calls = route({
      'GET /api/servers': () => Response.json({ data: Array.from({ length: 5 }, (_, i) => server(i + 1)) }),
      ...Object.fromEntries([1, 2, 3, 4].map(id => [`POST /api/servers/${id}/test-connection`, () => { m.setAccessToken('another-session'); return Response.json({ data: {} }); }])),
    });
    await assert.rejects(m.fetchServerHealth(true), /session changed/);
    assert.equal(calls.filter(c => c.startsWith('POST')).length, 1);
    assert.equal(calls.some(c => c.includes('/5/test-connection')), false);
    assert.equal(calls.filter(c => c === 'GET /api/servers').length, 1);
  });

  await t.test('dashboard hook isolates session caches, rejects late results and hides data without administrator authority', async () => {
    const m = await loadHook();
    const previous = globalThis.dashboardHook;
    try {
      const state = globalThis.dashboardHook = { auth: { user: { uuid: actor }, isAdministrator: true }, cache: new Map() };
      m.setAccessToken('first-session');
      m.useDashboardData('dashboard:recent-events', async () => 'unused');
      const firstKey = JSON.stringify(state.key);
      state.cache.set(firstKey, 'private first-session data');
      assert.equal(m.useDashboardData('dashboard:recent-events', async () => null).data, 'private first-session data');
      let finish;
      m.useDashboardData('dashboard:recent-events', () => new Promise(resolve => { finish = resolve; }));
      const pending = state.fetcher();
      m.setAccessToken('second-session');
      finish('late private data');
      await assert.rejects(pending, /session changed/);
      assert.equal(m.useDashboardData('dashboard:recent-events', async () => null).data, null);
      assert.notEqual(JSON.stringify(state.key), firstKey);
      state.auth.isAdministrator = false;
      assert.equal(m.useDashboardData('dashboard:recent-events', async () => null).data, null);
      assert.equal(state.key, null);
      state.auth.isAdministrator = true;
      m.setAccessToken(null);
      assert.equal(m.useDashboardData('dashboard:recent-events', async () => null).data, null);
      assert.equal(state.key, null);
    } finally { globalThis.dashboardHook = previous; }
  });
});
