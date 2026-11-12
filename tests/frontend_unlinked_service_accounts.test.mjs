import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function load() {
  const r = await build({ stdin: { contents: "export { fetchUnlinkedServiceAccounts } from './src/lib/serviceAccounts';export {setAccessToken} from './src/store/authStore';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  const m = await import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`);
  m.setAccessToken('session');
  return m;
}
const id = n => `${String(n).padStart(8, '0')}-1234-1234-1234-123456789abc`;
const row = (n, extra = {}) => ({ uuid: id(n), user_type: 'service', username: `remote-${n}`, email: '', service_type: 'jellyfin', server_nickname: 'Fixture', linked_local_user: null, password_hash: 'private', ...extra });
const page = (rows, page, total) => ({ data: rows, meta: { pagination: { page, page_size: 100, total_items: total, total_pages: Math.ceil(total / 100) } } });

test('unlinked service account adapter', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };

  await t.test('pages the current users list completely with the unlinked service filter', async () => {
    const m = await load();
    const queries = [];
    const all = Array.from({ length: 150 }, (_, i) => row(i + 1));
    globalThis.fetch = async input => {
      const url = new URL(typeof input === 'string' ? input : input.url, 'http://mum.test');
      queries.push(url.search);
      assert.equal(url.pathname, '/api/users');
      assert.equal(url.searchParams.get('user_type'), 'service');
      assert.equal(url.searchParams.get('unlinked'), 'true');
      const n = Number(url.searchParams.get('page'));
      return Response.json(page(all.slice((n - 1) * 100, n * 100), n, 150));
    };
    const out = await m.fetchUnlinkedServiceAccounts();
    assert.equal(out.length, 150);
    assert.equal(queries.length, 2);
    assert.deepEqual(out[0], { uuid: id(1), service_type: 'jellyfin', server_name: 'Fixture', external_username: 'remote-1', external_email: null, avatar_url: null });
    assert.equal(JSON.stringify(out).includes('private'), false);
  });

  await t.test('linked, duplicate, changed or oversized directories fail instead of truncating', async () => {
    for (const [pages, message] of [
      [[page([row(1, { linked_local_user: { uuid: id(9) } })], 1, 1)], /Invalid service account list/],
      [[page([row(1), row(1)], 1, 2)], /Invalid service account list/],
      [[page([row(1, { user_type: 'local' })], 1, 1)], /Invalid service account list/],
      [[page(Array.from({ length: 100 }, (_, i) => row(i + 1)), 1, 150), page([row(200)], 2, 151)], /changed while loading/],
      [[page([row(1)], 1, 5001)], /Too many/],
      [[page([row(1)], 1, 3)], /changed while loading/],
    ]) {
      const m = await load();
      let call = 0;
      globalThis.fetch = async () => Response.json(pages[Math.min(call++, pages.length - 1)]);
      await assert.rejects(m.fetchUnlinkedServiceAccounts(), message);
    }
  });
});
