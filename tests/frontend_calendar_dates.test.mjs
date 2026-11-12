import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { bundleFrontend } from './frontendLoader.mjs';
async function bundle(contents) {
  return `data:text/javascript;base64,${Buffer.from(await bundleFrontend(contents)).toString('base64')}`;
}
async function load() { return import(`${await bundle("export * from './src/util/calendarDates';export * from './src/lib/accountDisplay';export * from './src/lib/invitations';export {setAccessToken,getAccessToken} from './src/store/authStore';")}#${Math.random()}`); }
const named = { mode: 'named', time_format: '24', time_zone: 'America/Denver' };
const form = () => ({ expires_at: '2099-07-15', max_uses: 2, is_active: true, server_ids: [9], grant_library_ids: ['9::movies'] });

test('calendar, relative display and invitation expiry semantics', async t => {
  await t.test('calendar parsing rejects normalized or ambiguous inputs and preserves bucket labels', async () => {
    const a = await load();
    for (const bad of ['2026-02-30', '2025-02-29', '2026-13-01', '2026-1-15', '2026-01-15T00:00:00Z', ' 2026-01-15']) assert.equal(a.parseCalendarDate(bad), null);
    assert.equal(a.formatCalendarDate('2024-02-29', 'short', 'en-US'), 'Feb 29');
    assert.equal(a.formatCalendarDate('2026-01-15', 'full', 'en-US'), 'Thu, Jan 15, 2026');
    for (const bad of ['2026-01-15T12:00:00', '2026-01-15T24:00:00Z', '2026-02-30T12:00:00Z']) assert.equal(a.parseOffsetTimestamp(bad), null);
  });
  await t.test('UTC expiry date and bucket output are invariant across real device zones', async () => {
    const url = await bundle("export * from './src/util/calendarDates';");
    for (const zone of ['UTC', 'America/Denver', 'Pacific/Kiritimati']) {
      const code = `const a=await import(${JSON.stringify(url)});console.log(JSON.stringify({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,date:a.formatCalendarDate('2026-01-15','short','en-US'),expiry:a.invitationExpiryTimestamp('2099-07-15')}));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: zone }, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { zone, date: 'Jan 15', expiry: '2099-07-15T23:59:59Z' });
    }
  });
  await t.test('calendar-day distance follows saved zone through 23/25-hour DST days', async () => {
    const a = await load();
    assert.equal(a.displayCalendarDayDifference('2026-03-09T06:30:00Z', '2026-03-08T07:30:00Z', named), 1);
    assert.equal(a.displayCalendarDayDifference('2026-11-02T07:30:00Z', '2026-11-01T06:30:00Z', named), 1);
    assert.equal(a.displayCalendarDayDifference('2026-01-15T07:30:00Z', '2026-01-15T06:30:00Z', named), 1);
    assert.equal(a.displayCalendarDayDifference('2026-01-15T07:30:00Z', '2026-01-15T06:30:00Z', { mode: 'utc', time_format: '24', time_zone: null }), 0);
    assert.equal(a.displayCalendarDayDifference('2026-01-15', '2026-01-15T00:00:00Z', named), null);
  });
  await t.test('expiration is determined by the instant even earlier on the same selected-zone day', async () => {
    const a = await load();
    assert.equal(a.displayExpirationInfo('2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', named).isExpired, true);
    assert.equal(a.displayExpirationInfo('2026-01-15T10:00:00Z', '2026-01-15T11:00:00Z', named).relativeLabel, 'expired');
    assert.equal(a.displayExpirationInfo('2026-01-15T07:30:00Z', '2026-01-15T06:30:00Z', named).relativeLabel, '1 day left');
    assert.equal(a.displayExpirationInfo('2026-01-15T12:00:00Z', '2026-01-15T11:00:00Z', named).relativeLabel, 'expires today');
    assert.equal(a.displayExpirationInfo(null, '2026-01-15T11:00:00Z', named), null);
  });
  await t.test('relative duration labels are zone-independent and future/old/invalid values format honestly', async () => {
    const a = await load(), now = '2026-01-15T12:00:00Z';
    assert.equal(a.formatRelativeTimestamp('2026-01-15T11:58:00Z', now, named), '2 mins ago');
    assert.equal(a.formatRelativeTimestamp('2026-01-14T12:00:00Z', now, named), '1 day ago');
    assert.equal(a.formatRelativeTimestamp('2026-01-01T02:00:00Z', now, named), a.formatDisplayTimestamp('2026-01-01T02:00:00Z', named, 'date'));
    assert.equal(a.formatRelativeTimestamp('2026-01-15T13:00:00Z', now, named), a.formatDisplayTimestamp('2026-01-15T13:00:00Z', named));
    assert.equal(a.formatRelativeTimestamp('invalid', now, named), '—');
    assert.equal(a.formatRelativeTimestamp(now, now, undefined), '—');
  });
  await t.test('editing unrelated invitation fields retains exact offset/submillisecond expiry; changed dates use UTC', async () => {
    const a = await load(), original = '2099-07-15T00:30:00.123456789+02:00';
    const fields = a.invitationExpiryFields(original);
    assert.deepEqual(fields, { expires_at: '2099-07-14', original_expires_at: original });
    assert.equal(a.invitationPayload({ ...form(), ...fields, max_uses: 3 }).expires_at, original);
    assert.equal(a.invitationPayload({ ...form(), ...fields, expires_at: '2099-07-16' }).expires_at, '2099-07-16T23:59:59Z');
    assert.equal(a.invitationPayload(form()).expires_at, '2099-07-15T23:59:59Z');
    for (const bad of ['2099-02-30', '2099-07-15T12:00:00']) assert.throws(() => a.invitationPayload({ ...form(), expires_at: bad }));
    assert.equal(a.invitationPayload({ ...form(), expires_at: original }).expires_at, original);
  });
  await t.test('invitation saves send no draft metadata and never refresh or replay an uncertain mutation', async () => {
    const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
    try {
      globalThis.window = { location: { origin: 'http://mum.test' } };
      for (const mode of ['401', 'lost']) {
        const a = await load(); a.setAccessToken('session'); let calls = 0;
        globalThis.fetch = async r => {
          calls++; assert.equal(new URL(r.url).pathname, '/api/invitations/20'); assert.equal(r.method, 'PATCH');
          const body = await r.json(); assert.equal(body.revision, 3); assert.equal(body.original_expires_at, undefined); assert.equal(body.expires_at, '2099-07-15T01:02:03.123456789Z');
          if (mode === 'lost') throw Error('lost');
          return Response.json({ error: { message: 'session expired' } }, { status: 401 });
        };
        await assert.rejects(a.saveInvitation({ ...form(), original_expires_at: '2099-07-15T01:02:03.123456789Z' }, { id: 20, revision: 3 }));
        assert.equal(calls, 1); assert.equal(a.getAccessToken(), 'session');
      }
    } finally { globalThis.fetch = previousFetch; globalThis.window = previousWindow; }
  });
});
