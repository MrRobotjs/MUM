import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const load=()=>loadFrontend("export * from './src/lib/debugLogging';export {setAccessToken} from './src/store/authStore';");
const state=(extra={})=>({available:true,window_hours:24,dropped_records:0,
 streams:[{provider:'jellyfin',provider_name:'Jellyfin',transport:'http',enabled:true,enabled_until:'2026-11-27T10:00:00Z'},{provider:'jellyfin',provider_name:'Jellyfin',transport:'websocket',enabled:false,enabled_until:null}],
 files:[{name:'jellyfin-http.log',provider:'jellyfin',transport:'http',part:0,size_bytes:2048,modified_at:'2026-11-26T10:00:00Z'}],...extra});

test('debug logging reader',async t=>{
 const old={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 await t.test('reads the streams and files and sends one switch at a time without retrying',async()=>{
  const m=await load();m.setAccessToken('token');const asked=[];globalThis.fetch=async req=>{asked.push({method:req.method,url:new URL(req.url),body:req.method==='PUT'?await req.text():''});return Response.json({data:state()});};
  const read=await m.fetchDebugLogging();assert.equal(read.streams.length,2);assert.equal(read.streams[0].enabled_until,'2026-11-27T10:00:00Z');assert.equal(read.files[0].size_bytes,2048);
  await m.saveDebugStream('jellyfin','websocket',true);
  assert.equal(asked[1].method,'PUT');assert.deepEqual(JSON.parse(asked[1].body),{provider:'jellyfin',transport:'websocket',enabled:true});
  await m.clearDebugLogs();assert.equal(asked[2].method,'DELETE');assert.equal(asked[2].url.pathname,'/api/settings/debug-logging/files');
 });
 await t.test('reads records and refuses malformed ones',async()=>{
  const m=await load();m.setAccessToken('token');let asked;
  globalThis.fetch=async req=>{asked=new URL(req.url);return Response.json({data:{entries:[{time:'2026-11-26T10:00:00Z',server_id:3,server:'Tofa',provider:'tofa',transport:'http',direction:'response',method:'GET',url:'http://tofa/api',status:200,duration_ms:12,bytes:40,body:'{"a":1}'}]}});};
  const records=await m.fetchDebugRecords('tofa','http',20);
  assert.equal(asked.searchParams.get('limit'),'20');assert.equal(records[0].status,200);assert.equal(records[0].truncated,false);assert.equal(records[0].error,'');
  for(const bad of [{time:'now',provider:'tofa',transport:'http',direction:'response',bytes:1},{time:'2026-11-26T10:00:00Z',provider:'tofa',transport:'smoke',direction:'response',bytes:1},{time:'2026-11-26T10:00:00Z',provider:'tofa',transport:'http',direction:'response',bytes:-1}]){
   globalThis.fetch=async()=>Response.json({data:{entries:[bad]}});await assert.rejects(m.fetchDebugRecords('tofa','http'));
  }
 });
 await t.test('refuses malformed settings and requests',async()=>{
  const m=await load();m.setAccessToken('token');
  for(const bad of [state({streams:[{provider:'jellyfin',provider_name:'Jellyfin',transport:'http',enabled:true,enabled_until:null}]}),state({files:[{name:'../mum.sqlite',provider:'jellyfin',transport:'http',part:0,size_bytes:1,modified_at:'2026-11-26T10:00:00Z'}]}),state({window_hours:-1})]){
   globalThis.fetch=async()=>Response.json({data:bad});await assert.rejects(m.fetchDebugLogging());
  }
  await assert.rejects(m.saveDebugStream('Jelly fin','http',true));await assert.rejects(m.downloadDebugLog('../mum.sqlite'));await assert.rejects(m.fetchDebugRecords('tofa','http',500));
 });
});
