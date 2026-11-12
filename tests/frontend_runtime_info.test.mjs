import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const actor = '12345678-1234-1234-1234-123456789abc';
const info = () => ({actor_uuid:actor,go_version:'go1.27.3',platform:'windows/amd64',timezone:'MST',timezone_offset_seconds:-25200,database_type:'SQLite',database_version:'3.50.4',database_file:null,data_directory:null,log_storage:'SQLite log_entries; process output',build_revision:null,build_modified:null});
async function load(){return loadFrontend("export * from './src/lib/runtimeInfo';export {setAccessToken} from './src/store/authStore';");}
test('runtime information adapter',async t=>{
 const previous={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,previous));globalThis.window={location:{origin:'http://mum.test'}};
 await t.test('strict actor-bound projection drops extra secrets and supports missing build metadata',async()=>{
  const m=await load();m.setAccessToken('session');globalThis.fetch=async r=>{assert.equal(new URL(r.url).pathname,'/api/settings/runtime-info');return Response.json({data:{...info(),secret:'not projected'}})};
  assert.deepEqual(await m.fetchRuntimeInfo(actor),info());
  for(const change of [{actor_uuid:'another'},{database_type:'PostgreSQL'},{timezone_offset_seconds:NaN},{database_file:'/private',data_directory:null},{build_modified:'false'}]){
   globalThis.fetch=async()=>Response.json({data:{...info(),...change}});await assert.rejects(m.fetchRuntimeInfo(actor));
  }
 });
 await t.test('late responses after logout are rejected',async()=>{
  const m=await load();m.setAccessToken('session');let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve});const pending=m.fetchRuntimeInfo(actor);m.setAccessToken(null);finish(Response.json({data:info()}));await assert.rejects(pending,/unavailable/);
 });
 await t.test('401 is never refreshed or retried',async()=>{
  const m=await load();m.setAccessToken('session');let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'Sign in'}},{status:401})};await assert.rejects(m.fetchRuntimeInfo(actor));assert.equal(calls,1);
 });
});
