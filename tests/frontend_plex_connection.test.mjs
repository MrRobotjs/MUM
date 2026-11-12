import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
async function load(){return loadFrontend("export * from './src/lib/plexConnection';");}
const owner='11111111-1111-4111-8111-111111111111';
const auth='22222222-2222-4222-8222-222222222222';
const connectionID='33333333-3333-4333-8333-333333333333';
const client='44444444-4444-4444-8444-444444444444';
const now=Date.parse('2026-11-02T12:00:00Z');
const url=`https://app.plex.tv/auth#?clientID=${client}&code=strongCode1234567890&context%5Bdevice%5D%5Bproduct%5D=MUM`;
const profile={uuid:owner,username:'Owner',email:null,user_type:'owner',has_password:true,force_password_change:false,last_login_at:null,plex_authorization_enabled:true,profile_changes_available:false,password_change_available:true,email_change_available:true,profile_revision:1,email_verified:false};
const pending={id:auth,status:'pending',expires_at:'2026-11-02T12:10:00Z',revision:2,authorization_url:url};
const verified={id:auth,status:'verified',expires_at:pending.expires_at,revision:4,account:{id:'2',username:'Reader'}};
const connected={id:connectionID,account_id:'2',username:'Reader',status:'active',verified_at:'2026-11-02T12:00:00Z'};
function respond(data,status=200){return Response.json({data},{status});}

