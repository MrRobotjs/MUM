import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const actor='12345678-1234-1234-1234-123456789abc';
const task=(scope)=>({server_id:1,server_name:'Fixture',provider:'plex',scope,revision:1,server_revision:0,enabled:true,interval_seconds:3600,state:'scheduled',next_run_time:'2026-11-03T13:00:00Z',started_at:null,finished_at:null,last_code:'NEVER_RUN',attempts:0});
const snapshot=()=>({actor_uuid:actor,configuration_available:false,runtime_available:true,checkpoint_error:false,generated_at:'2026-11-03T12:00:00Z',tasks:[task('users'),task('libraries')]});
test('independent server refresh tasks are validated and kept separate',async()=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;
 try {globalThis.window={location:{origin:'http://mum.test'}};const api=await loadFrontend("export * from './src/lib/scheduledTasks';export {setAccessToken} from './src/store/authStore';");api.setAccessToken('session');
 globalThis.fetch=async()=>Response.json({data:snapshot()});const result=await api.fetchScheduledTasks(actor);assert.deepEqual(result.tasks.map(t=>t.scope),['users','libraries']);assert.equal(result.tasks[0].provider,'plex');
 globalThis.fetch=async()=>{const p=snapshot();p.tasks=[{...task('users'),provider:'tofa'}];return Response.json({data:p})};assert.equal((await api.fetchScheduledTasks(actor)).tasks[0].provider,'tofa');
 for(const invalid of ['duplicate','scope','provider']){globalThis.fetch=async()=>{const p=snapshot();if(invalid==='duplicate')p.tasks[1].scope='users';if(invalid==='scope')p.tasks[0].scope='other';if(invalid==='provider')p.tasks[0].provider='unknown';return Response.json({data:p})};await assert.rejects(api.fetchScheduledTasks(actor))}
 } finally {globalThis.fetch=oldFetch;globalThis.window=oldWindow}
});
