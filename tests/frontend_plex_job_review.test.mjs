import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){
 const r=await build({stdin:{contents:"export * from './src/lib/plexJobReview'; export { fetchProvisioningReceipt, reviewDecisionPayload } from './src/lib/provisioningReview'; export { setAccessToken } from './src/store/authStore';",resolveDir:directory},bundle:true,write:false,format:'esm',platform:'browser'});
 return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
const id='12345678-1234-1234-1234-123456789abc';
const owner='87654321-1234-1234-1234-123456789abc';
const profile={uuid:owner,username:'owner',email:null,user_type:'owner',has_password:true,force_password_change:false,last_login_at:null,plex_authorization_enabled:true,profile_changes_available:false,password_change_available:true,email_change_available:true,profile_revision:1,email_verified:false};
const job=(revision=3)=>({id,status:'running',revision:1,reservation_held:true,review_in_progress:false,steps:[{server_id:9,plex:{state:'access_observed',revision,operation_in_progress:false,reconciliation_required:false,access_verified:false,cleanup_scope:'none'}}],plex_progress:{phase:'verification_required',operation_in_progress:false,requires_review:true,completion_available:false}});
const completed=()=>{const j=job(5);return {...j,status:'completed',revision:2,reservation_held:false,steps:[{...j.steps[0],plex:{...j.steps[0].plex,completion_recorded:true,verification_scope:'accepted_cloud_and_recipient_library_listing',verified_at:'2026-11-02T12:00:00Z'}}],plex_progress:{...j.plex_progress,phase:'completed',requires_review:false}};};
const decision=(activate=false)=>({reason:'Reviewed the accepted selected libraries',acknowledge_in_flight_risk:true,acknowledge_local_activation:activate});
test('Plex administrator job controls',async t=>{
 const previousFetch=globalThis.fetch,previousWindow=globalThis.window;
 globalThis.window={location:{origin:'http://mum.test'}};
 t.after(()=>{globalThis.fetch=previousFetch;globalThis.window=previousWindow;});
 const setup=async(handler=()=>Response.json({data:job()}))=>{
  const api=await load();api.setAccessToken('current-test-session');
  const calls=[];
  globalThis.fetch=async request=>{
   const path=new URL(request.url).pathname;calls.push({path,method:request.method});
   if(path==='/api/account/profile')return Response.json({data:profile});
   return handler(request,path,calls);
  };
  const c=new api.PlexJobReviewController(id,()=>{});await c.reload();return {api,c,calls};
 };
 await t.test('classifies Plex receipts separately and strips secret/unknown fields',async()=>{
  const {api}=await setup();const raw=job();raw.secret='do-not-store';raw.steps[0].plex.account_id='2';
  const parsed=api.plexReviewJob(raw,id);assert.ok(!JSON.stringify(parsed).includes('do-not-store'));assert.ok(!('account_id' in parsed.steps[0].plex));
  globalThis.fetch=async()=>Response.json({data:raw});assert.ok('plex_progress' in await api.fetchProvisioningReceipt(id));
  assert.throws(()=>api.reviewDecisionPayload(raw,'cancel',decision()),/not available/);
 });
 await t.test('rejects malformed, foreign and fabricated completed receipts',async()=>{
  const {api}=await setup();
  for(const change of [j=>j.id='other',j=>j.revision=0,j=>j.steps.push(j.steps[0]),j=>j.plex_progress.completion_available=true,j=>j.steps[0].plex.access_verified=true,j=>j.steps[0].plex.cleanup_scope='media',j=>j.plex_progress.phase='completed']){
   const j=job();change(j);assert.throws(()=>api.plexReviewJob(j,id),/Invalid/);
  }
  assert.equal(api.plexReviewJob(completed(),id).plex_progress.phase,'completed');
 });
 await t.test('requires exact consent and available one-server running reservation',async()=>{
  const {api}=await setup();
  for(const d of [{...decision(),reason:'short'},{...decision(),reason:'é'.repeat(501)},{...decision(),acknowledge_in_flight_risk:false},decision(true)])assert.throws(()=>api.plexJobActionPayload(job(),'verify',d),/reason/);
  for(const j of [{...job(),status:'failed'},{...job(),reservation_held:false},{...job(),review_in_progress:true},{...job(),steps:[...job().steps,{server_id:10}]}])assert.throws(()=>api.plexJobActionPayload(j,'verify',decision()),/not available/);
  const payload=api.plexJobActionPayload(job(),'finalize',decision(true));assert.equal(payload.checkpoint_revision,3);assert.equal(payload.job_revision,1);assert.equal(payload.acknowledge_local_activation,true);
 });
 await t.test('verification requires a fresh matching read; then explicit activation completes once',async()=>{
  let current=job(),mutations=[];
  const {c}=await setup(async(request,path)=>{
   if(request.method==='POST'){mutations.push({path,body:await request.json()});current=path.endsWith('/verify')?job(5):completed();}
   return Response.json({data:current});
  });
  await c.action('finalize',decision(true));assert.equal(mutations.length,0);
  await c.action('verify',decision());assert.equal(c.state.canFinalize,true);assert.equal(mutations.length,1);
  await c.action('finalize',decision(true));assert.equal(c.state.job.status,'completed');assert.equal(c.state.canFinalize,false);assert.equal(mutations.length,2);
  assert.equal(mutations[0].body.acknowledge_local_activation,false);assert.equal(mutations[1].body.checkpoint_revision,5);
  await c.action('finalize',decision(true));assert.equal(mutations.length,2);
 });
 await t.test('lost mutation response reads current receipt without replaying the POST',async()=>{
  let posts=0,current=job();
  const {c}=await setup(async request=>{if(request.method==='POST'){posts++;current=job(5);throw Error('lost response');}return Response.json({data:current});});
  await c.action('verify',decision());assert.equal(posts,1);assert.equal(c.state.job.steps[0].plex.revision,5);assert.equal(c.state.canFinalize,false);assert.match(c.state.error,/not be confirmed/);
 });
 await t.test('401 mutation response never refreshes and replays the mutation',async()=>{
  let posts=0,refresh=0;
  const {c}=await setup(async(request,path)=>{if(path==='/api/auth/refresh'){refresh++;return Response.json({data:{access_token:'replacement'}});}if(request.method==='POST'){posts++;return Response.json({error:{message:'session ended'}},{status:401});}return Response.json({data:job()});});
  await c.action('verify',decision());assert.equal(posts,1);assert.equal(refresh,0);assert.equal(c.state.canFinalize,false);
 });
 await t.test('lost finalization response reads completed history without claiming a fresh verification',async()=>{
  let current=job(),posts=0;
  const {c}=await setup(async(request,path)=>{
   if(request.method==='POST'){posts++;if(path.endsWith('/finalize')){current=completed();throw Error('response lost after commit');}current=job(5);}
   return Response.json({data:current});
  });
  await c.action('verify',decision());assert.equal(c.state.canFinalize,true);
  await c.action('finalize',decision(true));assert.equal(posts,2);assert.equal(c.state.job.plex_progress.phase,'completed');assert.equal(c.state.canFinalize,false);assert.match(c.state.error,/not be confirmed/);
 });
 await t.test('409 conflicts and invalid mutation responses reconcile only by reading',async()=>{
  for(const invalid of [false,true]){
   let posts=0;
   const {c}=await setup(async request=>{if(request.method==='POST'){posts++;return invalid?Response.json({data:{...job(),id:'wrong'}}):Response.json({error:{message:'stale'}},{status:409});}return Response.json({data:job(7)});});
   await c.action('verify',decision());assert.equal(posts,1);assert.equal(c.state.canFinalize,false);assert.equal(c.state.job.steps[0].plex.revision,7);
  }
 });
 await t.test('changed receipt revision and failed follow-up read cannot enable activation',async()=>{
  for(const failRead of [false,true]){
   let sent=false;
   const {c}=await setup(async request=>{if(request.method==='POST'){sent=true;return Response.json({data:job(5)});}if(sent && failRead)throw Error('read failed');return Response.json({data:job(sent?7:3)});});
   await c.action('verify',decision());assert.equal(c.state.canFinalize,false);if(failRead)assert.equal(c.state.job,null);
  }
 });
 await t.test('verification readiness expires and explicit reload clears it',async()=>{
  const {api}=await setup();let now=1000,current=job();
  globalThis.fetch=async r=>{if(new URL(r.url).pathname==='/api/account/profile')return Response.json({data:profile});if(r.method==='POST')current=job(5);return Response.json({data:current});};
  const c=new api.PlexJobReviewController(id,()=>{},()=>now);await c.reload();await c.action('verify',decision());assert.equal(c.state.canFinalize,true);
  now+=60000;c.expire();assert.equal(c.state.canFinalize,false);
  await c.action('verify',decision());assert.equal(c.state.canFinalize,false); // unchanged checkpoint does not establish a new verification
  await c.reload();assert.equal(c.state.canFinalize,false);
 });
 await t.test('busy admission prevents double clicks and disposed results do not publish',async()=>{
  let release,posts=0,publications=0;
  const {api}=await setup();globalThis.fetch=async r=>{if(new URL(r.url).pathname==='/api/account/profile')return Response.json({data:profile});if(r.method==='POST'){posts++;await new Promise(resolve=>release=resolve);return Response.json({data:job(5)});}return Response.json({data:job()});};
  const c=new api.PlexJobReviewController(id,()=>publications++);await c.reload();const pending=c.action('verify',decision());
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));await c.action('verify',decision());assert.equal(posts,1);c.dispose();const before=publications;release();await pending;assert.equal(publications,before);assert.equal(c.state.job,null);
 });
 await t.test('logout and account switches block mutation admission or discard its result',async()=>{
  let switched=false,posts=0;
  const {api,c}=await setup(async r=>{if(r.method==='POST'){posts++;api.setAccessToken(null);}return Response.json({data:job(5)});});
  await c.action('verify',decision());assert.equal(posts,1);assert.equal(c.state.job,null);assert.equal(c.state.canFinalize,false);
  api.setAccessToken('different-session');
  globalThis.fetch=async r=>{if(new URL(r.url).pathname==='/api/account/profile'){switched=true;return Response.json({data:{...profile,uuid:id}});}return Response.json({data:job()});};
  await c.reload();assert.equal(switched,true);assert.equal(c.state.job,null);await c.action('verify',decision());assert.equal(posts,1);
 });
});
