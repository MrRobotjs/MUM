import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
async function load(){return loadFrontend("export {readActivityDisplay} from './src/lib/activityDisplay';");}
test('current display preserves bounded actual provider diagnostic JSON for the existing popup',async()=>{
 const {readActivityDisplay}=await load();const raw=JSON.stringify({element:'Video',children:[{element:'Media',attributes:{bitrate:'6900'}}]});
 assert.equal(readActivityDisplay({raw_data_json:raw}).raw_data_json,raw);
});
test('current display rejects malformed or oversized diagnostics',async()=>{
 const {readActivityDisplay}=await load();
 for(const raw of [null,{},'not json','[]','"text"','{"x":"'+ 'x'.repeat(8192)+'"}','{"x":"'+ 'é'.repeat(4100)+'"}'])assert.throws(()=>readActivityDisplay({raw_data_json:raw}));
});
