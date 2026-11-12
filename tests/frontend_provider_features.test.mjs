import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const provider=(extra={})=>({id:'jellyfin',enabled:true,capabilities:['libraries.read','libraries.sync','users.provision'],...extra});
async function load(){return loadFrontend("export * from './src/lib/providerFeatures';export {setAccessToken} from './src/store/authStore';");}
test('current provider features',async t=>{
 const old={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 await t.test('current read/provisioning metadata never grants session-message or bulk-edit support',async()=>{
  const m=await load();m.setAccessToken('session');globalThis.fetch=async r=>{assert.equal(new URL(r.url).pathname,'/api/providers');assert.equal(r.method,'GET');return Response.json({data:[provider({api_key:'private',supports_library_scoped_grants:true,features:['session_message']})]});};
  assert.deepEqual(await m.fetchProviderFeatures(),{jellyfin:{capabilities:provider().capabilities,features:[],supports_library_scoped_grants:false}});
  globalThis.fetch=async()=>Response.json({data:[provider({enabled:false})]});assert.deepEqual((await m.fetchProviderFeatures()).jellyfin.capabilities,[]);
 });
 await t.test('missing, duplicate, unknown and malformed metadata fail closed',async()=>{
  const m=await load();m.setAccessToken('session');for(const data of [undefined,{},[provider(),provider()],[provider({id:'__proto__'})],[provider({enabled:undefined})],[provider({capabilities:['libraries.read','libraries.read']})],[provider({capabilities:['secret\nvalue']})]]){globalThis.fetch=async()=>Response.json({data});await assert.rejects(m.fetchProviderFeatures());}
 });
 await t.test('late data after session replacement is discarded',async()=>{
  const m=await load();m.setAccessToken('first');let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve});const pending=m.fetchProviderFeatures();m.setAccessToken('second');finish(Response.json({data:[provider()]}));await assert.rejects(pending,/unavailable/);
 });
 await t.test('anonymous and 401 requests cannot trigger refresh or replay',async()=>{
  const m=await load();let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'Sign in'}},{status:401});};m.setAccessToken(null);await assert.rejects(m.fetchProviderFeatures());assert.equal(calls,0);m.setAccessToken('session');await assert.rejects(m.fetchProviderFeatures());assert.equal(calls,1);
 });
});
