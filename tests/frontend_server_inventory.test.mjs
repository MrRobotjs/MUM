import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){const r=await build({stdin:{contents:"export {useLibraries} from './src/hooks/useLibraries';export {useUsersPaginated} from './src/hooks/useUsersPaginated';export {setAccessToken} from './src/store/authStore';",resolveDir:fileURLToPath(new URL('../frontend/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser',plugins:[{name:'inventory-hook-boundaries',setup(b){
 b.onResolve({filter:/^(react|swr)$|contexts\/AuthContext$/},args=>({path:args.path,namespace:'inventory-test'}));
 b.onLoad({filter:/.*/,namespace:'inventory-test'},args=>({contents:args.path==='react'?'export const useSyncExternalStore=(subscribe,read)=>read();':args.path==='swr'?'export default function useSWR(key,fetcher){globalThis.inventory.key=key;globalThis.inventory.fetcher=fetcher;return {data:globalThis.inventory.cache.get(JSON.stringify(key)),error:globalThis.inventory.error,isLoading:false,mutate:fetcher}};':'export const useAuth=()=>globalThis.inventory.auth;'}));
 }}]});return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}#${Math.random()}`);}
test('server inventory read boundaries',async t=>{
 const old={window:globalThis.window,fetch:globalThis.fetch,inventory:globalThis.inventory};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 const setup=async()=>{globalThis.inventory={auth:{user:{uuid:'actor'},isAdministrator:true},cache:new Map()};const m=await load();m.setAccessToken('session');return m;};
 await t.test('session and source cache changes hide old lists; errors and loss of authority hide saved data',async()=>{
  const m=await setup();for(const kind of ['libraries','users']){const read=()=>kind==='libraries'?m.useLibraries({serverId:1}):m.useUsersPaginated({serverId:'1'});read();const oldKey=JSON.stringify(globalThis.inventory.key);globalThis.inventory.cache.set(oldKey,{data:kind==='libraries'?[{id:1,server_id:1}]:[{uuid:'service',server_id:1}],meta:{pagination:{total_items:1}}});assert.equal(read()[kind].length,1);m.setAccessToken('replacement');assert.equal(read()[kind].length,0);assert.notEqual(JSON.stringify(globalThis.inventory.key),oldKey);globalThis.inventory.auth.isAdministrator=false;assert.equal(read()[kind].length,0);assert.equal(globalThis.inventory.key,null);globalThis.inventory.auth.isAdministrator=true;m.setAccessToken('session');globalThis.inventory.error=Error('unavailable');assert.equal(read()[kind].length,0);globalThis.inventory.error=null;}
 });
 await t.test('foreign source rows are rejected in both read adapters',async()=>{
  const m=await setup();m.useLibraries({serverId:1});globalThis.fetch=async()=>Response.json({data:[{id:1,server_id:2}]});await assert.rejects(globalThis.inventory.fetcher(),/Invalid library selection/);m.useUsersPaginated({serverId:'1'});globalThis.fetch=async()=>Response.json({data:[{uuid:'service',server_id:2}],meta:{pagination:{total_items:1}}});await assert.rejects(globalThis.inventory.fetcher(),/Invalid user selection/);
 });
 await t.test('late session responses and 401s cannot populate the current inventory or replay authentication',async()=>{
  const m=await setup();m.useLibraries({serverId:1});let finish;globalThis.fetch=()=>new Promise(resolve=>finish=resolve);const pending=globalThis.inventory.fetcher();m.setAccessToken('new-session');finish(Response.json({data:[{id:1,server_id:1}]}));await assert.rejects(pending);m.useUsersPaginated({serverId:'1'});let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'Sign in'}},{status:401});};await assert.rejects(globalThis.inventory.fetcher());assert.equal(calls,1);
 });
});
