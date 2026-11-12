import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {build}=createRequire(new URL('../frontend/package.json',import.meta.url))('esbuild');
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
const actor='12345678-1234-1234-1234-123456789abc';

async function load(){
 const result=await build({stdin:{contents:"export {StreamingPage} from './src/pages/StreamingPage';export {StreamingSettingsModal} from './src/components/dashboard/StreamingSettingsModal';export * from './src/lib/accountPreferences';export * from './src/lib/activityMonitoring';export {setAccessToken} from './src/store/authStore';",resolveDir:directory},bundle:true,write:false,format:'esm',platform:'browser',jsx:'automatic',plugins:[{name:'streaming-view-boundaries',setup(b){
  b.onResolve({filter:/^(react(?:\/jsx-runtime)?)$|contexts\/AuthContext$|components\/ui\/card$|\/ui\/(button|responsive-dialog)$|UserPreferencesCard$|ActivityMonitoringSettings$|StreamingMapSettings$|StreamingSummaryCard$|CurrentActivityObservations$|StreamingHistoryFilters$|ActiveStreamsCard$|StreamingSessionsMap$|useLiveStreams$|usePlaybackClock$|^\.\.\/components$/},args=>({path:args.path,namespace:'view-test'}));
  b.onLoad({filter:/.*/,namespace:'view-test'},args=>{
   const p=args.path;
   if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment="fragment";'};
   if(p==='react')return{contents:'export const useSyncExternalStore=(subscribe,read)=>read();export const useState=()=>[globalThis.streamingView.open,value=>{globalThis.streamingView.open=value}];'};
   if(p.endsWith('usePlaybackClock'))return{contents:'export const usePlaybackClock=data=>data;'};
   if(p.endsWith('useLiveStreams'))return{contents:'export const useLiveStreams=()=>({data:undefined,loading:false,error:null,refresh:async()=>{}});'};
   if(p.endsWith('AuthContext'))return{contents:'export const useAuth=()=>globalThis.streamingView.auth;'};
   const names=p.endsWith('/card')?['Card','CardContent','CardDescription','CardHeader','CardTitle']:p.endsWith('/button')?['Button']:p.endsWith('/responsive-dialog')?['ResponsiveDialog']:p==='../components'?['PageHeader']:[p.split('/').at(-1)];
   return{contents:names.map(name=>`export const ${name}=${JSON.stringify(name)};`).join('')};
  });
 }}]});
 return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${Math.random()}`);
}
function children(node){return [node,...(Array.isArray(node?.props?.children)?node.props.children:[node?.props?.children]).filter(Boolean).flatMap(child=>children(child))];}

test('streaming settings entry and independent current operations',async t=>{
 const old={window:globalThis.window,fetch:globalThis.fetch,streamingView:globalThis.streamingView};t.after(()=>Object.assign(globalThis,old));
 const setup=async()=>{globalThis.streamingView={open:false,auth:{user:{uuid:actor},isAdministrator:true}};const values=new Map();globalThis.window={location:{origin:'http://mum.test'},localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}};const m=await load();m.setAccessToken('session');return m;};
 await t.test('closed and signed-out dialogs expose no preference or monitoring controls',async()=>{
  const m=await setup();assert.equal(m.StreamingSettingsModal({open:false,onClose(){}}),null);m.setAccessToken(null);assert.equal(m.StreamingSettingsModal({open:true,onClose(){}}),null);
 });
 await t.test('session and authority changes replace drafts; regular users have no monitoring controls',async()=>{
  const m=await setup();const render=()=>m.StreamingSettingsModal({open:true,onClose(){}});const first=render();assert.ok(children(first).some(n=>n.type==='ActivityMonitoringSettings'));assert.ok(children(first).some(n=>n.type==='StreamingMapSettings'));
  m.setAccessToken('replacement');assert.notEqual(render().key,first.key);globalThis.streamingView.auth.isAdministrator=false;const regular=render();assert.ok(children(regular).some(n=>n.type==='UserPreferencesCard'));assert.equal(children(regular).some(n=>n.type==='ActivityMonitoringSettings'),false);assert.equal(children(regular).some(n=>n.type==='StreamingMapSettings'),false);
 });
 await t.test('Streams mounts the original active cards and map rather than replacement panels',async()=>{const m=await setup();const page=m.StreamingPage();assert.ok(children(page).some(n=>n.type==='ActiveStreamsCard'));assert.ok(children(page).some(n=>n.type==='StreamingSessionsMap'));assert.equal(children(page).some(n=>n.type==='CurrentActivityObservations'),false);});
 await t.test('Streams page action opens the dialog and its close callback resets visibility',async()=>{
  const m=await setup();let page=m.StreamingPage();const header=children(page).find(n=>n.type==='PageHeader');header.props.actions.props.onClick();page=m.StreamingPage();const dialog=children(page).find(n=>n.type===m.StreamingSettingsModal);assert.equal(dialog.props.open,true);dialog.props.onClose();assert.equal(globalThis.streamingView.open,false);
 });
 await t.test('lost monitoring response preserves a separately saved preference and never invokes the old global endpoint',async()=>{
  const m=await setup();let preference={user_uuid:actor,profile_revision:1,sync_enabled:false,preferences:{stream_counter:false}};const task={server_id:'1',server_name:'Fixture',provider:'jellyfin',revision:1,server_revision:0,enabled:false,socket_enabled:false,socket_state:'disabled',socket_error:'',interval_seconds:30,state:'disabled',next_run_at:null,started_at:null,finished_at:null,last_code:'NEVER_RUN',attempts:0};const snapshot={actor_uuid:actor,configuration_available:true,runtime_available:true,checkpoint_error:false,tasks:[task]};let preferenceWrites=0,monitorWrites=0;
  globalThis.fetch=async r=>{const path=new URL(r.url).pathname;
   if(path==='/api/account/preferences'){if(r.method==='PUT'){preferenceWrites++;const body=await r.json();preference={...preference,profile_revision:2,sync_enabled:body.sync_enabled,preferences:body.preferences};}return Response.json({data:preference});}
   if(path==='/api/settings/activity-monitoring')return Response.json({data:snapshot});
   assert.equal(path,'/api/settings/activity-monitoring/1');assert.equal(r.method,'PUT');monitorWrites++;throw Error('lost after commit');
  };
  await m.saveOwnPreferences(preference,true,true);
  await assert.rejects(m.configureActivityMonitoring(snapshot,task,true,30,true),/No request was replayed/);
  const fresh=await m.fetchOwnPreferences(actor);assert.equal(fresh.preferences.stream_counter,true);assert.equal(fresh.sync_enabled,true);assert.equal(preferenceWrites,1);assert.equal(monitorWrites,1);
 });
});
