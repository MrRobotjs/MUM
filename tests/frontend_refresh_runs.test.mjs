import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const load=()=>loadFrontend("export * from './src/lib/refreshRuns';export {setAccessToken} from './src/store/authStore';");
const run=(extra={})=>({id:4,started_at:'2026-11-26T10:00:00Z',finished_at:'2026-11-26T10:00:27Z',outcome:'warnings',
 entries:[{level:'success',message:'Library list refreshed: 5 libraries',items:[{title:'Dune',change:'added',item_id:9,library_id:2,poster_url:'/api/media/images/9?expires=1&signature=x'},{title:'Gone',change:'removed'}],more_items:3},{level:'warning',message:'TV Shows: skipped "Season 1"',detail:'This show has no TMDB match.'}],...extra});

test('refresh run log reader',async t=>{
 const old={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 await t.test('asks for one task and keeps each entry in order',async()=>{
  const m=await load();m.setAccessToken('token');let asked;globalThis.fetch=async req=>{asked=new URL(req.url);return Response.json({data:{server_id:3,scope:'libraries',runs:[run(),run({id:3,outcome:'succeeded',entries:[]})]}});};
  const runs=await m.fetchRefreshRuns(3,'libraries');
  assert.equal(asked.pathname,'/api/servers/3/refresh-runs');assert.equal(asked.searchParams.get('scope'),'libraries');
  assert.equal(runs.length,2);assert.equal(runs[0].entries[1].level,'warning');assert.equal(runs[0].entries[0].detail,'');assert.equal(runs[0].entries[1].detail,'This show has no TMDB match.');assert.equal(runs[1].entries.length,0);
  const [kept,removed]=runs[0].entries[0].items;assert.equal(kept.poster_url,'/api/media/images/9?expires=1&signature=x');assert.equal(kept.library_id,2);assert.equal(removed.item_id,null);assert.equal(removed.poster_url,null);assert.equal(runs[0].entries[0].more_items,3);assert.equal(runs[0].entries[1].items.length,0);
 });
 await t.test('refuses malformed runs and requests',async()=>{
  const m=await load();m.setAccessToken('token');
  for(const bad of [run({outcome:'partial'}),run({id:0}),run({finished_at:'later'}),run({entries:[{level:'debug',message:'x'}]}),run({entries:[{level:'error',message:5}]}),run({entries:'none'}),run({entries:[{level:'success',message:'x',items:[{title:'a',change:'moved'}]}]}),run({entries:[{level:'success',message:'x',items:[{title:'a',change:'added',poster_url:'https://evil.test/x.jpg'}]}]}),run({entries:[{level:'success',message:'x',items:[{title:'a',change:'added',item_id:-1}]}]})]){
   globalThis.fetch=async()=>Response.json({data:{runs:[bad]}});await assert.rejects(m.fetchRefreshRuns(3,'libraries'));
  }
  await assert.rejects(m.fetchRefreshRuns(0,'libraries'));await assert.rejects(m.fetchRefreshRuns(3,'everything'));
 });
});
