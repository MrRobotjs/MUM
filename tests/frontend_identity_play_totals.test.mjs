import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFrontend } from './frontendLoader.mjs';

// The Profile tab's activity: play totals counted like the History tab, and
// what the person is playing now, in plain words.
const load = () => loadFrontend("export * from './src/lib/identityPlayTotals';export {setAccessToken} from './src/store/authStore';");
const actor = '12345678-1234-1234-1234-123456789abc', target = '12345678-1234-1234-1234-123456789def';
const periods = () => [['day', '0', '0', '0'], ['week', '19', '19', '10620'], ['month', '22', '20', '24600'], ['all', '9007199254740993', '2045', '12435480']]
  .map(([period, plays, timed_plays, seconds]) => ({ period, plays, timed_plays, seconds }));
const totals = (source = 'all') => ({ actor_uuid: actor, scope: 'all', target_uuid: target, source, sources: ['plex', 'jellyfin'], imported_plays: '9007199254738948', periods: periods(),
  last_play: { source: 'plex', media_type: 'episode', title: 'Pilot', parent_title: 'A Show', played_at: '2026-11-01T04:00:00.000000000Z', poster_url: '/api/activity/imported-history-images/4?x=1' },
  players: [{ client: 'Infuse', plays: '2' }, { client: 'Plex Web', plays: '1' }] });

test('play totals adapter', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };

  await t.test('reads exact counts for one person and one source', async () => {
    const m = await load(); m.setAccessToken('session');
    let url;
    globalThis.fetch = async req => { url = new URL(req.url); return Response.json({ data: totals('plex') }); };
    const p = await m.fetchIdentityPlayTotals(actor, target, 'all', 'plex');
    assert.equal(url.pathname, `/api/activity/identities/${target}/plays`);
    assert.equal(url.search, '?scope=all&source=plex');
    assert.equal(p.periods[3].plays, '9007199254740993');
    assert.deepEqual(p.sources, ['plex', 'jellyfin']);
    assert.equal(p.last_play.title, 'Pilot');
    globalThis.fetch = async () => Response.json({ data: { ...totals(), last_play: null, players: [] } });
    assert.equal((await m.fetchIdentityPlayTotals(actor, target, 'all', 'all')).last_play, null);
  });

  await t.test('refuses answers for someone else or that do not add up', async () => {
    const bad = [{ target_uuid: actor }, { actor_uuid: target }, { scope: 'own' }, { source: 'mum' }, { sources: ['plex', 'plex'] }, { sources: ['kodi'] }, { imported_plays: '-1' },
      { periods: periods().slice(0, 3) }, { periods: periods().map(p => p.period === 'week' ? { ...p, timed_plays: '20' } : p) },
      { periods: periods().map(p => p.period === 'week' ? { ...p, period: 'month' } : p) }, { periods: periods().map(p => p.period === 'all' ? { ...p, plays: '21' } : p) },
      { last_play: { ...totals().last_play, played_at: 'yesterday' } }, { last_play: { ...totals().last_play, source: 'kodi' } },
      { last_play: { ...totals().last_play, poster_url: 'https://evil.example/x' } }, { players: [{ client: '', plays: '1' }] }, { players: [{ client: 'A', plays: '0' }] }, { players: null }];
    for (const change of bad) {
      const m = await load(); m.setAccessToken('session');
      globalThis.fetch = async () => Response.json({ data: { ...totals(), ...change } });
      await assert.rejects(m.fetchIdentityPlayTotals(actor, target, 'all', 'all'), /Invalid/, JSON.stringify(change));
    }
  });

  await t.test('never asks for a malformed person or source', async () => {
    const m = await load(); m.setAccessToken('session');
    let calls = 0; globalThis.fetch = async () => { calls++; throw Error('must not fetch'); };
    for (const value of ['', 'name', '../other']) await assert.rejects(m.fetchIdentityPlayTotals(actor, value, 'all', 'all'));
    await assert.rejects(m.fetchIdentityPlayTotals(actor, target, 'all', 'kodi'));
    assert.equal(calls, 0);
  });
});

test('watched time reads like Tautulli', async () => {
  const m = await load();
  const text = s => m.watchTime(s).map(([v, u]) => `${v} ${u}`).join(' ');
  assert.equal(text('0'), '0 mins');
  assert.equal(text('59'), '0 mins');
  assert.equal(text('60'), '1 min');
  assert.equal(text('10620'), '2 hrs 57 mins');
  assert.equal(text('3600'), '1 hr 0 mins');
  assert.equal(text('12435480'), '143 days 22 hrs 18 mins');
  assert.equal(text('86400'), '1 day 0 hrs 0 mins');
});

const page = (overrides = {}, server = {}) => ({ actor_uuid: actor, target_uuid: target, scope: 'all', read_at: '2026-11-17T10:00:00Z', next_before: null,
  servers: [{ server_id: '3', provider: 'jellyfin', freshness: 'fresh', ...server }],
  items: [{ id: '1', server_id: '3', service_uuid: target, item_id: 'x', media_type: 'Episode', title: 'Pilot', parent_title: 'A Show', first_observed_at: '2026-11-17T09:00:00Z',
    last_observed_at: '2026-11-17T09:58:00Z', ended_observation_at: null, end_reason: null, paused: false, position_ticks: '9000000000', duration_ticks: '36000000000', ...overrides }] });

test('now playing reads in plain words and only while the server is up to date', async () => {
  const m = await load();
  const names = new Map([['3', 'Living room']]);
  const now = m.nowPlaying(page(), target, names);
  assert.deepEqual({ ...now, items: undefined }, { title: 'Pilot', subtitle: 'A Show', paused: false, serverName: 'Living room', serviceType: 'jellyfin', progress: 25,
    position: '0:15:00', duration: '1:00:00', updatedAt: '2026-11-17T09:58:00Z', others: 0, items: undefined });
  assert.equal(m.nowPlaying(page({ paused: true }), target, names).paused, true);
  // Without a nickname the service's name stands in; unknown progress stays unknown.
  const plain = m.nowPlaying(page({ position_ticks: null, parent_title: undefined }), target, new Map());
  assert.equal(plain.serverName, 'Jellyfin');
  assert.equal(plain.progress, null);
  assert.equal(plain.subtitle, null);
  // A server MUM has not heard from lately is not shown as playing.
  for (const freshness of ['stale', 'unknown', 'offline']) assert.equal(m.nowPlaying(page({}, { freshness }), target, names), null, freshness);
  assert.equal(m.nowPlaying(page(), actor, names), null, 'another person');
  assert.equal(m.nowPlaying(undefined, target, names), null);
  const two = page(); two.items.push({ ...two.items[0], id: '2', title: 'Second' });
  assert.equal(m.nowPlaying(two, target, names).others, 1);
});
