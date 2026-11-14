import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFrontend} from './frontendLoader.mjs';
const entry="export * from './src/store/authStore'; export * from './src/hooks/useSession';";
async function load(){return loadFrontend(entry,{mock:{filter:/^(react|swr)$/,module:p=>p==='react'?`export const useSyncExternalStore=(s,r)=>r();export const useEffect=()=>{};`:`export default (key,fetcher,options)=>{globalThis.sessionHarness={key,fetcher,options};return globalThis.sessionCache??{isLoading:true,mutate:async()=>{}};};`}});}
function response(data,status=200){return new Response(JSON.stringify({data}),{status});}
test('session authority is isolated on replacement and stale reads cannot complete',async t=>{
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;t.after(()=>{globalThis.fetch=oldFetch;globalThis.window=oldWindow;delete globalThis.sessionHarness;delete globalThis.sessionCache;});globalThis.window={location:{origin:'http://localhost'}};
 const m=await load();m.setAccessToken('admin-token');m.useSession();const adminKey=globalThis.sessionHarness.key;
 globalThis.fetch=async()=>response({user:{has_admin_access:true}});const admin=await globalThis.sessionHarness.fetcher(adminKey);
 globalThis.sessionCache={data:admin,isLoading:false,mutate:async()=>{}};assert.equal(m.useSession().session.user.has_admin_access,true);
 m.setAccessToken('regular-token');assert.equal(m.useSession().session,null);assert.notDeepEqual(globalThis.sessionHarness.key,adminKey);assert.equal(m.useSession().loading,true);
 globalThis.fetch=async()=>response({user:{has_admin_access:false}});const regular=await globalThis.sessionHarness.fetcher(globalThis.sessionHarness.key);globalThis.sessionCache.data=regular;assert.equal(m.useSession().session.user.has_admin_access,false);
 m.setAccessToken('new-admin');assert.equal(m.useSession().session,null);
 let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});const delayed=m.readFreshSession();m.setAccessToken('other');finish(response({user:{has_admin_access:true}}));await assert.rejects(delayed,/changed/i);
 const logoutRead=m.readFreshSession();m.clearAccessToken();finish(response({user:{has_admin_access:true}}));await assert.rejects(logoutRead,/changed/i);assert.equal(m.useSession().session,null);
});
test('session read rotates once, preserves generation and exposes 401/503 without retry loops',async t=>{
 const f=globalThis.fetch,w=globalThis.window;t.after(()=>{globalThis.fetch=f;globalThis.window=w;delete globalThis.sessionCache;delete globalThis.sessionHarness;});globalThis.window={location:{origin:'http://localhost'}};
 const m=await load();m.setAccessToken('expired');const generation=m.getAuthSnapshot().generation;let calls=[];
 globalThis.fetch=async request=>{const url=typeof request==='string'?request:request.url;calls.push(url);return url.endsWith('/refresh')?response({access_token:'rotated',user:{uuid:'same-principal'}}):calls.length===1?response(null,401):response({user:{has_admin_access:false}});};
 assert.equal((await m.readFreshSession()).user.has_admin_access,false);assert.equal(calls.length,3);assert.equal(m.getAuthSnapshot().generation,generation);
 m.useSession();assert.equal(globalThis.sessionHarness.options.revalidateOnFocus,true);assert.equal(globalThis.sessionHarness.options.revalidateOnReconnect,true);assert.equal(globalThis.sessionHarness.options.refreshInterval,60000);
 globalThis.fetch=async()=>response(null,503);await assert.rejects(m.readFreshSession(),e=>e.status===503);assert.equal(m.getAuthSnapshot().status,'authenticated');
 globalThis.sessionCache={data:{generation,credentialRevision:m.getAuthSnapshot().credentialRevision,session:{user:{has_admin_access:true}}},error:{status:503},isLoading:false,mutate:async()=>{}};assert.equal(m.useSession().session,null);assert.equal(m.useSession().error.status,503);
 calls=[];globalThis.fetch=async request=>{calls.push(request);return response(null,401);};await assert.rejects(m.readFreshSession(),e=>e.status===401);assert.equal(calls.length,2);assert.equal(m.getAuthSnapshot().status,'anonymous');
});
test('explicit same-token sign-in still invalidates cached authority',async()=>{
 const m=await load();m.setAccessToken('same');const before=m.getAuthSnapshot().generation;m.setAccessToken('same');assert.ok(m.getAuthSnapshot().generation>before);
});
test('real SWR cache cannot supply previous-account authority to a replacement key',async t=>{
 const OriginalChannel=globalThis.MessageChannel;const channels=[];globalThis.MessageChannel=class extends OriginalChannel {constructor(){super();channels.push(this);}};t.after(()=>{globalThis.MessageChannel=OriginalChannel;for(const c of channels){c.port1.close();c.port2.close();}});
 const m=await loadFrontend(`
 import React from 'react';import {renderToString} from 'react-dom/server';import {SWRConfig,unstable_serialize} from 'swr';import {useSession} from './src/hooks/useSession';import {getAuthSnapshot} from './src/store/authStore';
 export * from './src/store/authStore';
 export function renderCached(generation,credentialRevision=getAuthSnapshot().credentialRevision){let value;function Probe(){value=useSession();return null;}
 renderToString(React.createElement(SWRConfig,{value:{provider:()=>new Map(),fallback:{[unstable_serialize(['/api/auth/session',generation,credentialRevision])]:{generation,credentialRevision,session:{user:{has_admin_access:true}}}}}},React.createElement(Probe)));return value;}
 `);
 m.setAccessToken('admin');const generation=m.getAuthSnapshot().generation;
 assert.equal(m.renderCached(generation).session.user.has_admin_access,true);
 const revision=m.getAuthSnapshot().credentialRevision;const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});globalThis.fetch=async()=>response({access_token:'cookie-regular',user:{uuid:'regular'}});await m.refreshAccessToken();assert.equal(m.renderCached(generation,revision).session,null);
 m.setAccessToken('regular');assert.equal(m.renderCached(generation).session,null);
 m.clearAccessToken();assert.equal(m.renderCached(generation).session,null);
});


