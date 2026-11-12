import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory = fileURLToPath(new URL('../frontend/', import.meta.url));
async function loadModule() {
  
  return loadFrontend("export * from './src/lib/provisioningReview'; export {setAccessToken,getAccessToken} from './src/store/authStore';");
}
const job = (overrides = {}) => ({ id: 'job-reference', status: 'failed', revision: 3, invite_id: 1, reservation_held: true, review_in_progress: false, resume_available: true, steps: [{ server_id: 9, password_ascii_only: false, password_max_bytes: 1024, status: 'failed', stage: 'enabling', remote_id: 'recorded-id', remote_username: 'Recipient', cleanup_state: 'pending', cleanup_scope: 'account', resume_state: 'pending', manual_resolution_required: false, manual_resolution_allowed: false }], ...overrides });
const decision = (overrides = {}) => ({ reason: 'Reviewed the upstream account and settled requests', acknowledge_in_flight_risk: true, release_username: false, manual_resolutions: [], ...overrides });

test('provisioning review adapters', async t => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: 'http://mum.test' } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.window = previousWindow; });

  await t.test('loads an exact versioned private job', async () => {
    const api = await loadModule();
    globalThis.fetch = async request => { assert.equal(new URL(request.url).pathname, '/api/provisioning-jobs/job-reference'); return Response.json({ data: job() }); };
    assert.equal((await api.fetchProvisioningReview('job-reference')).revision, 3);
    globalThis.fetch = async () => Response.json({ data: job({ id: 'different' }) });
    await assert.rejects(api.fetchProvisioningReview('job-reference'), /Unexpected/);
  });

  await t.test('requires an available reservation, reason and risk acknowledgment', async () => {
    const api = await loadModule();
    for (const unavailable of [job({ status: 'completed' }), job({ status: 'cancelled' }), job({ reservation_held: false }), job({ review_in_progress: true })]) assert.throws(() => api.reviewDecisionPayload(unavailable, 'cancel', decision()), /not available/);
    assert.throws(() => api.reviewDecisionPayload(job(), 'cancel', decision({ reason: 'short' })), /10/);
    assert.throws(() => api.reviewDecisionPayload(job(), 'cancel', decision({ acknowledge_in_flight_risk: false })), /acknowledge/);
  });

  await t.test('every unknown outcome needs its own explicit external resolution', async () => {
    const api = await loadModule();
    const unknown = job({ steps: [{ ...job().steps[0], remote_id: undefined, cleanup_state: 'unknown', manual_resolution_required: true, manual_resolution_allowed: true }] });
    assert.throws(() => api.reviewDecisionPayload(unknown, 'cancel', decision()), /Every uncertain/);
    const input = decision({ manual_resolutions: [{ server_id: 9, reason: 'Confirmed externally that the timed-out create settled and its account was removed' }] });
    assert.equal(api.reviewDecisionPayload(unknown, 'cancel', input).manual_resolutions.length, 1);
    assert.throws(() => api.reviewDecisionPayload(unknown, 'cancel', decision({ manual_resolutions: [{ server_id: 77, reason: 'Reviewed a different server externally' }] })), /specific external/);
  });

  await t.test('failed known-identity verification may be resolved explicitly without treating it as an automatic proof', async () => {
    const api = await loadModule();
    const failed = job({ steps: [{ ...job().steps[0], cleanup_state: 'failed', manual_resolution_allowed: true }] });
    const payload = api.reviewDecisionPayload(failed, 'cancel', decision({ manual_resolutions: [{ server_id: 9, reason: 'Remote administrator verified revocation directly' }] }));
    assert.equal(payload.manual_resolutions[0].server_id, 9);
    assert.equal(payload.revision, 3);
  });

  await t.test('disable sends only its action inputs; cancellation sends the optional username release', async () => {
    const api = await loadModule();
    const calls = [];
    globalThis.fetch = async request => { calls.push({ path: new URL(request.url).pathname, body: await request.json() }); return Response.json({ data: job({ revision: 5 }) }); };
    await api.submitProvisioningReview(job(), 'disable-accounts', decision({ release_username: true }));
    assert.equal(calls[0].path, '/api/provisioning-jobs/job-reference/disable-accounts');
    assert.equal(calls[0].body.revision, 3);
    assert.equal(calls[0].body.release_username, undefined);
    assert.equal(calls[0].body.manual_resolutions, undefined);
    globalThis.fetch = async request => { calls.push({ path: new URL(request.url).pathname, body: await request.json() }); return Response.json({ data: job({ status: 'cancelled', reservation_held: false, revision: 6 }) }); };
    const result = await api.submitProvisioningReview(job({ revision: 5 }), 'cancel', decision({ release_username: true }));
    assert.equal(result.status, 'cancelled');
    assert.equal(calls[1].body.release_username, true);
    assert.equal(calls[1].body.revision, 5);
  });

  await t.test('failed network review mutations are not automatically replayed', async () => {
    const api = await loadModule();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('connection lost'); };
    await assert.rejects(api.submitProvisioningReview(job(), 'disable-accounts', decision()), /connection lost/);
    assert.equal(calls, 1);
  });

  await t.test('invalid job revisions and duplicate step identities are rejected', async () => {
    const api = await loadModule();
    for (const invalid of [job({ revision: 0 }), job({ steps: [...job().steps, ...job().steps] }), job({ status: 'unknown' })]) {
      globalThis.fetch = async () => Response.json({ data: invalid });
      await assert.rejects(api.fetchProvisioningReview('job-reference'), /Invalid provisioning/);
    }
  });

  await t.test('resumption requires a recorded eligible job and explicit password acknowledgments', async () => {
    const api = await loadModule();
    const input = { reason: 'Reviewed all recorded targets and authorization', acknowledge_in_flight_risk: true, acknowledge_password_changes: true, server_passwords: [{ server_id: 9, password: 'new-server-private-password', confirm_password: 'new-server-private-password' }] };
    assert.throws(() => api.resumeDecisionPayload(job({ resume_available: false }), input), /cannot resume/);
    assert.throws(() => api.resumeDecisionPayload(job(), { ...input, acknowledge_password_changes: false }), /acknowledge/);
    assert.throws(() => api.resumeDecisionPayload(job({ status: 'completed' }), input), /cannot resume/);
    const payload = api.resumeDecisionPayload(job(), input);
    assert.equal(payload.revision, 3);
    assert.equal(payload.server_passwords[0].confirm_password, undefined);
    assert.equal(payload.server_passwords[0].remote_id, undefined);
  });

  await t.test('resumption requires every recorded server exactly once with matching passwords', async () => {
    const api = await loadModule();
    const input = { reason: 'Reviewed all recorded targets and authorization', acknowledge_in_flight_risk: true, acknowledge_password_changes: true, server_passwords: [] };
    assert.throws(() => api.resumeDecisionPayload(job(), input), /Every recorded/);
    for (const entries of [[{ server_id: 10, password: 'new-server-password', confirm_password: 'new-server-password' }], [{ server_id: 9, password: 'new-server-password', confirm_password: 'different' }], [{ server_id: 9, password: 'short', confirm_password: 'short' }]]) assert.throws(() => api.resumeDecisionPayload(job(), { ...input, server_passwords: entries }), /matching passwords/);
  });

  await t.test('provider-specific password limits count UTF-8 bytes', async () => {
    const api = await loadModule();
    const input = { reason: 'Reviewed all recorded targets and authorization', acknowledge_in_flight_risk: true, acknowledge_password_changes: true };
    const kavita = job({ steps: [{ ...job().steps[0], password_max_bytes: 256 }] });
    const entries = password => [{ server_id: 9, password, confirm_password: password }];
    assert.throws(() => api.resumeDecisionPayload(kavita, { ...input, server_passwords: entries('é'.repeat(129)) }), /displayed byte limits/);
    assert.equal(api.resumeDecisionPayload(kavita, { ...input, server_passwords: entries('é'.repeat(128)) }).server_passwords.length, 1);
    assert.equal(api.resumeDecisionPayload(job(), { ...input, server_passwords: entries('x'.repeat(257)) }).server_passwords.length, 1);
    const abs = job({ steps: [{ ...job().steps[0], password_max_bytes: 72 }] });
    assert.throws(() => api.resumeDecisionPayload(abs, { ...input, server_passwords: entries('é'.repeat(37)) }), /displayed byte limits/);
    assert.equal(api.resumeDecisionPayload(abs, { ...input, server_passwords: entries('é'.repeat(36)) }).server_passwords.length, 1);
  });

  await t.test('explicit resumption posts passwords once and preserves the original job identity', async () => {
    const api = await loadModule();
    const input = { reason: 'Reviewed all recorded targets and authorization', acknowledge_in_flight_risk: true, acknowledge_password_changes: true, server_passwords: [{ server_id: 9, password: 'new-server-private-password', confirm_password: 'new-server-private-password' }] };
    globalThis.fetch = async request => {
      assert.equal(new URL(request.url).pathname, '/api/provisioning-jobs/job-reference/resume');
      const payload = await request.json();
      assert.equal(payload.acknowledge_password_changes, true);
      assert.equal(payload.server_passwords[0].password, 'new-server-private-password');
      assert.equal(payload.local_password, undefined);
      return Response.json({ data: job({ status: 'completed', resume_available: false, reservation_held: false, revision: 5 }) });
    };
    assert.equal((await api.submitProvisioningResume(job(), input)).status, 'completed');
  });

  await t.test('review and resume authentication failures never rotate or replay writes', async () => {
    for (const action of ['disable-accounts','cancel','resume']) {
      const api=await loadModule();api.setAccessToken('original');let calls=0;
      globalThis.fetch=async request=>{calls++;assert.equal(request.method,'POST');api.setAccessToken('newer');return Response.json({error:{message:'denied'}},{status:401});};
      const pending=action==='resume'?api.submitProvisioningResume(job(),{reason:'Reviewed all recorded targets and authorization',acknowledge_in_flight_risk:true,acknowledge_password_changes:true,server_passwords:[{server_id:9,password:'new-server-private-password',confirm_password:'new-server-private-password'}]}):api.submitProvisioningReview(job(),action,decision());
      await assert.rejects(pending);assert.equal(calls,1);assert.equal(api.getAccessToken(),'newer');
    }
  });

  await t.test('a lost resumption response never triggers an automatic password replay', async () => {
    const api = await loadModule();
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('response lost'); };
    await assert.rejects(api.submitProvisioningResume(job(), { reason: 'Reviewed all recorded targets and authorization', acknowledge_in_flight_risk: true, acknowledge_password_changes: true, server_passwords: [{ server_id: 9, password: 'new-server-private-password', confirm_password: 'new-server-private-password' }] }), /response lost/);
    assert.equal(calls, 1);
  });
  await t.test('Komga media-only cleanup scope is explicit and unknown scopes fail closed', async () => {
    const api = await loadModule();
    const media = job({ steps: [{ ...job().steps[0], cleanup_scope: 'media', password_max_bytes: 72 }] });
    globalThis.fetch = async () => Response.json({ data: media });
    assert.equal((await api.fetchProvisioningReview('job-reference')).steps[0].cleanup_scope, 'media');
    globalThis.fetch = async () => Response.json({ data: job({ steps: [{ ...media.steps[0], cleanup_scope: 'unspecified' }] }) });
    await assert.rejects(api.fetchProvisioningReview('job-reference'), /Invalid provisioning review/);
  });

});


