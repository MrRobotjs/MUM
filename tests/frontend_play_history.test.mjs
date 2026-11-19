import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A Plex, Jellyfin, Emby or Audiobookshelf server page reads the play history
// import status, starts an import with one request (never repeated on failure)
// and describes the result in the server's name.
async function load() {
  return loadFrontend("export * from './src/lib/playHistory';export {setAccessToken} from './src/store/authStore';");
}

const status = (extra = {}) => ({server_id: 3, state: 'completed', started_at: '2026-11-15T10:00:00Z', finished_at: '2026-11-15T10:01:00Z', total: 9533, read: 9533,
  added: 9400, already_stored: 0, already_recorded: 133, unknown_accounts: 12, error_code: null, stored_plays: 9400, oldest_play: '2024-04-30T18:00:00.000000000Z',
  newest_play: '2026-11-15T09:00:00.000000000Z', mum_since: '2026-11-06T07:00:46.446411724Z', ...extra});
// Dates appear as the account shows them: here UTC, in this machine's locale.
const utc = {mode: 'utc', time_format: '24', time_zone: null}, tokyo = {mode: 'named', time_format: '24', time_zone: 'Asia/Tokyo'};
const shown = (instant, zone = 'UTC') => new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short', day: 'numeric', timeZone: zone}).format(new Date(instant));

test('play history adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('reads and describes the status', async () => {
    const m = await load(); m.setAccessToken('session');
    let path = '';
    globalThis.fetch = async req => { path = new URL(req.url).pathname; return Response.json({data: status()}); };
    const s = await m.readPlayHistory(3);
    assert.equal(path, '/api/servers/3/play-history');
    assert.equal(m.playHistorySummary(s, 'plex', utc), `Last import added 9,400 plays (133 already recorded by MUM). MUM holds 9,400 Plex plays from ${shown('2024-04-30T18:00:00Z')}.`);
    // The oldest play's day follows the account's timezone (18:00 UTC is the next day in Tokyo).
    assert.equal(m.playHistorySummary(s, 'plex', tokyo), `Last import added 9,400 plays (133 already recorded by MUM). MUM holds 9,400 Plex plays from ${shown('2024-04-30T18:00:00Z', 'Asia/Tokyo')}.`);
    assert.notEqual(shown('2024-04-30T18:00:00Z', 'Asia/Tokyo'), shown('2024-04-30T18:00:00Z'));
    // Before the display settings are read the date is left out rather than guessed.
    assert.equal(m.playHistorySummary(s, 'plex'), 'Last import added 9,400 plays (133 already recorded by MUM).');
    assert.equal(m.playHistorySummary({...s, state: 'never', stored_plays: 0, oldest_play: null}, 'plex'), 'Not imported yet.');
    assert.equal(m.playHistorySummary({...s, state: 'running', read: 1000}, 'plex'), 'Importing: 1,000 of 9,533 entries read.');
    assert.equal(m.playHistorySummary({...s, state: 'failed', error_code: 'server_read_failed', added: 500, stored_plays: 500}, 'plex', utc), `The last import stopped because Plex could not be read; 500 plays were added before that. MUM holds 500 Plex plays from ${shown('2024-04-30T18:00:00Z')}.`);
    assert.equal(m.playHistorySummary({...s, state: 'stopped', error_code: 'interrupted', added: 0, stored_plays: 0, oldest_play: null}, 'plex'), 'The last import was interrupted when MUM stopped; 0 plays were added before that.');
  });

  await t.test('the purge dialog notice recommends importing until an import finishes', async () => {
    const m = await load();
    assert.equal(m.playHistoryNotice(status(), 'Plex++'), null);
    assert.deepEqual(m.playHistoryNotice(status({state: 'never'}), 'Plex++', utc), {title: 'Plex++: play history not imported',
      body: `MUM only knows plays it has seen since ${shown('2026-11-06T07:00:46Z')}, so people who watched before then may look inactive. Importing the server's own play history fixes this; it only reads from Plex.`});
    assert.equal(m.playHistoryNotice(status({state: 'failed', error_code: 'server_read_failed'}), 'Plex++').title, 'Plex++: play history import did not finish');
    assert.match(m.playHistoryNotice(status({state: 'never', mum_since: null}), 'Plex++').body, /^MUM has not recorded any plays on this server yet, so/);
    assert.deepEqual(m.playHistoryNotice(status({state: 'running', read: 1000}), 'Plex++'), {title: 'Plex++: importing play history', body: 'Importing: 1,000 of 9,533 entries read.'});
  });

  await t.test('rejects malformed statuses', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const bad of [status({state: 'done'}), status({added: -1}), status({server_id: 4}), status({stored_plays: '1'}), status({mum_since: 5}), status({mum_since: undefined})]) {
      globalThis.fetch = async () => Response.json({data: bad});
      await assert.rejects(m.readPlayHistory(3), /Invalid play history status/);
    }
  });

  await t.test('starts an import with one request and does not repeat a refusal', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push(req); return Response.json({data: {server_id: 3, state: 'running', started_at: '2026-11-15T10:00:00Z'}}, {status: 202}); };
    await m.startPlayHistoryImport(3);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/servers/3/play-history/import');
    let refused = 0;
    globalThis.fetch = async () => { refused++; return Response.json({error: {code: 'HISTORY_RUNNING', message: 'An import is already running for this server.'}}, {status: 409}); };
    await assert.rejects(m.startPlayHistoryImport(3), /already running/);
    assert.equal(refused, 1);
    await assert.rejects(m.startPlayHistoryImport(0));
  });

  await t.test('names the server in the summary', async () => {
    const m = await load();
    assert.equal(m.playHistorySummary(status({added: 3, already_recorded: 0, stored_plays: 3}), 'jellyfin', utc), `Last import added 3 plays. MUM holds 3 Jellyfin plays from ${shown('2024-04-30T18:00:00Z')}.`);
    assert.equal(m.playHistorySummary(status({state: 'failed', error_code: 'server_read_failed', added: 1, stored_plays: 0, oldest_play: null}), 'audiobookshelf'),
      'The last import stopped because Audiobookshelf could not be read; 1 play was added before that.');
    assert.deepEqual(['plex', 'jellyfin', 'emby', 'audiobookshelf', 'kavita'].map(m.importsHistory), [true, true, true, true, false]);
  });
});
