import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
async function load(){
 return loadFrontend("export {useLiveStreams} from './src/hooks/useLiveStreams';export {StreamingPage} from './src/pages/StreamingPage';",{mock:{filter:/^(react(?:\/jsx-runtime)?|swr)$|contexts\/AuthContext$|store\/authStore$|lib\/(realtimeSocket|activityRealtime|liveStreams)$|hooks\/usePlaybackClock$|components\/(dashboard|streaming|ui)\/|^\.\.\/components$/,module:path=>(a=>{
  const p=a.path;if(p==='react/jsx-runtime')return{contents:'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;'};
  if(p==='react')return{contents:'export const useState=v=>[typeof v==="function"?v():v,()=>{}];export const useSyncExternalStore=(s,r)=>r();export const useEffect=f=>f();'};
  if(p==='swr')return{contents:'export default (key,fetcher,options)=>{globalThis.streamTransport.options=options;return globalThis.streamTransport.swr;};'};
  if(p.endsWith('AuthContext'))return{contents:'export const useAuth=()=>({user:{uuid:"actor"},isAdministrator:true});'};
  if(p.endsWith('authStore'))return{contents:'export const getAccessToken=()=>globalThis.streamTransport.token;export const getAuthSnapshot=()=>({accessToken:globalThis.streamTransport.token});export const subscribeToAuthStore=()=>()=>{};'};
  if(p.endsWith('realtimeSocket'))return{contents:'export const getRealtimeState=()=>({connected:globalThis.streamTransport.connected});export const onConnectionChange=()=>()=>{};'};
  if(p.endsWith('activityRealtime'))return{contents:'export const watchActivity=(actor,scope,refresh)=>{globalThis.streamTransport.invalidate=refresh;return()=>{};};'};
  if(p.endsWith('usePlaybackClock'))return{contents:'export const usePlaybackClock=data=>data;'};
  if(p.endsWith('liveStreams'))return{contents:'export const fetchLiveStreams=async()=>globalThis.streamTransport.data;export const readStreamDisplayDefaults=()=>({default_card_style:"detailed",default_grouping:"merged"});'};
  const names=p.endsWith('/card')?['Card','CardContent','CardDescription','CardHeader','CardTitle']:p==='../components'?['PageHeader']:p.endsWith('/button')?['Button']:[p.split('/').at(-1)];return{contents:names.map(n=>`export const ${n}=${JSON.stringify(n)};`).join('')};
 })({path}).contents}});
}
function walk(n){return [n,...(Array.isArray(n?.props?.children)?n.props.children:[n?.props?.children]).filter(Boolean).flatMap(walk)];}
test('live stream browser polling and countdown follow realtime availability',async t=>{
 const old=globalThis.streamTransport;t.after(()=>{globalThis.streamTransport=old;});let refreshes=0;
 const data={read_at:'2026-11-06T12:00:00Z',sessions:[{source:'ws'}],total_count:1,unavailable_sources:[]};
 globalThis.streamTransport={token:'token',connected:true,data,swr:{data:{data,token:'token'},mutate:async()=>{refreshes++;},isLoading:false,error:null}};
 const m=await load();m.useLiveStreams();assert.equal(globalThis.streamTransport.options.refreshInterval,0,'healthy realtime must not keep a five-second polling timer');
 let card=walk(m.StreamingPage()).find(n=>n.type==='ActiveStreamsCard');assert.equal(card.props.lastHttpUpdateAt,null);assert.equal(card.props.sessionMonitoringInterval,null);assert.equal(card.props.wsTruthActive,true);
 globalThis.streamTransport.invalidate();await Promise.resolve();assert.equal(refreshes,1,'socket invalidation still refreshes the authorized snapshot');
 globalThis.streamTransport.connected=false;m.useLiveStreams();assert.equal(globalThis.streamTransport.options.refreshInterval,5000);card=walk(m.StreamingPage()).find(n=>n.type==='ActiveStreamsCard');assert.equal(card.props.lastHttpUpdateAt.getTime(),Date.parse(data.read_at));assert.equal(card.props.sessionMonitoringInterval,5);assert.equal(card.props.wsTruthActive,false);
 globalThis.streamTransport.connected=true;card=walk(m.StreamingPage()).find(n=>n.type==='ActiveStreamsCard');assert.equal(card.props.lastHttpUpdateAt,null);assert.equal(globalThis.streamTransport.options.refreshInterval,0);
 globalThis.streamTransport.token='replacement';const hook=m.useLiveStreams();assert.equal(hook.data,undefined,'old-session snapshots must remain fenced');
});
