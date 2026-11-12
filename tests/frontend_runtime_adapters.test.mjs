import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function loadAdapters(realtime = false) {
  const result = await build({
    stdin: { contents: `export * from './src/store/authStore'; export { apiFetch } from './src/util/apiClient'; export { fetchProfileAccountLinks } from './src/lib/serviceAccounts'; ${realtime ? "export * from './src/lib/realtimeSocket';" : ''}`, resolveDir: directory },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}

test('current Go frontend adapters', async t => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const previousSocket = globalThis.WebSocket;
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; globalThis.WebSocket = previousSocket; });
  globalThis.window = { location: { origin: 'http://mum.test', href: 'http://mum.test/admin', protocol: 'http:' }, sessionStorage: { setItem() {} } };

  await t.test('parallel 401 responses share one refresh rotation', async () => {
    const api = await loadAdapters();
    api.setAccessToken('old');
    let rotations = 0;
    globalThis.fetch = async input => {
      if (input === '/api/auth/refresh') {
        rotations++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return Response.json({ data: { access_token: 'new' } });
      }
      return new Response('', { status: input.headers.get('Authorization') === 'Bearer new' ? 200 : 401 });
    };
    const responses = await Promise.all(Array.from({ length: 6 }, () => api.apiFetch('http://mum.test/api/users')));
    assert.equal(rotations, 1);
    assert.ok(responses.every(response => response.status === 200));
  });

  await t.test('logout prevents an in-flight refresh from restoring authentication', async () => {
    const api = await loadAdapters();
    api.setAccessToken('old');
    let complete;
    globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
    const refresh = api.refreshAccessToken();
    api.clearAccessToken();
    complete(Response.json({ data: { access_token: 'late' } }));
    assert.equal(await refresh, null);
    assert.equal(api.getAccessToken(), null);
  });

  await t.test('failed network mutations are not automatically replayed', async () => {
    const api = await loadAdapters();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('network'); };
    await assert.rejects(api.apiFetch('http://mum.test/api/chat', { method: 'POST', body: '{}' }), /network/);
    assert.equal(calls, 1);
    await assert.rejects(api.apiFetch('http://other.test/api/chat'), /this origin/);
    assert.equal(calls, 1);
  });

  await t.test('account selectors read one exact authorized snapshot', async () => {
    const api = await loadAdapters();
    api.setAccessToken('selector-session');
    const actor='12345678-1234-1234-1234-123456789abc', target='12345678-1234-1234-1234-123456789def';
    let calls=0;
    globalThis.fetch = async request => {
      calls++;
      const url = new URL(request.url);
      assert.equal(url.pathname, `/api/account-links/${target}/accounts`);
      assert.equal(url.search, '');
      return Response.json({data:{actor_uuid:actor,user_uuid:target,role_revision:'1',link_revision:'1',profile_revision:'1',can_link:true,can_unlink:true,
        linked_accounts:[],available_accounts:[{uuid:actor,external_username:'Reader',external_email:'',service_type:'kavita',server_name:'Books'}]}});
    };
    const result = await api.fetchProfileAccountLinks(actor,target);
    assert.equal(calls, 1);
    assert.equal(result.available_accounts[0].external_username, 'Reader');
  });

  await t.test('native WebSocket authentication, subscriptions and delivery', async () => {
    const instances = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 0;
      sent = [];
      constructor(url) { this.url = url; instances.push(this); }
      send(message) { this.sent.push(JSON.parse(message)); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    globalThis.WebSocket = FakeSocket;
    const api = await loadAdapters(true);
    api.setAccessToken('current-token');
    const received = [];
    const unsubscribe = api.subscribeToChannel('chat.global', event => received.push(event));
    assert.equal(instances.length, 1);
    const socket = instances[0];
    assert.equal(socket.url.pathname, '/ws');
    socket.readyState = 1;
    socket.onopen();
    assert.deepEqual(socket.sent[0], { type: 'authenticate', access_token: 'current-token' });
    socket.onmessage({ data: JSON.stringify({ type: 'authenticated' }) });
    assert.deepEqual(socket.sent[1], { type: 'subscribe', channels: ['chat.global'] });
    socket.onmessage({ data: JSON.stringify({ type: 'event', event: { channel: 'chat.global', type: 'ChatMessage', payload: { message: 'hello' } } }) });
    assert.equal(received[0].payload.message, 'hello');
    unsubscribe();
    assert.deepEqual(socket.sent.at(-1), { type: 'unsubscribe', channels: ['chat.global'] });
    api.disconnectRealtimeSocket();
    assert.equal(api.getRealtimeState().connected, false);
  });
});
