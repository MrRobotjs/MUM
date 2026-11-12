import assert from 'node:assert/strict';import test from 'node:test';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
async function load(){return loadFrontend("export * from './src/lib/profileMetadata';export {fetchUnlinkedServiceAccounts} from './src/lib/serviceAccounts';export {setAccessToken} from './src/store/authStore';")}
const actor='12345678-1234-1234-1234-123456789abc',target='12345678-1234-1234-1234-123456789def';
// GET /api/users returns null for an unknown email (for example a Plex managed
// account such as "Guest"); readers must treat it as "no email", not as invalid.
const profile=()=>({id:1,uuid:target,user_type:'service',username:'Guest',display_name:'Guest',email:null,external_email:null,is_active:true,access_expires_at:null,created_at:'2026-11-03T12:00:00Z',notes:'',server_id:1,server_nickname:'Plex++',service_type:'plex',linked_service_count:0,admin_roles:[],user_roles:[],libraries:['Movies'],has_all_libraries:false,linked_local_user:null});
test('a missing email is accepted as null by user readers',async t=>{
 const before={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>{globalThis.fetch=before.fetch;globalThis.window=before.window});
 globalThis.window={location:{origin:'http://mum.test'}};
 await t.test('profile page loads an account without email',async()=>{const a=await load();a.setAccessToken('session');globalThis.fetch=async()=>Response.json({data:profile()});const p=await a.fetchProfileMetadata(actor,target);assert.equal(p.email,null);assert.equal(p.external_email,null);assert.equal(p.external_username,'Guest')});
 await t.test('a non-string, non-null email still fails closed',async()=>{for(const email of [5,{},'x'.repeat(321),'bad\nvalue']){const a=await load();a.setAccessToken('session');globalThis.fetch=async()=>Response.json({data:{...profile(),email}});await assert.rejects(a.fetchProfileMetadata(actor,target))}});
 await t.test('unlinked service accounts list includes accounts without email',async()=>{const a=await load();a.setAccessToken('session');globalThis.fetch=async()=>Response.json({data:[{uuid:target,user_type:'service',username:'Guest',email:null,service_type:'plex',server_nickname:'Plex++',linked_local_user:null}],meta:{pagination:{page:1,page_size:100,total_items:1,total_pages:1}}});const out=await a.fetchUnlinkedServiceAccounts();assert.equal(out.length,1);assert.equal(out[0].external_email,null)});
});
