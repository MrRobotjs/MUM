import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
const { build } = createRequire(new URL('../frontend/package.json', import.meta.url))('esbuild');
async function loadAdapters() {
  const result = await build({ stdin: { contents: "export * from './src/lib/invitations';", resolveDir: directory }, bundle: true, write: false, format: 'esm', platform: 'browser' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
const server = { id: 9, server_nickname: 'Media', service_type: 'jellyfin', is_active: true, provider_enabled: true, effective_active: true };
const library = { id: 70, server_id: 9, external_id: 'movies', name: 'Movies', library_type: 'movie' };
const record = (overrides = {}) => ({ id: 20, revision: 3, created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', is_active: true, max_uses: 2, current_uses: 0, reserved_uses: 0, grants: [{ server_id: 9, all_libraries: false, library_ids: ['movies'], allow_downloads: false }], ...overrides });
const values = () => ({ expires_at: '2099-01-01', max_uses: 2, is_active: true, server_ids: [9], grant_library_ids: ['9::movies'], server_features: [{ server_id: 9, allow_downloads: true }] });

test('current admin invitation adapters', async t => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://mum.test' } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; });

  await t.test('catalog follows cursors and joins external library IDs without fetching share secrets', async () => {
    const api = await loadAdapters();
    const requested = [];
    globalThis.fetch = async request => {
      const url = new URL(request.url); requested.push(url.pathname + url.search);
      if (url.pathname === '/api/servers') return Response.json({ data: [server] });
      if (url.pathname === '/api/libraries') return Response.json({ data: [library] });
      assert.equal(url.pathname, '/api/invitations');
      return Response.json(url.searchParams.has('before') ? { data: [record({ id: 19 })], meta: { next_before: null } } : { data: [record()], meta: { next_before: 20 } });
    };
    const catalog = await api.fetchInvitationCatalog();
    assert.equal(catalog.records.length, 2);
    const row = api.invitationRow(catalog.records[0], catalog);
    assert.deepEqual(row.grant_library_ids, ['9::movies']);
    assert.equal(row.servers[0].server_nickname, 'Media');
    assert.equal(row.revision, 3);
    assert.ok(requested.includes('/api/invitations?include_archived=1&before=20'));
    assert.ok(!requested.some(path => path.includes('share-link') || path.includes('/api/invites')));
  });

  await t.test('reserved capacity and disabled servers affect filters and summary', async () => {
    const api = await loadAdapters();
    const catalog = { records: [record(), record({ id: 19, reserved_uses: 2 }), record({ id: 18, is_active: false })], servers: [server], libraries: [library] };
    assert.equal(api.filterInvitations(catalog, { status: 'maxed' }).invites[0].id, 19);
    assert.equal(api.filterInvitations(catalog, { status: 'usable' }).invites.length, 1);
    assert.equal(api.filterInvitations(catalog, { search: 'Media', pageSize: 1, page: 2 }).pagination.page, 2);
    assert.equal(api.invitationSummary(catalog).counts.maxed, 1);
    // Archived (deleted) invitations show only under the Archived filter.
    const withArchived = { ...catalog, records: [...catalog.records, record({ id: 17, is_active: false, archived_at: '2026-11-11T00:00:00Z' })] };
    assert.deepEqual(api.filterInvitations(withArchived, { status: 'archived' }).invites.map(r => [r.id, r.is_archived]), [[17, true]]);
    assert.ok(!api.filterInvitations(withArchived, { status: 'all' }).invites.some(r => r.id === 17));
    assert.ok(!api.filterInvitations(withArchived, { status: 'inactive' }).invites.some(r => r.id === 17));
    assert.equal(api.invitationSummary(withArchived).counts.total, catalog.records.length);
    // The catalogue carries no usage history: usage is reported unavailable, never an empty list.
    assert.equal(api.invitationSummary(catalog).recent_usages, null);
    catalog.servers = [{ ...server, effective_active: false }];
    assert.equal(api.filterInvitations(catalog, { status: 'paused' }).invites.length, 3);
    assert.equal(api.invitationSummary(catalog).counts.usable, 0);
  });

  await t.test('strict payloads preserve explicit all-library grants and reject unsupported conditions', async () => {
    const api = await loadAdapters();
    const payload = api.invitationPayload(values());
    assert.deepEqual(payload.grants, [{ server_id: 9, all_libraries: false, library_ids: ['movies'], allow_downloads: true }]);
    assert.equal(payload.server_ids, undefined);
    assert.equal(api.invitationPayload({ ...values(), all_library_server_ids: [9] }).grants[0].all_libraries, true);
    const plain = api.invitationPayload(values());
    assert.equal(plain.require_discord_auth, false);assert.equal(plain.require_discord_guild_membership, false);
    // Discord sign-in is a supported condition; requiring membership implies sign-in.
    const gated = api.invitationPayload({ ...values(), require_discord_guild_membership: true });
    assert.equal(gated.require_discord_auth, true);assert.equal(gated.require_discord_guild_membership, true);
    // Flask options: custom path, membership expiry, never-expiring and unlimited.
    const flask = api.invitationPayload({ ...values(), custom_path: 'besties', membership_expires_at: '2099-01-01', expires_at: '', max_uses: '' });
    assert.equal(flask.custom_path, 'besties');
    assert.equal(flask.expires_at, null);
    assert.equal(flask.max_uses, null);
    assert.ok(Number.isInteger(flask.membership_duration_days) && flask.membership_duration_days > 1);
    assert.equal(api.invitationPayload({ ...values(), max_uses: 0 }).max_uses, null);
    assert.throws(() => api.invitationPayload({ ...values(), custom_path: 'a b' }), /Custom paths/);
    for (const unsupported of [{ grant_purge_whitelist: true }, { invite_to_plex_home: true }]) {
      assert.throws(() => api.invitationPayload({ ...values(), ...unsupported }), /not available/);
    }
    assert.throws(() => api.invitationPayload({ ...values(), grant_library_ids: [] }), /at least one library/);
  });

  await t.test('editing sends the captured revision; delete maps to history-preserving archive', async () => {
    const api = await loadAdapters();
    const calls = [];
    globalThis.fetch = async request => { calls.push({ path: new URL(request.url).pathname, method: request.method, body: await request.json() }); return Response.json({ data: { id: 20, revision: 4 } }); };
    await api.saveInvitation(values(), { id: 20, revision: 3 });
    assert.equal(calls[0].path, '/api/invitations/20');
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].body.revision, 3);
    await api.bulkInvitationAction([20], 'delete');
    assert.equal(calls[1].body.action, 'archive');
    // Permanent deletion of archived invites is a separate, explicit action.
    await api.bulkInvitationAction([20], 'purge');
    assert.deepEqual(calls[2].body, { ids: [20], action: 'purge' });
  });

  await t.test('share links are fetched explicitly and validated before opening a reserved tab', async () => {
    const api = await loadAdapters();
    const token = 'x'.repeat(43);
    let opened, closed = false;
    const popup = { opener: 'old', location: { replace(url) { opened = url; } }, close() { closed = true; } };
    globalThis.window.open = () => popup;
    globalThis.fetch = async request => {
      assert.equal(new URL(request.url).pathname, '/api/invitations/20/share-link');
      return Response.json({ data: { id: 20, token, path: '/invite/' + token } });
    };
    await api.openInvitation(20);
    assert.equal(popup.opener, null);
    assert.equal(opened, 'http://mum.test/invite/' + token);
    globalThis.fetch = async () => Response.json({ data: { id: 20, token, path: 'https://unexpected.invalid' } });
    await assert.rejects(api.openInvitation(20), /Invalid invitation share link/);
    assert.equal(closed, true);
  });

  await t.test('job details expose failed review references without inventing acceptance', async () => {
    const api = await loadAdapters();
    globalThis.fetch = async request => {
      const url = new URL(request.url);
      if (url.pathname === '/api/invitations/20') return Response.json({ data: record({ reserved_uses: 1 }) });
      if (url.pathname === '/api/servers') return Response.json({ data: [server] });
      if (url.pathname === '/api/libraries') return Response.json({ data: [library] });
      if (url.pathname === '/api/provisioning-jobs') {
        assert.equal(url.searchParams.get('invite_id'), '20');
        return Response.json({ data: [{ id: 'job-ref', invite_id: 20, status: 'failed', user_uuid: 'local-profile', error_code: 'REVIEW_REQUIRED', updated_at: '2026-01-01T00:00:00Z' }, {id:'plex-running',invite_id:20,status:'running',plex_progress:{phase:'verification_required'}}], meta: { next_before: null } });
      }
      return Response.json({ data: [record()], meta: { next_before: null } });
    };
    const detail = await api.invitationDetail(20);
    assert.equal(detail.remaining_uses, 1);
    assert.equal(detail.usage[0].accepted_invite, false);
    assert.equal(detail.usage[0].plex_review_available, false);
    assert.equal(detail.usage[1].plex_review_available, true);
    assert.equal(detail.usage[1].accepted_invite, false);
    assert.match(detail.usage[0].status_message, /Requires review: job-ref/);
    assert.equal(detail.servers[0].libraries[0].selected, true);
    assert.equal(detail.usage_summary.accepted, 0);
  });

  await t.test('repeated cursor responses fail instead of silently truncating the catalog', async () => {
    const api = await loadAdapters();
    globalThis.fetch = async request => {
      const path = new URL(request.url).pathname;
      if (path !== '/api/invitations') return Response.json({ data: [] });
      return Response.json({ data: [record()], meta: { next_before: 20 } });
    };
    await assert.rejects(api.fetchInvitationCatalog(), /Invalid invitation cursor/);
  });
  await t.test('Kavita creation and edits retain explicit library IDs rather than future-library grants', async () => {
    const api = await loadAdapters();
    const servers = [{ ...server, service_type: 'kavita' }];
    const selected = { ...values(), grant_library_ids: ['9::2'] };
    assert.deepEqual(api.invitationPayload(selected, servers).grants[0].library_ids, ['2']);
    assert.equal(api.invitationPayload(selected, servers).grants[0].all_libraries, false);
    assert.throws(() => api.invitationPayload({ ...selected, all_library_server_ids: [9] }, servers), /selected libraries/);
    for (const id of ['0', '02', '2147483648']) assert.throws(() => api.invitationPayload({ ...selected, grant_library_ids: [`9::${id}`] }, servers), /valid IDs/);
  });

});


test('RomM admin grants never infer all-platform/download access', async () => {
 const api = await loadAdapters();
 const metadata = [{id:9,service_type:'romm'}];
 assert.throws(() => api.invitationPayload(values(),metadata), /RomM/);
 const all = {...values(),all_library_server_ids:[9]};
 assert.throws(() => api.invitationPayload({...all,server_features:[{server_id:9,allow_downloads:false}]},metadata),/RomM/);
 assert.deepEqual(api.invitationPayload(all,metadata).grants,[{server_id:9,all_libraries:true,library_ids:[],allow_downloads:true}]);
});
