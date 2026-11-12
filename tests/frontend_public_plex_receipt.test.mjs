import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){const r=await build({stdin:{contents:"export * from './src/lib/publicPlexReceipt';",resolveDir:directory},bundle:true,write:false,format:'esm',platform:'browser'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`);}
const job='12345678-1234-1234-1234-123456789abc',token='x'.repeat(43),server=9;
const credentials=()=>({request_id:'abcdefab-1234-1234-1234-123456789abc',username:'local-reader',password:'local-private-password'});
function receipt(state='prepared',status='running'){
 const phase={prepared:'not_started',awaiting_acceptance:'awaiting_acceptance',access_observed:'verification_required',send_uncertain:'outcome_uncertain',cancel_uncertain:'cleanup_uncertain',cancelled:status==='cancelled'?'cancelled':'cleanup_recorded'}[state];
 const review=status==='failed' || ['verification_required','outcome_uncertain','cleanup_uncertain','cleanup_recorded'].includes(phase);
 return {id:job,status,requires_review:review,plex_progress:{phase,requires_review:review,operation_in_progress:false,completion_available:false},steps:[{server_id:server,status:'pending',stage:'pending',plex:{state,revision:3,operation_in_progress:false,reconciliation_required:false,access_verified:false,cleanup_scope:state==='cancelled'?'owner_cloud_grant':'none'}}]};
}
function completed(){const r=receipt('access_observed','completed');r.requires_review=false;r.plex_progress.phase='completed';r.plex_progress.requires_review=false;r.steps[0].status='completed';r.steps[0].stage='completed';Object.assign(r.steps[0].plex,{completion_recorded:true,verification_scope:'accepted_cloud_and_recipient_library_listing',verified_at:'2026-11-02T12:00:00Z'});return r;}
test('public Plex receipt-only adapter',async t=>{
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);
 await t.test('projects only bound receipt fields and never interprets pending as completion',async()=>{
  const api=await load();for(const state of ['prepared','awaiting_acceptance','access_observed','send_uncertain','cancel_uncertain','cancelled']){const r=receipt(state);r.secret='private-marker';r.steps[0].plex.account_id='2';const parsed=api.publicPlexReceipt(r,job,server);assert.equal(parsed.status,'running');assert.equal(parsed.steps[0].plex.access_verified,false);assert.ok(!JSON.stringify(parsed).includes('private-marker'));assert.ok(!('account_id'in parsed.steps[0].plex));}
 });
 await t.test('rejects foreign, mixed, malformed and contradictory completion receipts',async()=>{
  const api=await load();for(const mutate of [r=>r.id='other',r=>r.steps[0].server_id=10,r=>r.steps.push(r.steps[0]),r=>r.steps[0].plex.revision=0,r=>r.steps[0].plex.access_verified=true,r=>r.steps[0].plex.cleanup_scope='media',r=>r.plex_progress.phase='completed',r=>r.status='completed',r=>r.plex_progress.operation_in_progress=true]){const r=receipt();mutate(r);assert.throws(()=>api.publicPlexReceipt(r,job,server),/Invalid|Inconsistent/);}
  assert.equal(api.publicPlexReceipt(completed(),job,server).plex_progress.phase,'completed');
  const missing=completed();delete missing.steps[0].plex.verified_at;assert.throws(()=>api.publicPlexReceipt(missing,job,server),/Invalid/);
 });
 await t.test('sends only explicit credential-bound receipt reads without bearer/cookies or redemption',async()=>{
  const api=await load();const calls=[];
  globalThis.fetch=async(path,init)=>{calls.push({path,init});assert.equal(path,`/api/public/invitations/${token}/receipt`);assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,undefined);assert.deepEqual(JSON.parse(init.body),{job_id:job,...credentials()});return Response.json({data:receipt('awaiting_acceptance')});};
  const c=new api.PublicPlexReceiptController(token,job,server,()=>{});await c.check(credentials());assert.equal(c.state.phase,'awaiting_acceptance');assert.equal(calls.length,1);assert.ok(!JSON.stringify(c.state).includes('local-private-password'));assert.ok(!JSON.stringify(c.state).includes(credentials().request_id));
 });
 await t.test('distinguishes prepared, pending, verification, uncertainty, review and historical completion',async()=>{
  const api=await load();for(const [value,phase]of [[receipt(),'prepared'],[receipt('awaiting_acceptance'),'awaiting_acceptance'],[receipt('access_observed'),'verification_required'],[receipt('send_uncertain'),'uncertain'],[receipt('cancel_uncertain'),'uncertain'],[receipt('prepared','failed'),'review_required'],[receipt('cancelled'),'cleanup_recorded'],[receipt('cancelled','cancelled'),'cancelled'],[completed(),'completed']]){globalThis.fetch=async()=>Response.json({data:value});const c=new api.PublicPlexReceiptController(token,job,server,()=>{});await c.check(credentials());assert.equal(c.state.phase,phase);c.dispose();}
 });
 await t.test('network errors, 401, 403 and 409 never retry or start provisioning',async()=>{
  const api=await load();for(const status of [0,401,403,409]){let calls=0;globalThis.fetch=async()=>{calls++;if(!status)throw Error('private network detail');return Response.json({error:{message:'private error'}},{status});};const c=new api.PublicPlexReceiptController(token,job,server,()=>{});await c.check(credentials());assert.equal(calls,1);assert.equal(c.state.receipt,null);assert.equal(c.state.phase,'error');assert.ok(!c.state.error.includes('private error'));}
 });
 await t.test('references, local credentials and malformed success responses fail closed',async()=>{
  const api=await load();assert.throws(()=>new api.PublicPlexReceiptController('short',job,server,()=>{}),/reference/);let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:{id:job,status:'completed'}});};const c=new api.PublicPlexReceiptController(token,job,server,()=>{});await c.check({...credentials(),password:'short'});assert.equal(calls,0);await c.check(credentials());assert.equal(c.state.receipt,null);assert.equal(c.state.phase,'error');
 });
 await t.test('double clicks coalesce by admission and disposal aborts/discards late responses',async()=>{
  const api=await load();let release,signal,calls=0,published=0;globalThis.fetch=async(_,init)=>{calls++;signal=init.signal;await new Promise(resolve=>release=resolve);return Response.json({data:receipt()});};const c=new api.PublicPlexReceiptController(token,job,server,()=>published++);const pending=c.check(credentials());await c.check(credentials());assert.equal(calls,1);c.dispose();assert.equal(signal.aborted,true);const before=published;release();await pending;assert.equal(published,before);assert.equal(c.state.receipt,null);
 });
 await t.test('explicit checks reject checkpoint regressions while keeping credentials out of state',async()=>{
  const api=await load();let current=receipt('awaiting_acceptance');globalThis.fetch=async()=>Response.json({data:current});const c=new api.PublicPlexReceiptController(token,job,server,()=>{});await c.check(credentials());current=receipt();current.steps[0].plex.revision=2;await c.check(credentials());assert.equal(c.state.phase,'error');assert.equal(c.state.receipt,null);current=receipt('access_observed');current.steps[0].plex.revision=4;await c.check(credentials());assert.equal(c.state.phase,'verification_required');current=completed();current.steps[0].plex.revision=4;await c.check(credentials());assert.equal(c.state.phase,'completed');current=receipt('access_observed');current.steps[0].plex.revision=4;await c.check(credentials());assert.equal(c.state.phase,'error');
 });
});
