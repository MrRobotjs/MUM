import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
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
 globalThis.window={location:{href:'http://mum.test/admin',origin:'http://mum.test',protocol:'http:'}};
 globalThis.WebSocket=Socket;
 const api=await loadFrontend("export * from './src/lib/scheduledTasks';export {setAccessToken} from './src/store/authStore';export {disconnectRealtimeSocket} from './src/lib/realtimeSocket';");
 api.setAccessToken('session');
 t.after(()=>{api.disconnectRealtimeSocket();globalThis.window=oldWindow;globalThis.WebSocket=oldSocket});
 return {api,sockets,event:(type='ScheduledTasksChanged',channel='system.scheduled_tasks')=>({type:'event',event:{channel,type,payload:{}}})};
}

test('task change events subscribe to the tasks channel and coalesce into one read',async t=>{
 const {api,sockets,event}=await setup(t);let reads=0;
 const stop=api.watchScheduledTasks(()=>reads++);t.after(stop);
 sockets[0].open();await delay(140);
 assert.deepEqual(sockets[0].sent,[{type:'authenticate',access_token:'session'},{type:'subscribe',channels:['system.scheduled_tasks']}]);
 assert.equal(reads,1,'connecting reads once to catch changes missed while disconnected');
 for(let i=0;i<10;i++)sockets[0].receive(event());
 await delay(140);assert.equal(reads,2);
});
test('other events and channels do not read the tasks again; disposal stops reads',async t=>{
 const {api,sockets,event}=await setup(t);let reads=0;
 const stop=api.watchScheduledTasks(()=>reads++);
 sockets[0].open();await delay(140);reads=0;
 sockets[0].receive(event('ServerHealth'));sockets[0].receive(event('ScheduledTasksChanged','system.server_health'));
 await delay(140);assert.equal(reads,0);
 sockets[0].receive(event());stop();await delay(140);assert.equal(reads,0);
});
test('progress events reach the progress handler only when well formed',async t=>{
 const {api,sockets}=await setup(t);const updates=[];let reads=0;
 const stop=api.watchScheduledTasks(()=>reads++,update=>updates.push(update));t.after(stop);
 sockets[0].open();await delay(140);reads=0;
 const progress={library:'Movies',phase:'items',done:200,total:1000,current:''};
 const send=payload=>sockets[0].receive({type:'event',event:{channel:'system.scheduled_tasks',type:'ScheduledTaskProgress',payload}});
 send({server_id:3,scope:'libraries',progress});
 send({server_id:0,scope:'libraries',progress});
 send({server_id:3,scope:'other',progress});
 send({server_id:3,scope:'libraries',progress:{...progress,phase:'unknown'}});
 send({server_id:3,scope:'libraries',progress:{...progress,done:-1}});
 await delay(140);
 assert.deepEqual(updates,[{server_id:3,scope:'libraries',progress}]);
 assert.equal(reads,0,'progress updates the list in place without a read');
});