test('RomM recovery enforces printable ASCII before submitting', async () => {
 const api = await loadModule();
 const base = job(); base.steps[0].password_max_bytes=72; base.steps[0].password_ascii_only=true;
 const decision = {reason:'Verified every recorded account before resumption',acknowledge_in_flight_risk:true,acknowledge_password_changes:true,server_passwords:[{server_id:9,password:'new-remote-password',confirm_password:'new-remote-password'}]};
 for (const password of ['non-ascii-password-é','a'.repeat(73),'linebreak-password\n']) {
  assert.throws(() => api.resumeDecisionPayload(base,{...decision,server_passwords:[{server_id:9,password,confirm_password:password}]}));
 }
 assert.equal(api.resumeDecisionPayload(base,decision).server_passwords[0].password,'new-remote-password');
});


test('generic recovery refuses Plex receipts and forged mutation plans', async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'http://mum.test' } };
    const api = await loadModule();
    const plex = job({ plex_progress: { phase: 'awaiting_acceptance', completion_available: false } });
    globalThis.fetch = async () => Response.json({ data: plex });
    await assert.rejects(api.fetchProvisioningReview('job-reference'), /Plex recovery controls/);
    assert.throws(() => api.reviewDecisionPayload(plex, 'cancel', decision()), /Plex recovery controls/);
    assert.throws(() => api.resumeDecisionPayload(plex, {}), /Plex recovery controls/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  }
});
