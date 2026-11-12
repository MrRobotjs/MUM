import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
async function load(){return loadFrontend("export * from './src/lib/editOperations';export {setAccessToken} from './src/store/authStore';");}
const receipt={id:'opaque',revision:'1',state:'prepared',action:'delete_users',results:[],summary:{updated:1,deleted:0,unchanged:0,skipped:2,failed:1,unknown:1,pending:0},warnings:[],effects:[]};
test('edit requests never retry writes; duplicate dispatch shares one request and mixed results remain truthful',async t=>{const old={fetch:globalThis.fetch,window:globalThis.window};t.after(()=>Object.assign(globalThis,old));globalThis.window={location:{origin:'http://mum.test'}};const m=await load();m.setAccessToken('one');let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:receipt});};const client=new m.EditOperationsClient();assert.deepEqual(await client.prepare(['u'],{action:'delete_users'}),receipt);await Promise.all([client.execute(receipt),client.execute(receipt)]);assert.equal(calls,2);assert.match(m.editSummary(receipt),/1 unknown/);globalThis.fetch=async()=>{calls++;return Response.json({error:{message:'Denied'}},{status:401});};await assert.rejects(client.reconcile(receipt));assert.equal(calls,3);});
test('late responses after session replacement are rejected',async()=>{globalThis.window={location:{origin:'http://mum.test'}};const m=await load();m.setAccessToken('one');let finish;globalThis.fetch=()=>new Promise(r=>{finish=r});const pending=new m.EditOperationsClient().read('opaque');m.setAccessToken('two');finish(Response.json({data:receipt}));await assert.rejects(pending,/Session changed/);});

test('uncertain execution is never replayed; status and recovery use reads only',async()=>{globalThis.window={location:{origin:'http://mum.test'}};const m=await load();m.setAccessToken('one');const client=new m.EditOperationsClient();globalThis.fetch=async()=>Response.json({data:receipt});await client.prepare(['u'],{action:'delete_users'});let writes=0;globalThis.fetch=async request=>{if(request.method==='POST'){writes++;throw Error('response lost');}assert.equal(request.method,'GET');return Response.json({data:{...receipt,state:'needs_review'}});};await assert.rejects(client.execute(receipt));await assert.rejects(client.execute(receipt));assert.equal(writes,1);assert.equal((await client.read('opaque')).state,'needs_review');await assert.rejects(new m.EditOperationsClient().execute(receipt),/recovered/);m.setAccessToken('two');await assert.rejects(client.execute(receipt),/Session changed/);assert.equal(writes,1);});
test('persisted recovery contains only opaque IDs separated by actor',async()=>{const m=await load();const data=new Map();globalThis.localStorage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};m.saveEditIds('actor-one',['opaque']);assert.deepEqual(m.savedEditIds('actor-one'),['opaque']);assert.deepEqual(m.savedEditIds('actor-two'),[]);assert.equal([...data.values()][0],'["opaque"]');delete globalThis.localStorage;});

test('receipt routes avoid user subresource collisions and preserve partial recovery',async()=>{globalThis.window={location:{origin:'http://mum.test'}};const m=await load();m.setAccessToken('one');const paths=[];globalThis.fetch=async request=>{const path=new URL(request.url).pathname;paths.push(path);if(path==='/api/edit-operations/missing')throw Error('temporarily unavailable');return Response.json({data:receipt});};const client=new m.EditOperationsClient();const result=await m.readEditReceipts(client,['opaque','missing']);assert.deepEqual(result.receipts,[receipt]);assert.deepEqual(result.missing,['missing']);assert.match(result.errors[0],/temporarily unavailable/);assert.deepEqual(paths,['/api/edit-operations/opaque','/api/edit-operations/missing']);await client.prepare(['u'],{action:'delete_users'});await client.execute(receipt);await client.reconcile(receipt);assert.ok(paths.includes('/api/users/edit/prepare'));assert.ok(paths.includes('/api/edit-operations/opaque/execute'));assert.ok(paths.includes('/api/edit-operations/opaque/reconcile'));});

test('definitive failed review can finish without treating failure as success; uncertain or unread status cannot',async()=>{const m=await load();const failed={...receipt,state:'needs_review',summary:{updated:0,deleted:0,unchanged:0,skipped:0,failed:1,unknown:0,pending:0},results:[{uuid:'u',outcome:'failed',reason:'stale_revision'}]};assert.equal(m.canFinishEditReview([failed]),true);assert.match(m.editSummary(failed),/1 failed/);for(const unresolved of [{...failed,state:'running'},{...failed,summary:{...failed.summary,unknown:1}},{...failed,summary:{...failed.summary,pending:1}},{...failed,results:[{uuid:'u',outcome:'unknown',reason:'response_lost'}]}])assert.equal(m.canFinishEditReview([unresolved]),false);assert.equal(m.canFinishEditReview([failed],['unread']),false);assert.equal(m.canFinishEditReview([failed],[],true),false);assert.equal(m.canFinishEditReview([failed],[],false,'Status unavailable'),false);assert.equal(m.canFinishEditReview([]),false);});

test('mixed group review can discard never-executed preparations after definitive outcomes',async()=>{
 const m=await load();
 const done={...receipt,state:'completed',summary:{updated:1,deleted:0,unchanged:0,skipped:0,failed:0,unknown:0,pending:0},results:[{uuid:'first',outcome:'updated',reason:''}]};
 const notStarted={...done,id:'not-started',state:'prepared',summary:{...done.summary,updated:0,pending:1},results:[{uuid:'second',outcome:'pending',reason:''}]};
 assert.equal(m.canFinishEditReview([done,notStarted]),true);
 assert.equal(m.canFinishEditReview([done,{...notStarted,state:'running'}]),false);
});

test("library edits send each checked library's server ID, never MUM's row number",async()=>{
 const m=await load();
 // Plex section keys are small numbers: row 2 is the library Plex calls 7, and
 // row 7 is a different library Plex calls 2.
 const libraries=[{id:2,external_id:'7',internal_id:null,name:'Movies'},{id:7,external_id:'2',internal_id:null,name:'Shows'},{id:9,external_id:'4',internal_id:null,name:'Music'}];
 assert.deepEqual(m.editLibraryExternalIds(libraries,{'2':true,'7':false,'9':true}),['7','4']);
 assert.deepEqual(m.editLibraryExternalIds(libraries,{'2':false,'7':false,'9':false}),[]);
 assert.throws(()=>m.editLibraryExternalIds(libraries,{'5':true}),/no longer available/);
 assert.throws(()=>m.editLibraryExternalIds([{id:3,external_id:'',internal_id:null,name:'Broken'}],{'3':true}),/server ID/);
});