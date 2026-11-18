import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// Importing one person's history from one server, from the History tab.
async function load() {
  return loadFrontend("export * from './src/lib/personHistoryImport';export {setAccessToken} from './src/store/authStore';");
}

const target = '22222222-2222-4222-8222-222222222222';
const status = (extra = {}) => ({server_id: 1, support: 'account', state: 'completed', started_at: '2026-11-17T10:00:00Z', finished_at: '2026-11-17T10:01:00Z',
  added: 4, person_added: 3, already_stored: 2, already_recorded: 1, error_code: null, scope: 'account', ...extra});

test('person history import adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads the status of one server', async () => {
    const m = await load(); m.setAccessToken('session');
    let seen;
    globalThis.fetch = async req => { seen = new URL(req.url); return Response.json({data: status()}); };
    const result = await m.fetchPersonHistoryImport(target, '1');
    assert.equal(seen.pathname + seen.search, `/api/activity/identities/${target}/history-import?server=1`);
    assert.deepEqual([result.support, result.state, result.person_added, result.scope], ['account', 'completed', 3, 'account']);
    for (const bad of [status({server_id: 2}), status({support: 'some'}), status({state: 'done'}), status({added: -1}), status({scope: 'all'}), status({error_code: 3}), status({person_added: -1}), status({person_added: undefined})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.fetchPersonHistoryImport(target, '1'), /Invalid/);
    }
  });

  await t.test('starts once and reports why a start was refused', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push([req.method, await req.text()]); return Response.json({data: {server_id: 1, state: 'running', started_at: '2026-11-17T10:00:00Z'}}, {status: 202}); };
    assert.equal(await m.startPersonHistoryImport(target, '1'), 'started');
    assert.deepEqual(calls, [['POST', JSON.stringify({server_id: 1})]]);
    for (const [code, result] of [['HISTORY_RUNNING', 'busy'], ['HISTORY_FULL_IMPORT_ONLY', 'full_import_only'], ['HISTORY_UNAVAILABLE', 'unavailable']]) {
      globalThis.fetch = async () => Response.json({error: {code, message: 'refused'}}, {status: 409});
      assert.equal(await m.startPersonHistoryImport(target, '1'), result);
    }
    globalThis.fetch = async () => Response.json({error: {code: 'NOT_FOUND', message: 'missing'}}, {status: 404});
    await assert.rejects(m.startPersonHistoryImport(target, '1'));
  });

  await t.test('says only what the import brought for this person', async () => {
    const m = await load();
    // A full Jellyfin import reads every user: the other users' counts aren't shown.
    assert.equal(m.personImportSummary(status({scope: 'server', added: 12, person_added: 0, already_stored: 427})), 'Import finished: nothing new to import for them.');
    assert.equal(m.personImportSummary(status()), 'Import finished: 3 new plays for them.');
    assert.equal(m.personImportSummary(status({person_added: 1})), 'Import finished: 1 new play for them.');
    assert.equal(m.personImportSummary(status({state: 'failed', error_code: 'server_read_failed', person_added: 1})), 'The import stopped because the server could not be read; 1 new play for them was added before that.');
    assert.equal(m.personImportSummary(status({state: 'stopped', error_code: 'shutdown', person_added: 0})), 'The import stopped because MUM stopped; no new plays for them were added before that.');
  });

  await t.test('rejects bad input before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    await assert.rejects(m.fetchPersonHistoryImport('nope', '1'));
    await assert.rejects(m.fetchPersonHistoryImport(target, '0'));
    await assert.rejects(m.startPersonHistoryImport(target, '1x'));
    assert.equal(called, false);
  });
});
