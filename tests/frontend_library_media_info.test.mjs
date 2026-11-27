import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const load=()=>loadFrontend("export * from './src/lib/libraryMediaInfo';export {setAccessToken} from './src/store/authStore';");
const row=(extra={})=>({id:7,item_type:'episode',title:'Pilot',parent_id:3,parent_title:'Show',season_number:1,episode_number:2,year:2025,added_at:'2026-01-01T00:00:00Z',
 media_info:{container:'MKV',bitrate_kbps:9861,video_resolution:'1080p'},plays:2,last_played_at:'2026-11-20T10:00:00Z',...extra});
const page=items=>({data:{items,pagination:{page:1,page_size:25,total_items:items.length,total_pages:1}}});

test('library media info reader',async t=>{
 const old={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};
 const query={page:1,pageSize:25,sort:'bitrate',desc:true,search:' show '};
 await t.test('sends the sort, order and trimmed search and keeps each row',async()=>{
  const m=await load();m.setAccessToken('token');let asked;globalThis.fetch=async req=>{asked=new URL(req.url);return Response.json(page([row(),row({id:8,parent_id:null,parent_title:null,item_type:'movie',media_info:null,last_played_at:null,plays:0})]));};
  const result=await m.fetchLibraryMediaInfo(5,query);
  assert.equal(asked.pathname,'/api/libraries/5/media-info');assert.equal(asked.searchParams.get('sort'),'bitrate');assert.equal(asked.searchParams.get('order'),'desc');assert.equal(asked.searchParams.get('search'),'show');
  assert.equal(result.total_items,2);assert.equal(result.items[0].media_info.bitrate_kbps,9861);assert.equal(result.items[0].parent_title,'Show');assert.equal(result.items[1].media_info,null);assert.equal(result.items[1].parent_id,null);
 });
 await t.test('refuses malformed rows and requests',async()=>{
  const m=await load();m.setAccessToken('token');
  for(const bad of [row({plays:-1}),row({parent_id:0}),row({media_info:{bitrate_kbps:'fast'}}),row({last_played_at:'yesterday'}),row({title:5})]){globalThis.fetch=async()=>Response.json(page([bad]));await assert.rejects(m.fetchLibraryMediaInfo(5,query));}
  await assert.rejects(m.fetchLibraryMediaInfo(5,{...query,sort:'summary'}));await assert.rejects(m.fetchLibraryMediaInfo(5,{...query,pageSize:101}));await assert.rejects(m.fetchLibraryMediaInfo(0,query));
 });
});