test('cookie refresh changes isolate cached authority and reject late old reads in both directions',async t=>{
 const f=globalThis.fetch,w=globalThis.window;t.after(()=>{globalThis.fetch=f;globalThis.window=w;delete globalThis.sessionCache;delete globalThis.sessionHarness;});globalThis.window={location:{origin:'http://localhost'}};
 for(const [before,after] of [['admin','regular'],['regular','admin']]){
 const m=await load();m.setAccessToken(before+'-token');globalThis.fetch=async()=>response({user:{uuid:before,has_admin_access:before==='admin'}});m.useSession();const key=globalThis.sessionHarness.key;const cached=await globalThis.sessionHarness.fetcher(key);globalThis.sessionCache={data:cached,isLoading:false,mutate:async()=>{}};assert.equal(m.useSession().session.user.uuid,before);
 let finish;globalThis.fetch=()=>new Promise(resolve=>{finish=resolve;});const delayed=m.readFreshSession();
 globalThis.fetch=async()=>response({access_token:after+'-token',user:{uuid:after}});await m.refreshAccessToken();
 assert.equal(m.useSession().session,null);assert.notDeepEqual(globalThis.sessionHarness.key,key);finish(response({user:{uuid:before,has_admin_access:before==='admin'}}));await assert.rejects(delayed,/changed/i);
 globalThis.fetch=async()=>response({user:{uuid:after,has_admin_access:after==='admin'}});const fresh=await globalThis.sessionHarness.fetcher(globalThis.sessionHarness.key);globalThis.sessionCache.data=fresh;assert.equal(m.useSession().session.user.uuid,after);delete globalThis.sessionCache;
 }
});



// Every 15 minutes the access token renews. A renewal for the same account must
// keep the confirmed session on screen; one for a different or unnamed account
// is a replacement and must not.
test('routine renewal for the same account keeps the confirmed session displayed',async t=>{
 const f=globalThis.fetch,w=globalThis.window;t.after(()=>{globalThis.fetch=f;globalThis.window=w;delete globalThis.sessionCache;delete globalThis.sessionHarness;});globalThis.window={location:{origin:'http://localhost'}};
 for(const [renewed,keeps] of [['alice',true],['bob',false],[undefined,false]]){
  const m=await load();m.setAccessToken('alice-token');m.useSession();
  globalThis.fetch=async()=>response({user:{uuid:'alice',has_admin_access:true}});
  const confirmed=await globalThis.sessionHarness.fetcher(globalThis.sessionHarness.key);globalThis.sessionCache={data:confirmed,isLoading:false,mutate:async()=>{}};
  assert.equal(m.useSession().session.user.uuid,'alice');
  const generation=m.getAuthSnapshot().generation;
  globalThis.fetch=async()=>response({access_token:'renewed-token',user:renewed?{uuid:renewed}:undefined});await m.refreshAccessToken();
  globalThis.sessionCache={isLoading:true,mutate:async()=>{}};
  const during=m.useSession();
  if(keeps){assert.equal(m.getAuthSnapshot().generation,generation,'same account keeps its sign-in');assert.equal(during.session?.user.uuid,'alice');assert.equal(during.loading,false);}
  else{assert.ok(m.getAuthSnapshot().generation>generation,'other or unnamed account replaces the sign-in: '+renewed);assert.equal(during.session,null);assert.equal(during.loading,true);}
  delete globalThis.sessionCache;
 }
});


// The same rule through the real SWR cache: a session confirmed by rendering
// carries over a renewal for its own account only.
test('real SWR: a confirmed session survives only a renewal for the same account',async t=>{
 const OriginalChannel=globalThis.MessageChannel;const channels=[];globalThis.MessageChannel=class extends OriginalChannel {constructor(){super();channels.push(this);}};const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;globalThis.MessageChannel=OriginalChannel;for(const c of channels){c.port1.close();c.port2.close();}});
 for(const [renewed,keeps] of [['alice',true],['bob',false]]){
  const m=await loadFrontend(`
  import React from 'react';import {renderToString} from 'react-dom/server';import {SWRConfig,unstable_serialize} from 'swr';import {useSession} from './src/hooks/useSession';import {getAuthSnapshot} from './src/store/authStore';
  export * from './src/store/authStore';
  export function render(fallback){let value;function Probe(){value=useSession();return null;}
  const {generation,credentialRevision}=getAuthSnapshot();
  renderToString(React.createElement(SWRConfig,{value:{provider:()=>new Map(),fallback:fallback?{[unstable_serialize(['/api/auth/session',generation,credentialRevision])]:{generation,credentialRevision,session:{user:{uuid:'alice',has_admin_access:true}}}}:{}}},React.createElement(Probe)));return value;}
  `);
  m.setAccessToken('alice-token');assert.equal(m.render(true).session.user.uuid,'alice');
  globalThis.fetch=async()=>response({access_token:'renewed',user:{uuid:renewed}});await m.refreshAccessToken();
  const during=m.render(false);
  if(keeps){assert.equal(during.session?.user.uuid,'alice');assert.equal(during.loading,false);}
  else{assert.equal(during.session,null,'a renewal for another account must not show the previous account');assert.equal(during.loading,true);}
 }
});
