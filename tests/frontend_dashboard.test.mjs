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
    assert.deepEqual(stored.data.summary, { total_servers: 4, online: 1, offline: 3 });
    assert.equal(stored.data.servers[1].error_message, 'Last connection check failed');
    assert.equal(stored.data.servers[2].error_message, 'Disabled');
    assert.equal(stored.data.servers[3].error_message, 'Not checked yet');
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

  await t.test('active streams use administrator activity with names, servers and progress', async () => {
    const m = await load();
    const item = (id, extra = {}) => ({ id, server_id: '1', service_uuid: '22345678-1234-1234-1234-123456789abc', owner_uuid: actor, item_id: 'movie', media_type: 'Movie', title: `Title ${id}`, first_observed_at: '2026-11-05T00:00:00Z', last_observed_at: '2026-11-05T00:01:00Z', ended_observation_at: null, end_reason: null, paused: false, position_ticks: '300', duration_ticks: '1200', ...extra });
    const calls = route({
      'GET /api/activity/current': url => { assert.equal(url.searchParams.get('scope'), 'all'); return Response.json({ data: { actor_uuid: actor, scope: 'all', read_at: '2026-11-05T00:02:00Z', items: [item('9', { owner_name: 'viewer' }), item('8', { paused: true, owner_uuid: undefined, service_username: 'remote', duration_ticks: null })], servers: [{ server_id: '1', provider: 'jellyfin', observed_at: '2026-11-05T00:02:00Z', age_seconds: 1, freshness: 'fresh', pending: 'none', last_result: 'fresh' }], next_before: null } }); },
      'GET /api/servers': () => Response.json({ data: [server(1)] }),
    });
    const streams = await m.fetchActiveStreams(actor);
    assert.equal(streams.data.count, 2);
    assert.deepEqual(streams.data.sessions[0], { id: '9', title: 'Title 9', state: 'playing', user: { name: 'viewer' }, server: { name: 'Server 1', service_type: 'jellyfin' }, progress_percent: 25 });
    assert.equal(streams.data.sessions[1].user.name, 'remote');
    assert.equal(streams.data.sessions[1].state, 'paused');
    assert.equal('progress_percent' in streams.data.sessions[1], false);
    assert.ok(calls.some(c => c.startsWith('GET /api/activity/current')));
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
    const stats = { days: 7, top_movies: [{ title: 'Popular', plays: 2, duration: '1h 30m' }], top_shows: [], top_platforms: [], totals: { total_plays: 4, total_duration: '3h 00m', unique_titles: 3, unique_users: 1, avg_session_length: '45m', peak_day_streams: 3 } };
    route({ 'GET /api/activity/statistics': url => { assert.equal(url.searchParams.get('days'), '7'); return Response.json({ data: stats }); } });
    const watch = await m.fetchWatchStats(7);
    assert.equal(watch.data.totals.total_plays, 4);
    assert.equal(watch.data.top_movies[0].title, 'Popular');
    for (const bad of [{ ...stats, days: 30 }, { ...stats, totals: { ...stats.totals, total_plays: -1 } }, { ...stats, top_movies: [{ title: '', plays: 1, duration: '1m' }] }, { ...stats, top_platforms: [{ name: 'x', plays: 'many', duration: '1m' }] }]) {
      route({ 'GET /api/activity/statistics': () => Response.json({ data: bad }) });
      await assert.rejects(m.fetchWatchStats(7), /Invalid watch statistics/);
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
    await assert.rejects(m.fetchWatchStats());
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
