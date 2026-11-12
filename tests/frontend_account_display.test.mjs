import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function load() {
  const result = await build({ stdin: { contents: "export * from './src/lib/accountDisplay'; export {setAccessToken,getAccessToken} from './src/store/authStore';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
const user = '12345678-1234-1234-1234-123456789abc', other = '87654321-1234-1234-1234-123456789abc';
const values = (mode = 'device', time_format = '12', time_zone = null) => ({ mode, time_format, time_zone });
const state = (revision = 1, display = values()) => ({ user_uuid: user, profile_revision: revision, display });

test('account display adapters and timestamp consumers', async t => {
  const oldFetch = globalThis.fetch, oldWindow = globalThis.window;
  t.after(() => { globalThis.fetch = oldFetch; globalThis.window = oldWindow; });
  const reset = () => { globalThis.window = { location: { origin: 'http://mum.test' } }; };
  await t.test('validates actor, revision, modes and concrete browser-supported zones', async () => {
    const a = await load();
    assert.deepEqual(a.displayRecord({ ...state(), secret: 'private' }, user), state());
    for (const invalid of [{ ...state(), user_uuid: other }, state(0), state(1, values('local')), state(1, values('named', '24', 'Local')), state(1, values('named', '24', '../etc/passwd')), state(1, values('named', '24', 'Missing/Zone')), state(1, values('utc', '24', 'UTC')), state(1, values('device', 'auto'))]) assert.throws(() => a.displayRecord(invalid, user));
  });
  await t.test('UTC rollover, named winter/summer DST and 12/24 clocks affect real instants', async () => {
    const a = await load(), format = (instant, v, style = 'datetime') => a.formatDisplayTimestamp(instant, v, style, 'missing', 'en-US');
    assert.equal(format('2026-01-15T02:05:06Z', values('utc', '24')), 'Jan 15, 2026, 02:05:06');
    assert.equal(format('2026-01-15T02:05:06Z', values('named', '12', 'America/Denver')), 'Jan 14, 2026, 7:05:06 PM');
    assert.equal(format('2026-07-15T02:05:06Z', values('named', '24', 'America/Denver')), 'Jul 14, 2026, 20:05:06');
    assert.equal(format('2026-01-15T00:00:00Z', values('utc', '24'), 'time'), '00:00:00');
    assert.equal(format('2026-01-15T02:05:06+02:00', values('utc', '24'), 'time'), '00:05:06');
  });
  await t.test('device zone resolves at formatting time; calendar dates never shift', async () => {
    const a = await load(), instant = '2026-01-15T02:05:06Z';
    const expected = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(instant));
    assert.equal(a.formatDisplayTimestamp(instant, values('device', '24'), 'time', '-', 'en-US'), expected);
    assert.equal(a.formatDisplayTimestamp('2026-01-15', values('named', '24', 'America/Denver'), 'date', '-', 'en-US'), 'Jan 15, 2026');
    for (const bad of ['2026-02-30', 'invalid', '2026-01-15T12:00:00', null]) assert.equal(a.formatDisplayTimestamp(bad, values(), 'datetime', '-'), '-');
    assert.equal(a.formatDisplayTimestamp('2026-02-30', values(), 'date', '-'), '-');
    assert.equal(a.formatDisplayTimestamp(instant, undefined), '—');
  });
  await t.test('save uses fresh revision-bound GET and one complete PUT', async () => {
    reset(); const a = await load(); a.setAccessToken('session'); let calls = 0;
    const desired = values('named', '24', 'America/Denver');
    globalThis.fetch = async r => {
      calls++; assert.equal(new URL(r.url).pathname, '/api/account/display');
      if (r.method === 'GET') return Response.json({ data: state() });
      assert.equal(r.method, 'PUT');
      assert.deepEqual(await r.json(), { expected_user_uuid: user, profile_revision: 1, display: desired });
      return Response.json({ data: state(2, desired) });
    };
    assert.deepEqual(await a.saveOwnDisplay(state(), desired), state(2, desired)); assert.equal(calls, 2);
  });
  await t.test('stale revision, foreign actor or changed bearer prevent mutation', async () => {
    for (const mode of ['stale', 'foreign', 'token']) {
      reset(); const a = await load(); a.setAccessToken('session'); let puts = 0;
      globalThis.fetch = async r => { if (r.method !== 'GET') puts++; if (mode === 'token') a.setAccessToken('newer'); return Response.json({ data: mode === 'stale' ? state(2) : mode === 'foreign' ? { ...state(), user_uuid: other } : state() }); };
      await assert.rejects(a.saveOwnDisplay(state(), values('utc', '24'))); assert.equal(puts, 0);
    }
  });
  await t.test('401, conflict, lost response or malformed confirmation never replay PUT', async () => {
    for (const mode of ['401', '409', 'lost', 'wrong-result']) {
      reset(); const a = await load(); a.setAccessToken('session'); let puts = 0;
      globalThis.fetch = async r => { if (r.method === 'GET') return Response.json({ data: state() }); puts++; if (mode === 'lost') throw Error('lost'); if (mode === 'wrong-result') return Response.json({ data: state(2) }); return Response.json({ error: { message: 'private upstream details' } }, { status: Number(mode) }); };
      await assert.rejects(a.saveOwnDisplay(state(), values('utc', '24')), /No request was replayed/);
      assert.equal(puts, 1); assert.equal(a.getAccessToken(), 'session');
    }
  });
  await t.test('single-flight admission and late token switch discard old result and release admission', async () => {
    reset(); const a = await load(); a.setAccessToken('session'); let release, puts = 0;
    globalThis.fetch = async r => { if (r.method === 'GET') return Response.json({ data: state() }); puts++; await new Promise(resolve => { release = resolve; }); return Response.json({ data: state(2, values('utc', '24')) }); };
    const first = a.saveOwnDisplay(state(), values('utc', '24'));
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(a.saveOwnDisplay(state(), values()), /already/);
    a.setAccessToken('newer'); release(); await assert.rejects(first); assert.equal(puts, 1); assert.equal(a.getAccessToken(), 'newer');
    globalThis.fetch = async () => Response.json({ data: state(9) });
    await assert.rejects(a.saveOwnDisplay(state(), values()), /Refresh/);
  });
});
