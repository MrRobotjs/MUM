import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

// A server's Overview re-reads the server whenever MUM announces a health
// change. That background re-read must never turn a passing failure into the
// page's "Server Not Found": it keeps the last good server instead.
const mocks = {
  filter: /^(react|swr)$|contexts\/AuthContext$/,
  module: p => p === 'react' ? 'export const useSyncExternalStore=(s,r)=>r();'
    : p === 'swr' ? 'export default (key,fetcher,options)=>{globalThis.detailHarness={key,fetcher,options};return globalThis.detailState;};'
    : "export const useAuth=()=>({user:{uuid:'admin'},isAdministrator:true});",
};
const load = () => loadFrontend("export {useServerDetail} from './src/hooks/useServers';export {setAccessToken} from './src/store/authStore';", {mock: mocks});

test('server detail background re-read', async t => {
  const before = {fetch: globalThis.fetch, window: globalThis.window};
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; delete globalThis.detailState; delete globalThis.detailHarness; });
  globalThis.window = {location: {origin: 'http://mum.test'}};
  const m = await load();
  m.setAccessToken('session');
  const server = {id: 3, server_nickname: 'Plex++', revision: 2};

  await t.test('a failed quiet re-read keeps the server and reports nothing', async () => {
    const calls = [];
    globalThis.detailState = {data: server, isLoading: false, mutate: (data, options) => { calls.push(options); return Promise.resolve(data).then(() => undefined); }};
    globalThis.fetch = async () => new Response('down', {status: 503});
    const detail = m.useServerDetail(3);
    assert.equal(detail.server, server);
    await assert.doesNotReject(detail.refreshQuietly());
    // It hands SWR the read as data, not a revalidation, so SWR never records an error.
    assert.deepEqual(calls, [{revalidate: false}]);
  });

  await t.test('a successful quiet re-read hands SWR the fresh server', async () => {
    let handed;
    globalThis.detailState = {data: server, isLoading: false, mutate: async (data) => { handed = await data; return handed; }};
    globalThis.fetch = async () => Response.json({data: {...server, server_nickname: 'Renamed', revision: 3}});
    await m.useServerDetail(3).refreshQuietly();
    assert.equal(handed.server_nickname, 'Renamed');
  });
});
