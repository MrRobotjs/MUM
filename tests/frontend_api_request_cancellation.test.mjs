import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('non-retrying requests avoid cloning the request and handle cancellation',async t=>{
 const original={fetch:globalThis.fetch,window:globalThis.window,clone:Request.prototype.clone};
 t.after(()=>{globalThis.fetch=original.fetch;globalThis.window=original.window;Request.prototype.clone=original.clone});
 globalThis.window={location:{origin:'http://mum.test'}};
 const m=await loadFrontend("export {requestJson} from './src/util/apiClient';");
 let clones=0;
 Request.prototype.clone=function(){clones++;return original.clone.call(this)};
 const controller=new AbortController();
 globalThis.fetch=req=>new Promise((resolve,reject)=>req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true}));
 const pending=m.requestJson('/api/libraries/1/media',{signal:controller.signal,retryAuthentication:false});
 controller.abort();
 await assert.rejects(pending,{name:'AbortError'});
 assert.equal(clones,0);
});

test('replacing a pending catalogue read handles its rejection and accepts the newer response',async t=>{
 const original={fetch:globalThis.fetch,window:globalThis.window};
 t.after(()=>Object.assign(globalThis,original));
 globalThis.window={location:{origin:'http://mum.test'}};
 const m=await loadFrontend("export {requestJson} from './src/util/apiClient';export {CatalogueView} from './src/lib/catalogueView';export {setAccessToken} from './src/store/authStore';");
 m.setAccessToken('fixture-token');
 const view=new m.CatalogueView('fixture-token');view.update({media:'same'});
 let calls=0;
 globalThis.fetch=req=>{calls++;if(calls===1)return new Promise((resolve,reject)=>req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true}));return Promise.resolve(Response.json({data:'latest'}));};
 const first=view.begin('media');
 const old=m.requestJson('/api/libraries/1/media',{signal:first.signal,retryAuthentication:false}).catch(error=>{if(first.current())throw error;return null}).finally(first.finish);
 const next=view.begin('media');
 const current=await m.requestJson('/api/libraries/1/media',{signal:next.signal,retryAuthentication:false});
 next.finish();
 assert.equal(await old,null);
 assert.equal(current.data,'latest');
 assert.equal(next.current(),true);
 view.dispose();
});