test('Plex personal connection adapters',async t=>{
 const previousFetch=globalThis.fetch;const previousWindow=globalThis.window;
 globalThis.window={location:{origin:'http://mum.test'},localStorage:{setItem(){throw new Error('Private state cannot be persisted');}},sessionStorage:{setItem(){throw new Error('Private state cannot be persisted');}}};
 t.after(()=>{globalThis.fetch=previousFetch;globalThis.window=previousWindow;});
 await t.test('only permits the exact fixed authorization origin and parameters',async()=>{
  const api=await load();assert.equal(api.plexAuthorizationURL(url),url);
  for(const bad of [url.replace('app.plex.tv','evil.invalid'),url+'&forwardUrl=https%3A%2F%2Fevil.invalid',url+'&code=duplicate',url.replace('https:','javascript:'),url.replace('/auth','/other'),url.replace('strongCode1234567890','1234')]) assert.throws(()=>api.plexAuthorizationURL(bad));
 });
 await t.test('explicit start, poll, account confirmation and local disconnect retain no credentials',async()=>{
  const api=await load();let active=null;const calls=[];
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;calls.push(path);assert.equal(req.credentials,'include');
   if(path==='/api/account/profile')return respond(profile);
   if(path==='/api/plex/connection')return respond(active);
   if(path.endsWith('/confirm')){assert.deepEqual(await req.json(),{expected_account_id:'2'});active=connected;return respond({...connected,authToken:'must-not-copy'},201);}
   if(path.endsWith('/revoke')){active=null;return respond({id:connectionID,status:'revoked',scope:'local_connection'});}
   if(path.endsWith('/poll'))return respond(verified);
   if(path==='/api/plex/authorizations')return respond(pending,201);
   throw new Error(path);
  };
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);
  await flow.reload();assert.equal(flow.state.phase,'ready');
  await flow.start();assert.equal(flow.state.phase,'pending');assert.equal(flow.state.challenge.authorization_url,url);
  await flow.poll();assert.equal(flow.state.phase,'verified');assert.equal(flow.state.challenge.authorization_url,undefined);
  assert.equal(active,null,'poll must not confirm automatically');
  await flow.confirm();assert.equal(flow.state.phase,'connected');assert.equal(JSON.stringify(flow.state).includes('must-not-copy'),false);
  await flow.confirm();assert.equal(calls.filter(p=>p.endsWith('/confirm')).length,1);
  await flow.disconnect();assert.equal(flow.state.phase,'ready');assert.equal(flow.state.connection,null);
 });
 await t.test('pending polls retain the authorization link and throttle manual checks',async()=>{
  const api=await load();let polls=0;let clock=now;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection')return respond(null);if(path.endsWith('/poll')){polls++;return respond({...pending,authorization_url:undefined,revision:3});}return respond(pending,201);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>clock);await flow.reload();await flow.start();await flow.poll();await flow.poll();
  assert.equal(polls,1);assert.equal(flow.state.challenge.authorization_url,url);
  clock=Date.parse(pending.expires_at);flow.expire();assert.equal(flow.state.phase,'expired');assert.equal(flow.state.challenge,null);await flow.poll();assert.equal(polls,1);
 });
 await t.test('unknown confirmation reconciles with a read and never replays the mutation',async()=>{
  const api=await load();let active=null;let confirmations=0;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection')return respond(active);if(path.endsWith('/poll'))return respond(verified);if(path.endsWith('/confirm')){confirmations++;active=connected;throw new Error('lost response');}return respond(pending,201);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();await flow.start();await flow.poll();await flow.confirm();
  assert.equal(flow.state.phase,'uncertain');assert.equal(flow.state.challenge,null);await flow.confirm();await flow.start();assert.equal(confirmations,1);
  await flow.reload();assert.equal(flow.state.phase,'connected');assert.equal(confirmations,1);
 });
 await t.test('uncertain start does not retry and can only resolve through explicit status',async()=>{
  const api=await load();let starts=0;let readFails=false;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection'){if(readFails)throw new Error('unavailable');return respond(null);}starts++;throw new Error('network');};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();await flow.start();await flow.start();assert.equal(starts,1);assert.equal(flow.state.phase,'uncertain');readFails=true;await flow.reload();assert.equal(flow.state.enabled,false);await flow.start();assert.equal(starts,1);readFails=false;await flow.reload();assert.equal(flow.state.phase,'ready');
 });
 await t.test('owner changes, disabled providers and stale disposed results cannot authorize',async()=>{
  const api=await load();let posts=0;let p={...profile,plex_authorization_enabled:false};
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(p);if(path==='/api/plex/connection')return respond(null);posts++;return respond(pending,201);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();await flow.start();assert.equal(posts,0);
  p={...profile};await flow.reload();p={...profile,uuid:client};await flow.start();assert.equal(posts,0);
  p=profile;let release;globalThis.fetch=async req=>{if(new URL(req.url).pathname==='/api/account/profile')return respond(p);if(new URL(req.url).pathname==='/api/plex/connection')return respond(null);return new Promise(resolve=>release=resolve);};
  const delayed=new api.PlexConnectionController(owner,()=>{},()=>now);await delayed.reload();const action=delayed.start();while(!release)await new Promise(resolve=>setTimeout(resolve,0));delayed.dispose();release(respond(pending,201));await action;assert.equal(delayed.state.challenge,null);
 });
 await t.test('mismatched account or unsafe approval responses require reconciliation',async()=>{
  const api=await load();let wrong=false;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection')return respond(null);if(path.endsWith('/poll'))return respond({...verified,id:client});if(wrong)return respond({...pending,authorization_url:url+'&forwardUrl=bad'},201);return respond(pending,201);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();await flow.start();await flow.poll();assert.equal(flow.state.phase,'uncertain');await flow.reload();wrong=true;await flow.start();assert.equal(flow.state.phase,'uncertain');
 });
 await t.test('lost disconnect response preserves uncertainty until current status is read',async()=>{
  const api=await load();let active=connected;let disconnects=0;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection')return respond(active);if(path.endsWith('/revoke')){disconnects++;active=null;throw new Error('lost disconnect response');}throw new Error(path);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();await flow.disconnect();assert.equal(flow.state.phase,'uncertain');await flow.disconnect();assert.equal(disconnects,1);await flow.reload();assert.equal(flow.state.phase,'ready');assert.equal(flow.state.connection,null);
 });
 await t.test('duplicate button actions produce one in-flight mutation',async()=>{
  const api=await load();let starts=0;let release;
  globalThis.fetch=async req=>{const path=new URL(req.url).pathname;if(path==='/api/account/profile')return respond(profile);if(path==='/api/plex/connection')return respond(null);starts++;return new Promise(resolve=>release=resolve);};
  const flow=new api.PlexConnectionController(owner,()=>{},()=>now);await flow.reload();const a=flow.start();const b=flow.start();while(!release)await new Promise(resolve=>setTimeout(resolve,0));release(respond(pending,201));await Promise.all([a,b]);assert.equal(starts,1);
 });
});
