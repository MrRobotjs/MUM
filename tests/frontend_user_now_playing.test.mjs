import assert from 'node:assert/strict';import test from 'node:test';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
async function load(){return loadFrontend("export * from './src/lib/userNowPlaying';")}
const at='2026-11-06T12:00:00Z',later='2026-11-06T12:05:00Z';
const service='11111111-1111-1111-1111-111111111111',local='22222222-2222-2222-2222-222222222222',other='33333333-3333-3333-3333-333333333333';
const row=(o={})=>({id:'1',server_id:'1',service_uuid:service,item_id:'i',media_type:'track',title:"We Don't Talk Anymore",first_observed_at:at,last_observed_at:at,ended_observation_at:null,end_reason:null,paused:false,position_ticks:null,duration_ticks:null,...o});
const status=(o={})=>({server_id:'1',provider:'plex',observed_at:at,age_seconds:0,freshness:'fresh',pending:'none',last_result:'fresh',...o});
const page=(items,servers=[status()])=>({actor_uuid:local,scope:'all',read_at:at,items,servers,next_before:null});
const users=[{uuid:service,user_type:'service',server_id:1,server_nickname:'Plex++'},{uuid:local,user_type:'local'},{uuid:other,user_type:'service',server_id:1,server_nickname:'Plex++'}];

test('user cards show live playback from fresh current observations',async t=>{
 const a=await load();
 await t.test('a service account sees its own session with server name and state',()=>{
  const m=a.userNowPlaying(page([row({display:{state:'playing'}})]),users);
  assert.deepEqual(m.get(service),{state:'playing',mediaTitle:"We Don't Talk Anymore",serviceType:'plex',serverName:'Plex++',sessionCount:1});
  assert.equal(m.has(other),false);
 });
 await t.test('a linked local account sees sessions of the services it owns',()=>{
  const m=a.userNowPlaying(page([row({owner_uuid:local,display:{state:'paused'}})]),users);
  assert.equal(m.get(local).state,'paused');assert.equal(m.get(local).serverName,null);
 });
 await t.test('without a display state the paused flag decides',()=>{
  assert.equal(a.userNowPlaying(page([row({paused:true})]),users).get(service).state,'paused');
  assert.equal(a.userNowPlaying(page([row()]),users).get(service).state,'playing');
 });
 await t.test('several sessions prefer active playback, then the most recent, and are counted',()=>{
  const m=a.userNowPlaying(page([row({id:'1',title:'Paused one',paused:true,last_observed_at:later}),row({id:'2',title:'Playing one',display:{state:'playing'}})]),users);
  assert.equal(m.get(service).mediaTitle,'Playing one');assert.equal(m.get(service).sessionCount,2);
 });
 await t.test('stale, failed or unknown server data never claims playback',()=>{
  for(const freshness of ['stale','failed','invalidated','disabled','never'])assert.equal(a.userNowPlaying(page([row()],[status({freshness})]),users).size,0);
  assert.equal(a.userNowPlaying(page([row()],[]),users).size,0);
 });
 await t.test('ended observations and missing pages show nothing',()=>{
  assert.equal(a.userNowPlaying(page([row({ended_observation_at:later,end_reason:'not_observed'})]),users).size,0);
  assert.equal(a.userNowPlaying(undefined,users).size,0);
 });
});
