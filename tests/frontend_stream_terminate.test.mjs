import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// The Streams page stops a stream with one request to its observation, sends
// the trimmed message, checks the answer and never repeats a failed stop.
async function load() {
  return loadFrontend("export * from './src/lib/streamTerminate';export {setAccessToken} from './src/store/authStore';");
}

test('stream termination adapter', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = {location: {origin: 'http://mum.test'}};

  await t.test('sends one request for the observation with the trimmed message', async () => {
    const m = await load(); m.setAccessToken('session');
    const calls = [];
    globalThis.fetch = async req => { calls.push(req); return Response.json({data: {id: '42', status: 'terminated'}}); };
    await m.terminateStream('3:42', '  Server maintenance  ');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(new URL(calls[0].url).pathname, '/api/activity/current/42/terminate');
    assert.deepEqual(await calls[0].json(), {message: 'Server maintenance'});
  });

  await t.test('rejects malformed stream keys before any request', async () => {
    const m = await load(); m.setAccessToken('session');
    let called = false;
    globalThis.fetch = async () => { called = true; return Response.json({}); };
    for (const key of ['42', '3:', '3:4/../5', 'a:1', '3:42:1']) await assert.rejects(m.terminateStream(key, ''));
    assert.equal(called, false);
  });

  await t.test('server refusals surface their message and are not repeated', async () => {
    const m = await load(); m.setAccessToken('session');
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json({error: {code: 'TERMINATE_REFUSED', message: 'Plex only allows this when the server owner has Plex Pass.'}}, {status: 409}); };
    await assert.rejects(m.terminateStream('3:42', ''), /Plex Pass/);
    assert.equal(calls, 1);
  });

  await t.test('an unexpected answer is not treated as stopped', async () => {
    const m = await load(); m.setAccessToken('session');
    for (const data of [{id: '43', status: 'terminated'}, {id: '42', status: 'pending'}, null]) {
      globalThis.fetch = async () => Response.json({data});
      await assert.rejects(m.terminateStream('3:42', ''), /unexpected/);
    }
  });
});
