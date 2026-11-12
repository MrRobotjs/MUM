import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){const r=await build({stdin:{contents:"export * from './src/lib/serverConnection';export {setAccessToken} from './src/store/authStore';",resolveDir:fileURLToPath(new URL('../frontend/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`);}
const receipt=(extra={})=>({success:true,server_id:1,revision:3,checked_at:'2026-11-05T00:00:00Z',server:{name:'Fixture',version:'1.0',api_key:'private'},...extra});
test('current saved-server connection checks',async t=>{
 const previous={window:globalThis.window,fetch:globalThis.fetch};t.after(()=>Object.assign(globalThis,previous));globalThis.window={location:{origin:'http://mum.test'}};
 const setup=async()=>{const m=await load();m.setAccessToken('session');return m;};
 await t.test('one revision-bound POST yields a projected committed receipt',async()=>{
  const m=await setup();let calls=0;globalThis.fetch=async r=>{calls++;assert.equal(new URL(r.url).pathname,'/api/servers/1/test-connection');assert.equal(r.method,'POST');assert.deepEqual(await r.json(),{expected_server_revision:3});return Response.json({data:receipt()});};
  assert.deepEqual(await m.checkServerConnection(1,3,()=>true),{server_id:1,revision:3,checked_at:'2026-11-05T00:00:00Z',name:'Fixture',version:'1.0'});assert.equal(calls,1);
 });
 await t.test('foreign revisions/servers and malformed receipts cannot be success',async()=>{
  const m=await setup();for(const extra of [{server_id:2},{revision:4},{success:false},{checked_at:'invalid'},{server:null}]){globalThis.fetch=async()=>Response.json({data:receipt(extra)});await assert.rejects(m.checkServerConnection(1,3,()=>true),/unconfirmed/);}
 });
 await t.test('refusals, provider failure and lost replies never refresh or replay',async()=>{
  const m=await setup();for(const status of [401,403,409,502,0]){let calls=0;globalThis.fetch=async()=>{calls++;if(!status)throw Error('lost');return Response.json({error:{message:'private upstream secret'}},{status});};await assert.rejects(m.checkServerConnection(1,3,()=>true),e=>!e.message.includes('private')&&/Refresh/.test(e.message));assert.equal(calls,1);}
 });
 await t.test('concurrent admission and session/selection changes discard late results',async()=>{
  for(const change of ['session','selection']){const m=await setup();let finish,current=true,calls=0;globalThis.fetch=()=>{calls++;return new Promise(resolve=>finish=resolve);};const pending=m.checkServerConnection(1,3,()=>current);await assert.rejects(m.checkServerConnection(1,3,()=>current),/pending/);if(change==='session')m.setAccessToken('new-session');else current=false;finish(Response.json({data:receipt()}));await assert.rejects(pending,/unconfirmed/);assert.equal(calls,1);}
 });
 await t.test('invalid selection and cancellation prevent dispatch',async()=>{
  const m=await setup();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:receipt()});};for(const [id,revision,current] of [[0,3,true],[1.5,3,true],[1,-1,true],[1,3,false]])await assert.rejects(m.checkServerConnection(id,revision,()=>current));const abort=new AbortController();abort.abort();await assert.rejects(m.checkServerConnection(1,3,()=>true,abort.signal));assert.equal(calls,0);
 });
});
