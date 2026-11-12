import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';

const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function loadModule() {
  
  return loadFrontend("export * from './src/lib/invitationWizard'");
}
const invitation = () => ({
  id: 1, revision: 1, expires_at: '2026-12-01T00:00:00Z', max_uses: 2, current_uses: 0, reserved_uses: 0,
  servers: [
    { id: 11, name: 'First', provider: 'jellyfin', access_url: 'https://media.example.invalid', libraries: [{ id: 'movies', name: 'Movies' }] },
    { id: 12, name: 'Second', provider: 'jellyfin', access_url: '', libraries: [{ id: 'books', name: 'Books' }] },
  ],
  grants: [
    { server_id: 11, all_libraries: false, library_ids: ['movies'], allow_downloads: false },
    { server_id: 12, all_libraries: true, library_ids: [], allow_downloads: true },
  ],
  discord: { required: false, requires_guild: false, available: false, invite_url: null },
});
const account = (overrides = {}) => ({ username: 'Local User', email: 'recipient@example.invalid', password: 'private-profile-password', confirm_password: 'private-profile-password', use_same_username: true, use_same_email: true, use_same_password: true, ...overrides });
const storagePort = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
const receipt = (status = 'completed') => ({ id: 'job-reference', status, requires_review: status === 'failed', steps: [11, 12].map(server_id => ({ server_id, status: status === 'completed' ? 'completed' : 'failed', stage: 'finished' })) });

test('generic invitation completion refuses Plex progress or checkpoint metadata',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
 const {InvitationDraft}=await loadModule();
 for(const mode of ['job','step']){
  const draft=new InvitationDraft('token',invitation(),storagePort());draft.saveAccount(account());
  const value=receipt();if(mode==='job')value.plex_progress={phase:'completed'};else value.steps[0].plex={completion_recorded:true};
  globalThis.fetch=async()=>Response.json({data:value});
  await assert.rejects(draft.redeem(),/dedicated pending flow/);
 }
});

