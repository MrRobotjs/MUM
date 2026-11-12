import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadFrontend} from './frontendLoader.mjs';
const directory=fileURLToPath(new URL('../frontend/',import.meta.url));
const actor='12345678-1234-1234-1234-123456789abc';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function setup(t){
 const oldWindow=globalThis.window,oldSocket=globalThis.WebSocket;
 const sockets=[];
 class Socket{
  static OPEN=1;readyState=0;sent=[];
  constructor(url){this.url=url;sockets.push(this)}
  send(message){this.sent.push(JSON.parse(message))}
  close(){this.readyState=3;this.onclose?.()}
  open(){this.readyState=1;this.onopen?.();this.receive({type:'authenticated'})}
  receive(message){this.onmessage?.({data:JSON.stringify(message)})}
 }
 globalThis.window={location:{href:'http://mum.test/dashboard',origin:'http://mum.test',protocol:'http:'}};
 globalThis.WebSocket=Socket;
 
 const api=await loadFrontend("export * from './src/lib/activityRealtime';export {setAccessToken} from './src/store/authStore';export {disconnectRealtimeSocket} from './src/lib/realtimeSocket';");
 api.setAccessToken('first-session');
 t.after(()=>{api.disconnectRealtimeSocket();globalThis.window=oldWindow;globalThis.WebSocket=oldSocket});
 return {api,sockets,event:(owner=actor)=>({type:'event',event:{channel:`activity.${owner}.own`,type:'ActivityInvalidated',payload:{actor_uuid:owner,scope:'own'}}})};
}

test('activity hints coalesce reads and subscribe only to the actor channel',async t=>{
 const {api,sockets,event}=await setup(t);let reads=0;
 const stop=api.watchActivity(actor,'own',()=>reads++);t.after(stop);
 sockets[0].open();for(let i=0;i<20;i++)sockets[0].receive(event());
 await delay(140);assert.equal(reads,1);
 assert.deepEqual(sockets[0].sent,[{type:'authenticate',access_token:'first-session'},{type:'subscribe',channels:[`activity.${actor}.own`]}]);
 sockets[0].receive(event());await delay(140);assert.equal(reads,2);
 assert.ok(sockets[0].sent.every(message=>['authenticate','subscribe'].includes(message.type)));
});
test('wrong recipient or scope, malformed hint and unrelated event never refresh activity',async t=>{
 const {api,sockets,event}=await setup(t);let reads=0;const stop=api.watchActivity(actor,'own',()=>reads++);t.after(stop);
 sockets[0].open();await delay(140);reads=0;
 sockets[0].receive(event('other'));
 const wrong=event();wrong.event.payload.actor_uuid='other';sockets[0].receive(wrong);
 const wrongScope=event();wrongScope.event.payload.scope='all';sockets[0].receive(wrongScope);
 const malformed=event();malformed.event.payload=null;sockets[0].receive(malformed);
 const unrelated=event();unrelated.event.type='ChatMessage';sockets[0].receive(unrelated);
 await delay(140);assert.equal(reads,0);
});
test('token rotation and disposal fence pending and late invalidations',async t=>{
 const {api,sockets,event}=await setup(t);let oldReads=0,newReads=0;
 const stop=api.watchActivity(actor,'own',()=>oldReads++);sockets[0].open();api.setAccessToken('new-session');
 await delay(140);assert.equal(oldReads,0);stop();
 const stopNew=api.watchActivity(actor,'own',()=>newReads++);t.after(stopNew);
 sockets[0].receive({type:'authenticated'});await delay(140);assert.equal(newReads,1);
 sockets[0].receive(event());stopNew();await delay(140);assert.equal(newReads,1);
});
test('reconnection refreshes missed changes without requiring an event or mutation',async t=>{
 const {api,sockets}=await setup(t);let reads=0;const stop=api.watchActivity(actor,'own',()=>reads++);t.after(stop);
 sockets[0].open();await delay(140);assert.equal(reads,1);sockets[0].close();
 await delay(1100);assert.equal(sockets.length,2);sockets[1].open();await delay(140);assert.equal(reads,2);
});
test('invalid actor and anonymous state create no subscription',async t=>{
 const {api,sockets}=await setup(t);api.watchActivity('other','own',()=>assert.fail());
 api.setAccessToken(null);api.watchActivity(actor,'own',()=>assert.fail());assert.equal(sockets.length,0);
});
