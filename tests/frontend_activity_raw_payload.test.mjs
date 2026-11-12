import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
async function load(){const r=await build({stdin:{contents:"export {readActivityDisplay} from './src/lib/activityDisplay';",resolveDir:fileURLToPath(new URL('../frontend/',import.meta.url))},bundle:true,write:false,format:'esm',platform:'browser'});return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64'));}
test('current display preserves bounded actual provider diagnostic JSON for the existing popup',async()=>{
 const {readActivityDisplay}=await load();const raw=JSON.stringify({element:'Video',children:[{element:'Media',attributes:{bitrate:'6900'}}]});
 assert.equal(readActivityDisplay({raw_data_json:raw}).raw_data_json,raw);
});
test('current display rejects malformed or oversized diagnostics',async()=>{
 const {readActivityDisplay}=await load();
 for(const raw of [null,{},'not json','[]','"text"','{"x":"'+ 'x'.repeat(8192)+'"}','{"x":"'+ 'é'.repeat(4100)+'"}'])assert.throws(()=>readActivityDisplay({raw_data_json:raw}));
});