test('current invitation wizard adapters', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });

  await t.test('draft steps stay local and mixed grants remain explicit', async () => {
    const { InvitationDraft } = await loadModule();
    globalThis.fetch = () => { throw new Error('Draft preparation must not contact the server'); };
    const storage = storagePort();
    const draft = new InvitationDraft('token', invitation(), storage);
    assert.equal(draft.view().steps[0].completed, false);
    draft.saveAccount(account());
    assert.ok(draft.view().steps.every(step => step.completed));
    assert.equal(draft.view().servers[0].all_libraries, false);
    assert.equal(draft.view().servers[1].all_libraries, true);
    assert.equal(draft.view().servers[0].features.allow_downloads, false);
    assert.ok(!JSON.stringify(draft.view()).includes('private-profile-password'));
    assert.equal(storage.values.size, 0);
  });

  await t.test('per-server forms retain separate credentials across step changes', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', invitation(), storagePort());
    draft.saveAccount(account({ use_same_username: false, use_same_password: false }));
    assert.equal(draft.view().servers[0].completed, false);
    draft.saveServer(11, { username: 'First Remote', email: '', password: 'first-private-password', password_confirm: 'first-private-password' });
    assert.equal(draft.view().servers[0].completed, true);
    assert.equal(draft.formFor(11).password, 'first-private-password');
    assert.equal(draft.view().servers[1].completed, false);
    draft.saveServer(12, { username: 'Second Remote', email: '', password: 'second-private-password', password_confirm: 'second-private-password' });
    let payload;
    globalThis.fetch = async (path, options) => { payload = JSON.parse(options.body); return Response.json({ data: receipt() }); };
    await draft.redeem();
    assert.equal(payload.username, 'Local User');
    assert.equal(payload.password, 'private-profile-password');
    assert.deepEqual(payload.server_credentials.map(c => c.username), ['First Remote', 'Second Remote']);
    assert.deepEqual(payload.server_credentials.map(c => c.password), ['first-private-password', 'second-private-password']);
  });

  await t.test('concurrent finish clicks share one call and explicit retry preserves the exact request', async () => {
    const { InvitationDraft } = await loadModule();
    const storage = storagePort();
    const draft = new InvitationDraft('token /?secret', invitation(), storage);
    draft.saveAccount(account());
    const requests = [];
    let complete;
    globalThis.fetch = (path, options) => {
      requests.push({ path, options });
      return new Promise(resolve => { complete = resolve; });
    };
    const first = draft.redeem();
    assert.equal(draft.redeem(), first);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/api/public/invitations/token%20%2F%3Fsecret/redeem');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.match(JSON.parse(requests[0].options.body).request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    complete(Response.json({ data: receipt('failed') }));
    assert.equal((await first).status, 'failed');
    assert.throws(() => draft.saveAccount(account({ username: 'Changed' })), /already been submitted/);
    const retry = draft.redeem();
    assert.equal(requests[1].options.body, requests[0].options.body);
    complete(Response.json({ data: receipt('failed') }));
    await retry;
    const stored = [...storage.values.values()].join('');
    for (const secret of ['private-profile-password', 'recipient@example.invalid', 'Local User', 'job-reference']) assert.ok(!stored.includes(secret));
  });

  await t.test('response loss is not automatically replayed', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', invitation(), storagePort());
    draft.saveAccount(account());
    const bodies = [];
    globalThis.fetch = async (_path, options) => { bodies.push(options.body); throw new Error('connection lost'); };
    await assert.rejects(draft.redeem(), /connection lost/);
    assert.equal(bodies.length, 1);
    await assert.rejects(draft.redeem(), /connection lost/);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  });

  await t.test('reload can recover a consumed invite using metadata but must re-enter credentials', async () => {
    const { InvitationDraft, loadPublicInvitation } = await loadModule();
    const storage = storagePort();
    const first = new InvitationDraft('token', invitation(), storage);
    first.saveAccount(account());
    let originalBody;
    globalThis.fetch = async (_path, options) => { originalBody = JSON.parse(options.body); throw new Error('lost response'); };
    await assert.rejects(first.redeem());
    globalThis.fetch = async () => Response.json({ error: { message: 'Consumed' } }, { status: 410 });
    const recovered = await loadPublicInvitation('token', storage);
    assert.equal(recovered.recovering, true);
    assert.equal(recovered.view().account.completed, false);
    assert.equal(recovered.formFor(11).password, '');
    await assert.rejects(recovered.redeem(), /Complete your account/);
    recovered.saveAccount(account());
    globalThis.fetch = async (_path, options) => {
      assert.equal(JSON.parse(options.body).request_id, originalBody.request_id);
      return Response.json({ data: receipt() });
    };
    assert.equal((await recovered.redeem()).status, 'completed');
  });

  await t.test('invalid snapshots and false success receipts are rejected', async () => {
    const { InvitationDraft, loadPublicInvitation } = await loadModule();
    assert.throws(() => new InvitationDraft('token', { ...invitation(), grants: [] }, storagePort()), /Invalid invitation/);
    const storage = storagePort();
    storage.setItem('mum.invitation.attempt.token', JSON.stringify({ version: 1, requestID: 'bad', invitation: invitation() }));
    globalThis.fetch = async () => Response.json({ error: { message: 'Gone' } }, { status: 410 });
    await assert.rejects(loadPublicInvitation('token', storage), /Gone/);
    const draft = new InvitationDraft('token', invitation(), storagePort());
    draft.saveAccount(account());
    for (const invalid of [
      { ...receipt(), requires_review: true },
      { ...receipt(), steps: [{ server_id: 11, status: 'completed' }, { server_id: 11, status: 'completed' }] },
      { ...receipt(), steps: [{ server_id: 11, status: 'completed' }, { server_id: 999, status: 'completed' }] },
      { ...receipt(), steps: [{ server_id: 11, status: 'completed' }, { server_id: 12, status: 'failed' }] },
    ]) {
      globalThis.fetch = async () => Response.json({ data: invalid });
      await assert.rejects(draft.redeem(), /Invalid provisioning receipt/);
    }
  });

  await t.test('receipt recovery retains the original server scope and invitation revision after editing', async () => {
    const { InvitationDraft, loadPublicInvitation } = await loadModule();
    const storage = storagePort();
    const first = new InvitationDraft('token', invitation(), storage);
    first.saveAccount(account());
    globalThis.fetch = async () => { throw new Error('lost response'); };
    await assert.rejects(first.redeem());
    globalThis.fetch = async () => Response.json({ data: { ...invitation(), revision: 2, servers: [invitation().servers[0]], grants: [invitation().grants[0]] } });
    const recovered = await loadPublicInvitation('token', storage);
    assert.equal(recovered.view().servers.length, 2);
    recovered.saveAccount(account());
    globalThis.fetch = async (_path, options) => {
      assert.equal(JSON.parse(options.body).invitation_revision, 1);
      return Response.json({ data: receipt() });
    };
    assert.equal((await recovered.redeem()).status, 'completed');
  });

  await t.test('validation matches Go password byte limits and unavailable storage does not stop in-tab retries', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', invitation(), { getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } });
    assert.throws(() => draft.saveAccount(account({ password: 'short', confirm_password: 'short' })), /12/);
    assert.throws(() => draft.saveAccount(account({ password: 'x'.repeat(1025), confirm_password: 'x'.repeat(1025) })), /1024/);
    draft.saveAccount(account({ password: '界'.repeat(4), confirm_password: '界'.repeat(4) }));
    globalThis.fetch = async () => Response.json({ data: receipt() });
    assert.equal((await draft.redeem()).status, 'completed');
  });

  await t.test('a definite fresh input rejection allows correction without retaining an attempted draft', async () => {
    const { InvitationDraft } = await loadModule();
    const storage = storagePort();
    const draft = new InvitationDraft('token', invitation(), storage);
    draft.saveAccount(account());
    globalThis.fetch = async () => Response.json({ error: { code: 'USERNAME_UNAVAILABLE', message: 'Choose another username' } }, { status: 409 });
    await assert.rejects(draft.redeem(), /another username/);
    draft.saveAccount(account({ username: 'Available User' }));
    assert.equal(draft.view().account.data.username, 'Available User');
    assert.equal([...storage.values.values()][0], 'null');
  });

  await t.test('a later input error cannot unlock an uncertain request for different credentials', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', invitation(), storagePort());
    draft.saveAccount(account());
    globalThis.fetch = async () => { throw new Error('lost response'); };
    await assert.rejects(draft.redeem());
    globalThis.fetch = async () => Response.json({ error: { code: 'USERNAME_UNAVAILABLE', message: 'Unavailable' } }, { status: 409 });
    await assert.rejects(draft.redeem());
    assert.throws(() => draft.saveAccount(account({ username: 'Another' })), /already been submitted/);
  });

  await t.test('cancelled receipts remain cancelled and never become completed invitations', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', invitation(), storagePort());
    draft.saveAccount(account());
    globalThis.fetch = async () => Response.json({ data: { ...receipt('failed'), status: 'cancelled', requires_review: false } });
    const result = await draft.redeem();
    assert.equal(result.status, 'cancelled');
    assert.equal(result.requires_review, false);
    assert.throws(() => draft.saveAccount(account({ username: 'Another' })), /already been submitted/);
  });
  const mixedInvitation = () => {
    const value = invitation();
    value.servers[0].provider = 'emby';
    value.servers[1] = { ...value.servers[1], provider: 'kavita', libraries: [{ id: '2', name: 'Books' }] };
    value.grants[1] = { ...value.grants[1], all_libraries: false, library_ids: ['2'] };
    return value;
  };

  await t.test('Emby and Kavita metadata reach the current credential payload without remote email', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', mixedInvitation(), storagePort());
    draft.saveAccount(account());
    assert.deepEqual(draft.view().servers.map(server => server.service_type), ['EMBY', 'KAVITA']);
    assert.equal(draft.view().servers[1].credentials.email, '');
    assert.equal(draft.view().account.data.email, 'recipient@example.invalid');
    globalThis.fetch = async (_path, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.email, 'recipient@example.invalid');
      assert.deepEqual(body.server_credentials.map(entry => Object.keys(entry).sort()), [['password','server_id','username'], ['password','server_id','username']]);
      return Response.json({ data: receipt() });
    };
    assert.equal((await draft.redeem()).status, 'completed');
  });

  await t.test('invalid shared Kavita passwords require an override before any network mutation', async () => {
    const { InvitationDraft } = await loadModule();
    const storage = storagePort();
    const draft = new InvitationDraft('token', mixedInvitation(), storage);
    const localPassword = 'é'.repeat(129);
    draft.saveAccount(account({ password: localPassword, confirm_password: localPassword }));
    assert.equal(draft.view().servers[0].completed, true);
    assert.equal(draft.view().servers[1].completed, false);
    globalThis.fetch = () => { throw new Error('Invalid credentials must never submit'); };
    await assert.rejects(draft.redeem(), /every server/);
    assert.throws(() => draft.saveServer(12, { username: 'Reader', email: '', password: localPassword, password_confirm: localPassword }), /256/);
    const remotePassword = 'é'.repeat(128);
    draft.saveServer(12, { username: 'Reader', email: '', password: remotePassword, password_confirm: remotePassword });
    globalThis.fetch = async (_path, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.password, localPassword);
      assert.equal(body.server_credentials[1].password, remotePassword);
      return Response.json({ data: receipt() });
    };
    await draft.redeem();
    assert.ok(![...storage.values.values()].join('').includes(remotePassword));
    assert.ok(![...storage.values.values()].join('').includes('recipient@example.invalid'));
  });

  await t.test('a local email-style username can use a separate username-only Kavita identity', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', mixedInvitation(), storagePort());
    draft.saveAccount(account({ username: 'local@example.invalid' }));
    assert.equal(draft.view().servers[1].completed, false);
    assert.throws(() => draft.saveServer(12, { username: 'remote@example.invalid', email: '', password: account().password, password_confirm: account().password }), /without @/);
    draft.saveServer(12, { username: 'RemoteReader', email: '', password: account().password, password_confirm: account().password });
    globalThis.fetch = async (_path, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'local@example.invalid');
      assert.equal(body.server_credentials[1].username, 'RemoteReader');
      return Response.json({ data: receipt() });
    };
    await draft.redeem();
  });

  await t.test('unsupported providers and invalid Kavita grant snapshots fail closed', async () => {
    const { InvitationDraft } = await loadModule();
    // Plex is supported since 2026-11-07; an unknown provider still fails closed.
    const unknown = mixedInvitation(); unknown.servers[1].provider = 'not-a-provider';
    assert.throws(() => new InvitationDraft('token', unknown, storagePort()), /Unsupported/);
    for (const library_ids of [[], ['0'], ['02'], ['2147483648'], ['2','2']]) {
      const invalid = mixedInvitation(); invalid.grants[1].library_ids = library_ids;
      assert.throws(() => new InvitationDraft('token', invalid, storagePort()), /grant|libraries/);
    }
    const all = mixedInvitation(); all.grants[1] = { ...all.grants[1], all_libraries: true, library_ids: [] };
    assert.throws(() => new InvitationDraft('token', all, storagePort()), /selected libraries/);
  });

  await t.test('fresh Kavita credential rejection permits correction but cannot unlock uncertain work', async () => {
    const { InvitationDraft } = await loadModule();
    const draft = new InvitationDraft('token', mixedInvitation(), storagePort());
    draft.saveAccount(account());
    globalThis.fetch = async () => Response.json({ error: { code: 'INVALID_KAVITA_CREDENTIALS', message: 'Kavita limits changed' } }, { status: 400 });
    await assert.rejects(draft.redeem(), /limits/);
    draft.saveAccount(account({ username: 'Corrected' }));
    globalThis.fetch = async () => { throw new Error('response lost'); };
    await assert.rejects(draft.redeem());
    globalThis.fetch = async () => Response.json({ error: { code: 'INVALID_KAVITA_CREDENTIALS', message: 'Invalid credentials' } }, { status: 400 });
    await assert.rejects(draft.redeem());
    assert.throws(() => draft.saveAccount(account()), /already been submitted/);
  });

  await t.test('Audiobookshelf uses a separate 72-byte password while local credentials keep their limit', async () => {
    const { InvitationDraft } = await loadModule();
    const value = invitation(); value.servers[1].provider = 'audiobookshelf';
    const draft = new InvitationDraft('token', value, storagePort());
    const password = 'x'.repeat(1024);
    draft.saveAccount(account({ password, confirm_password: password }));
    assert.equal(draft.view().servers[1].service_type, 'AUDIOBOOKSHELF');
    assert.equal(draft.view().servers[1].completed, false);
    assert.throws(() => draft.saveServer(12, { username: 'Reader', email: '', password: 'é'.repeat(37), password_confirm: 'é'.repeat(37) }), /72/);
    draft.saveServer(12, { username: 'Reader', email: '', password: 'é'.repeat(36), password_confirm: 'é'.repeat(36) });
    assert.equal(draft.view().servers[1].all_libraries, true);
    assert.equal(draft.view().servers[1].credentials.email, '');
    globalThis.fetch = async (_path, options) => {
      assert.equal(JSON.parse(options.body).password.length, 1024);
      assert.equal(new TextEncoder().encode(JSON.parse(options.body).server_credentials[1].password).length, 72);
      return Response.json({ data: receipt() });
    };
    assert.equal((await draft.redeem()).status, 'completed');
  });

  await t.test('Komga shares the local email identity independently of the local username', async () => {
    const { InvitationDraft } = await loadModule();
    const value = invitation(); value.servers[1].provider = 'komga';
    const draft = new InvitationDraft('token', value, storagePort()); draft.saveAccount(account());
    assert.equal(draft.formFor(12).username, account().email);
    assert.equal(draft.view().servers[1].completed, true);
    globalThis.fetch = async (_path, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.username, 'Local User');
      assert.equal(body.server_credentials[1].username, 'recipient@example.invalid');
      return Response.json({ data: receipt() });
    };
    assert.equal((await draft.redeem()).status, 'completed');
  });

  await t.test('Komga accepts a separate remote email and enforces UTF-8 password limits before submission', async () => {
    const { InvitationDraft } = await loadModule();
    const value = invitation(); value.servers[1].provider = 'komga';
    const storage = storagePort(); const draft = new InvitationDraft('token', value, storage);
    draft.saveAccount(account({ email: '', use_same_email: false }));
    assert.equal(draft.view().servers[1].completed, false);
    globalThis.fetch = () => { throw new Error('Invalid details must not post'); };
    await assert.rejects(draft.redeem(), /every server/);
    const details = { username: 'Ignored local name', email: 'remote@example.invalid', password: 'é'.repeat(36), password_confirm: 'é'.repeat(36) };
    assert.throws(() => draft.saveServer(12, { ...details, email: 'not-an-email' }), /email identity/);
    assert.throws(() => draft.saveServer(12, { ...details, password: 'é'.repeat(37), password_confirm: 'é'.repeat(37) }), /72/);
    draft.saveServer(12, details);
    assert.equal(draft.formFor(12).username, 'remote@example.invalid');
    globalThis.fetch = async (_path, options) => {
      assert.equal(JSON.parse(options.body).server_credentials[1].username, 'remote@example.invalid');
      return Response.json({ data: receipt() });
    };
    await draft.redeem();
    assert.ok(![...storage.values.values()].join('').includes('remote@example.invalid'));
  });

});


