import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
async function load(){return loadFrontend("export * from './src/lib/serverSync';export {setAccessToken} from './src/store/authStore';");}
const receipt=(scope,extra={})=>({server_id:1,source_revision:3,revision:4,scope,libraries:scope==='libraries'?2:0,users:scope==='users'?3:0,added:scope==='users'?1:0,updated:scope==='users'?2:0,removed:0,...extra});
test('current server synchronization receipts',async t=>{
 const old={window:globalThis.window,fetch:globalThis.fetch};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 const setup=async()=>{const m=await load();m.setAccessToken('session');return m;};
 await t.test('both scopes post exact revisions and project only committed counts',async()=>{
  const m=await setup();for(const scope of ['users','libraries']){globalThis.fetch=async r=>{assert.equal(new URL(r.url).pathname,`/api/servers/1/sync-${scope}`);assert.equal(r.method,'POST');assert.deepEqual(await r.json(),{expected_server_revision:3});return Response.json({data:{...receipt(scope),api_key:'private'}});};assert.deepEqual(await m.syncSelectedServer(1,3,scope,()=>true),receipt(scope));}
 });
 await t.test('wrong source/revision/scope and impossible counts cannot be success',async()=>{
  const m=await setup();for(const change of [{server_id:2},{revision:5},{source_revision:2},{scope:'libraries'},{users:-1},{libraries:1},{added:'1'}]){globalThis.fetch=async()=>Response.json({data:receipt('users',change)});await assert.rejects(m.syncSelectedServer(1,3,'users',()=>true),/unconfirmed/);}
 });
 await t.test('401, conflict, provider failure and lost replies never refresh or replay',async()=>{
  const m=await setup();for(const status of [401,403,409,502,0]){let calls=0;globalThis.fetch=async()=>{calls++;if(!status)throw Error('lost after commit');return Response.json({error:{message:'private upstream'}},{status});};await assert.rejects(m.syncSelectedServer(1,3,'users',()=>true),e=>!e.message.includes('private')&&/Refresh/.test(e.message));assert.equal(calls,1);}
 });
 await t.test('users and libraries share admission; navigation and session changes discard late receipts',async()=>{
  for(const change of ['selection','session']){const m=await setup();let finish,current=true,calls=0;globalThis.fetch=()=>{calls++;return new Promise(resolve=>finish=resolve);};const pending=m.syncSelectedServer(1,3,'users',()=>current);await assert.rejects(m.syncSelectedServer(1,3,'libraries',()=>current),/pending/);if(change==='session')m.setAccessToken('new');else current=false;finish(Response.json({data:receipt('users')}));await assert.rejects(pending,/unconfirmed/);assert.equal(calls,1);}
 });
 await t.test('invalid or cancelled selections cannot dispatch',async()=>{
  const m=await setup();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:receipt('users')});};for(const [id,revision,scope] of [[0,3,'users'],[1,-1,'users'],[1,Number.MAX_SAFE_INTEGER,'users'],[1,3,'all']])await assert.rejects(m.syncSelectedServer(id,revision,scope,()=>true));const a=new AbortController();a.abort();await assert.rejects(m.syncSelectedServer(1,3,'users',()=>true,a.signal));assert.equal(calls,0);
 });
});
