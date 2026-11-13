import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function load() {
  
  const m = await loadFrontend("export { syncLibraryCatalogue, purgeLibraryCatalogue, syncEpisodeCatalogue, purgeEpisodeCatalogue, syncChildCatalogue, purgeChildCatalogue } from './src/lib/libraryCatalogue';export {setAccessToken} from './src/store/authStore';");
  m.setAccessToken('session');
  return m;
}
const syncReceipt = (extra = {}) => ({ data: { success: true, library_id: 7, source_revision: 3, revision: 4, message: '2 added, 0 updated, 1 removed', result: { added: 2, updated: 0, removed: 1, total: 9 }, ...extra } });

test('library catalogue adapter', async t => {
  const before = { fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => { globalThis.fetch = before.fetch; globalThis.window = before.window; });
  globalThis.window = { location: { origin: 'http://mum.test' } };

  await t.test('sends one sync with the displayed revision and returns the committed receipt', async () => {
    const m = await load();
    const calls = [];
    globalThis.fetch = async (input, init) => { const req = new Request(input, init); calls.push({ url: req.url, method: req.method, body: await req.text() }); return Response.json(syncReceipt()); };
    const out = await m.syncLibraryCatalogue(7, 3);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url, 'http://mum.test').pathname, '/api/libraries/7/sync');
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].body), { expected_catalogue_revision: 3 });
    assert.deepEqual(out, { kind: 'committed', receipt: { libraryId: 7, revision: 4, added: 2, updated: 0, removed: 1, total: 9, message: '2 added, 0 updated, 1 removed' } });
  });

  await t.test('a TV Shows + Episodes sync asks for episodes and reports whether their run started', async () => {
    const m = await load();
    const urls = [];
    globalThis.fetch = async (input, init) => { urls.push(new Request(input, init).url); return Response.json(syncReceipt({ episodes: { started: true, shows: 12 } })); };
    const out = await m.syncLibraryCatalogue(7, 3, { episodes: true });
    assert.equal(new URL(urls[0]).pathname + new URL(urls[0]).search, '/api/libraries/7/sync?sync_episodes=true');
    assert.deepEqual(out.receipt.episodes, { started: true, shows: 12 });
    for (const episodes of [undefined, { started: 'yes', shows: 1 }, { started: true, shows: -1 }]) {
      globalThis.fetch = async () => Response.json(syncReceipt({ episodes }));
      assert.equal((await m.syncLibraryCatalogue(7, 3, { episodes: true })).kind, 'unconfirmed');
    }
  });

  await t.test('an album syncs and purges its tracks on the tracks routes with the same receipts', async () => {
    const m = await load();
    const paths = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(new Request(input, init).url).pathname;
      paths.push(url);
      return Response.json(url.endsWith('/purge')
        ? { data: { success: true, library_id: 7, item_id: 42, deleted_count: 9, revision: 3 } }
        : { data: { success: true, library_id: 7, item_id: 42, source_revision: 2, revision: 3, message: '9 added, 0 updated, 0 removed', result: { added: 9, updated: 0, removed: 0, total: 9 } } });
    };
    assert.equal((await m.syncChildCatalogue('tracks', 7, 42, 2)).receipt.added, 9);
    assert.deepEqual(await m.purgeChildCatalogue('tracks', 7, 42, 2), { kind: 'committed', receipt: { libraryId: 7, itemId: 42, revision: 3, deleted: 9 } });
    assert.deepEqual(paths, ['/api/libraries/7/media/42/tracks/sync', '/api/libraries/7/media/42/tracks/purge']);
  });

  await t.test('an application refusal is definitive and reported with its code', async () => {
    const m = await load();
    globalThis.fetch = async () => Response.json({ error: { code: 'CATALOGUE_SYNC_FAILED', message: 'Provider item synchronization failed; previous catalogue retained' } }, { status: 502 });
    assert.deepEqual(await m.syncLibraryCatalogue(7, 3), { kind: 'refused', code: 'CATALOGUE_SYNC_FAILED', message: 'Provider item synchronization failed; previous catalogue retained' });
  });

  await t.test('lost replies, proxy errors and mismatched receipts are unconfirmed and never replayed', async () => {
    const m = await load();
    const cases = [
      async () => { throw new TypeError('network'); },
      async () => new Response('<html>bad gateway</html>', { status: 502 }),
      async () => Response.json(syncReceipt({ library_id: 8 })),
      async () => Response.json(syncReceipt({ revision: 9 })),
      async () => Response.json(syncReceipt({ result: { added: -1, updated: 0, removed: 0, total: 0 } })),
      async () => Response.json({ data: { success: false } }),
    ];
    for (const respond of cases) {
      let calls = 0;
      globalThis.fetch = async (...args) => { calls += 1; return respond(...args); };
      const out = await m.syncLibraryCatalogue(7, 3);
      assert.equal(out.kind, 'unconfirmed');
      assert.match(out.message, /No request was replayed/);
      assert.equal(calls, 1);
    }
  });

  await t.test('an expired access token is not refreshed and retried for a mutation', async () => {
    const m = await load();
    const paths = [];
    globalThis.fetch = async (input, init) => { paths.push(new URL(new Request(input, init).url).pathname); return Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in required' } }, { status: 401 }); };
    const out = await m.purgeLibraryCatalogue(7, 3);
    assert.equal(out.kind, 'refused');
    assert.deepEqual(paths, ['/api/libraries/7/purge']);
  });

  await t.test('purge validates its receipt', async () => {
    const m = await load();
    globalThis.fetch = async () => Response.json({ data: { success: true, library_id: 7, deleted_count: 12, revision: 4 } });
    assert.deepEqual(await m.purgeLibraryCatalogue(7, 3), { kind: 'committed', receipt: { libraryId: 7, revision: 4, deleted: 12 } });
    globalThis.fetch = async () => Response.json({ data: { success: true, library_id: 7, deleted_count: 12, revision: 3 } });
    assert.equal((await m.purgeLibraryCatalogue(7, 3)).kind, 'unconfirmed');
  });
  await t.test('episode sync sends the episode revision once and checks the series in its receipt', async () => {
    const m = await load();
    const calls = [];
    const receipt = (extra = {}) => ({ data: { success: true, library_id: 7, item_id: 42, source_revision: 2, revision: 3, message: '1 added, 0 updated, 0 removed', result: { added: 1, updated: 0, removed: 0, total: 5 }, ...extra } });
    globalThis.fetch = async (input, init) => { const req = new Request(input, init); calls.push({ path: new URL(req.url).pathname, body: await req.text() }); return Response.json(receipt()); };
    const out = await m.syncEpisodeCatalogue(7, 42, 2);
    assert.deepEqual(calls, [{ path: '/api/libraries/7/media/42/episodes/sync', body: JSON.stringify({ expected_episode_revision: 2 }) }]);
    assert.equal(out.kind, 'committed');
    assert.equal(out.receipt.itemId, 42);
    globalThis.fetch = async () => Response.json(receipt({ item_id: 43 }));
    assert.equal((await m.syncEpisodeCatalogue(7, 42, 2)).kind, 'unconfirmed');
    globalThis.fetch = async () => Response.json({ error: { code: 'NOT_A_SERIES', message: 'Episodes exist only for series' } }, { status: 409 });
    assert.deepEqual(await m.syncEpisodeCatalogue(7, 42, 2), { kind: 'refused', code: 'NOT_A_SERIES', message: 'Episodes exist only for series' });
    globalThis.fetch = async () => Response.json({ data: { success: true, library_id: 7, item_id: 42, deleted_count: 5, revision: 3 } });
    assert.deepEqual(await m.purgeEpisodeCatalogue(7, 42, 2), { kind: 'committed', receipt: { libraryId: 7, itemId: 42, revision: 3, deleted: 5 } });
  });
});
