import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function loadAdapters() {
  
  return loadFrontend("export * from './src/lib/invitations';");
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
    assert.deepEqual(payload.grants, [{ server_id: 9, all_libraries: false, library_ids: ['movies'], allow_downloads: true, allow_4k_transcode: true, purge_protected: false }]);
    assert.equal(payload.server_ids, undefined);
    assert.equal(api.invitationPayload({ ...values(), all_library_server_ids: [9] }).grants[0].all_libraries, true);
    const plain = api.invitationPayload(values());
    assert.equal(plain.require_discord_auth, false);assert.equal(plain.require_discord_guild_membership, false);
    // Discord sign-in is a supported condition; requiring membership implies sign-in.
    const gated = api.invitationPayload({ ...values(), require_discord_guild_membership: true });
    assert.equal(gated.require_discord_auth, true);assert.equal(gated.require_discord_guild_membership, true);
    // Optional settings: custom path, membership expiry, never-expiring and unlimited.
    const optional = api.invitationPayload({ ...values(), custom_path: 'besties', membership_expires_at: '2099-01-01', expires_at: '', max_uses: '' });
    assert.equal(optional.custom_path, 'besties');
    assert.equal(optional.expires_at, null);
    assert.equal(optional.max_uses, null);
    assert.ok(Number.isInteger(optional.membership_duration_days) && optional.membership_duration_days > 1);
    assert.equal(api.invitationPayload({ ...values(), max_uses: 0 }).max_uses, null);
    assert.throws(() => api.invitationPayload({ ...values(), custom_path: 'a b' }), /Custom paths/);
    for (const unsupported of [{ grant_bot_whitelist: true }, { allow_live_tv: true }]) {
      assert.throws(() => api.invitationPayload({ ...values(), ...unsupported }), /not available/);
    }
    // Plex Home is a Plex server's choice, sent only when on.
    const home = { ...values(), server_features: [{ server_id: 9, allow_downloads: true, invite_to_plex_home: true }] };
    assert.equal(api.invitationPayload(home, [{ id: 9, service_type: 'plex' }]).grants[0].invite_to_plex_home, true);
    assert.equal('invite_to_plex_home' in api.invitationPayload(values(), [{ id: 9, service_type: 'plex' }]).grants[0], false);
    assert.throws(() => api.invitationPayload(home, [{ id: 9, service_type: 'jellyfin' }]), /Only Plex/);
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
    await api.applyInvitationAction([20], 'delete');
    assert.equal(calls[1].path, '/api/invitations/actions');
    assert.equal(calls[1].body.action, 'archive');
    // Permanent deletion of archived invites is a separate, explicit action.
    await api.applyInvitationAction([20], 'purge');
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
    // With a public address set, the link uses it instead of this page's address.
    globalThis.fetch = async () => Response.json({ data: { id: 20, token, path: '/invite/' + token, public_address: 'https://mum.example.com' } });
    assert.equal(await api.invitationShareURL(20), 'https://mum.example.com/invite/' + token);
    // Anything that isn't a plain address is ignored.
    globalThis.fetch = async () => Response.json({ data: { id: 20, token, path: '/invite/' + token, public_address: 'https://evil.example/@x' } });
    assert.equal(await api.invitationShareURL(20), 'http://mum.test/invite/' + token);
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
 assert.deepEqual(api.invitationPayload(all,metadata).grants,[{server_id:9,all_libraries:true,library_ids:[],allow_downloads:true,allow_4k_transcode:true,purge_protected:false}]);
});

// 4K transcoding is chosen per Plex, Jellyfin or Emby server; other servers
// always allow it, and the saved choice is read back per server.
test('admin invitations carry the 4K transcoding choice', async () => {
 const api = await loadAdapters();
 const blocked = {...values(),server_features:[{server_id:9,allow_downloads:true,allow_4k_transcode:false}]};
 for (const service_type of ['plex','jellyfin','emby']) assert.equal(api.invitationPayload(blocked,[{id:9,service_type}]).grants[0].allow_4k_transcode,false);
 assert.equal(api.invitationPayload(blocked,[{id:9,service_type:'audiobookshelf'}]).grants[0].allow_4k_transcode,true);
 assert.equal(api.invitationPayload(values(),[{id:9,service_type:'emby'}]).grants[0].allow_4k_transcode,true);
 const catalog = {records:[record({grants:[{server_id:9,all_libraries:false,library_ids:['movies'],allow_downloads:false,allow_4k_transcode:false}]})],servers:[{id:9,server_nickname:'Jelly',service_type:'jellyfin',is_active:true,provider_enabled:true,effective_active:true}],libraries:[]};
 const row = api.invitationRow(catalog.records[0],catalog);
 assert.equal(row.allow_4k_transcode,false);
 assert.deepEqual(row.server_features,[{server_id:9,allow_downloads:false,allow_4k_transcode:false,invite_to_plex_home:false}]);
 assert.equal(api.invitationRow(record(),catalog).allow_4k_transcode,true);
});

// Purge protection is one switch in the invite form, saved on every server's
// grant and read back from the saved grants.
test('admin invitations carry purge protection', async () => {
 const api = await loadAdapters();
 const grants = api.invitationPayload({...values(),grant_purge_whitelist:true},[{id:9,service_type:'plex'}]).grants;
 assert.deepEqual(grants.map(g => g.purge_protected),[true]);
 assert.equal(api.invitationPayload(values(),[{id:9,service_type:'plex'}]).grants[0].purge_protected,false);
 const catalog = {records:[record({grants:[{server_id:9,all_libraries:false,library_ids:['movies'],allow_downloads:false,purge_protected:true}]})],servers:[{id:9,server_nickname:'Plex',service_type:'plex',is_active:true,provider_enabled:true,effective_active:true}],libraries:[{server_id:9,external_id:'movies',name:'Movies'}]};
 assert.equal(api.invitationRow(catalog.records[0],catalog).grant_purge_whitelist,true);
 assert.equal(api.invitationRow(record(),catalog).grant_purge_whitelist,false);
});
