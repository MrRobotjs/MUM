import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The purge dialog lists inactive Plex accounts from the server, shows where
// each last play came from, and removes the chosen ones through one prepared
// delete edit carrying the purge rule; nothing is sent twice.
async function load() {
  return loadFrontend("export * from './src/lib/purge';export {EditOperationsClient} from './src/lib/editOperations';export {setAccessToken} from './src/store/authStore';");
}

const rule = {inactive_days: 90, exclude_sharers: true, exclude_whitelisted: false, ignore_creation_date: true};
const row = (extra = {}) => ({uuid: 'u-1', username: 'reader', email: null, server_id: 3, server_name: 'Plex++', service_type: 'plex', avatar_url: null,
  created_at: '2024-01-01T00:00:00Z', last_streamed_at: '2026-03-12T20:00:00Z', last_play_source: 'plex_history', last_login_at: null,
  days_since_activity: 248, is_sharer: false, is_whitelisted: false, ...extra});

test('purge adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads candidates with the rule in the query', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push(req); return Response.json({data: {users: [row(), row({uuid: 'u-2', last_streamed_at: null, last_play_source: null})], criteria: rule}}); };
    const users = await m.readPurgeCandidates(rule);
    assert.equal(calls.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, '/api/users/eligible-for-purge');
    assert.deepEqual(Object.fromEntries(url.searchParams), {inactive_days: '90', exclude_sharers: 'true', exclude_whitelisted: 'false', ignore_creation_date: 'true'});
    assert.deepEqual(users.map(u => u.uuid), ['u-1', 'u-2']);
    // The day is shown in the account's timezone: 20:00 UTC is already the next day in Tokyo.
    const day = zone => new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric', timeZone: zone}).format(new Date('2026-03-12T20:00:00Z'));
    const utc = {mode: 'utc', time_format: '24', time_zone: null}, tokyo = {mode: 'named', time_format: '24', time_zone: 'Asia/Tokyo'};
    assert.equal(m.lastPlayLabel(users[0], utc), `Last played ${day('UTC')} (Plex history)`);
    assert.equal(m.lastPlayLabel(users[0], tokyo), `Last played ${day('Asia/Tokyo')} (Plex history)`);
    assert.notEqual(day('UTC'), day('Asia/Tokyo'));
    assert.equal(m.lastPlayLabel(users[1], utc), 'Never played');
    assert.equal(m.lastPlayLabel({...users[0], last_play_source: 'mum'}, utc), `Last played ${day('UTC')} (MUM)`);
  });

  await t.test('rejects an invalid rule before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    for (const days of [0, -1, 1.5, Number.NaN, 36501]) await assert.rejects(m.readPurgeCandidates({...rule, inactive_days: days}));
    assert.equal(called, false);
  });

  await t.test('rejects malformed candidates', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const bad of [row({uuid: ''}), row({last_play_source: 'guess'}), row({last_streamed_at: null}), row({days_since_activity: '3'}), row({is_sharer: 'no'}), row({service_type: 'jellyfin'})]) {
      globalThis.fetch = async () => Response.json({data: {users: [bad], criteria: rule}});
      await assert.rejects(m.readPurgeCandidates(rule), /Invalid purge/);
    }
    globalThis.fetch = async () => Response.json({data: {users: [row(), row()], criteria: rule}});
    await assert.rejects(m.readPurgeCandidates(rule), /Invalid purge/);
  });

  await t.test('removes the chosen accounts with one prepared delete carrying the rule', async () => {
    const m = await load(); m.setAccessToken('session');
    const requests = [];
    const receipt = (state, summary) => ({id: 'op-1', revision: '1', state, action: 'delete_users', results: [{uuid: 'u-1', outcome: state === 'completed' ? 'deleted' : 'pending', reason: ''}],
      summary: {updated: 0, deleted: 0, unchanged: 0, skipped: 0, failed: 0, unknown: 0, pending: 0, ...summary}, warnings: [], effects: []});
    globalThis.fetch = async req => {
      const body = req.method === 'POST' ? await req.json() : null;
      requests.push({path: new URL(req.url).pathname, body});
      if (requests.length === 1) return Response.json({data: receipt('prepared', {pending: 1})}, {status: 201});
      return Response.json({data: receipt('completed', {deleted: 1})});
    };
    const done = await m.purgeUsers(new m.EditOperationsClient(), ['u-1'], rule);
    assert.equal(done.summary.deleted, 1);
    assert.equal(requests[0].path, '/api/users/edit/prepare');
    assert.deepEqual(requests[0].body.user_uuids, ['u-1']);
    assert.deepEqual(requests[0].body.operation, {action: 'delete_users', purge: rule});
    assert.equal(requests[1].path, '/api/edit-operations/op-1/execute');
    assert.equal(requests.length, 2);
    await assert.rejects(m.purgeUsers(new m.EditOperationsClient(), [], rule));
  });
});