test('RomM requires explicit all-platform downloads and a valid remote override', async () => {
 const { InvitationDraft } = await loadModule();
 const data = invitation(); data.servers = [ {...data.servers[0], provider:'romm'} ];
 data.grants = [{server_id:11,all_libraries:true,library_ids:[],allow_downloads:true}];
 for (const grant of [{...data.grants[0],allow_downloads:false},{...data.grants[0],all_libraries:false,library_ids:['7']}]) {
  assert.throws(() => new InvitationDraft('token',{...data,grants:[grant]},storagePort()), /RomM/);
 }
 const draft = new InvitationDraft('token',data,storagePort());
 draft.saveAccount(account());
 for (const value of [{username:'Reader',password:'recipient-password'},{username:'reader',password:'non-ascii-password-é'},{username:'reader',password:'a'.repeat(73)}]) {
  assert.throws(() => draft.saveServer(11,{...draft.formFor(11),...value,password_confirm:value.password}),/RomM/);
 }
 draft.saveServer(11,{...draft.formFor(11),username:'reader',password:'a'.repeat(72),password_confirm:'a'.repeat(72)});
 assert.equal(draft.view().servers[0].credentials.username,'reader');
});

// Flask custom paths: /invite/<custom path> resolves to the link code, then
// loads normally; a never-expiring, unlimited invitation is accepted.
test('custom invite paths resolve to the link code and unlimited invites load',async t=>{
 const before=globalThis.fetch;t.after(()=>globalThis.fetch=before);
 const {loadPublicInvitation}=await loadModule();
 const code='A'.repeat(43);const calls=[];
 globalThis.fetch=async url=>{const path=String(url);calls.push(path);
  if(path==='/api/public/invitations/besties')return Response.json({error:{message:'Not found'}},{status:404});
  if(path==='/api/public/invitation-paths/besties')return Response.json({data:{token:code}});
  if(path===`/api/public/invitations/${code}`)return Response.json({data:{...invitation(),expires_at:null,max_uses:null}});
  throw Error('unexpected '+path);};
 const draft=await loadPublicInvitation('besties',storagePort());
 assert.deepEqual(calls,['/api/public/invitations/besties','/api/public/invitation-paths/besties',`/api/public/invitations/${code}`]);
 const view=draft.view();assert.equal(view.invite.token,code);assert.equal(view.invite.expires_at,null);assert.equal(view.invite.max_uses,null);
});
