import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';

test('provider socket status and subscription descriptions are truthful',async()=>{
 const m=await loadFrontend("export * from './src/lib/providerSocketDetails'");
 const task={provider:'plex',state:'scheduled',socket_state:'connected',socket_enabled:true};
 assert.equal(m.socketMonitoringStatus(task),'Active · WebSocket');
 assert.equal(m.socketMonitoringStatus({...task,socket_state:'backoff'}),'Reconnecting');
 assert.equal(m.socketMonitoringStatus({...task,socket_enabled:false,socket_state:'disabled'}),'HTTP fallback');
 assert.equal(m.socketMonitoringStatus({...task,state:'stopped'}),'Stopped');
 assert.equal(m.isSocketConnected(task),true);
 assert.equal(m.isSocketConnected({...task,socket_state:'backoff'}),false);
 assert.equal(m.isSocketConnected({...task,state:'stopped'}),false);
 assert.equal(m.scheduledTaskState('scheduled'),'active');
 assert.equal(m.scheduledTaskState('running'),'active');
 assert.equal(m.scheduledTaskState('paused'),'inactive');
 assert.equal(m.scheduledTaskState('disabled'),'inactive');
 assert.equal(m.scheduledTaskState('recovering'),'unavailable');
 assert.equal(m.scheduledTaskState('unexpected'),'unavailable');
 assert.match(m.providerSocketSubscriptions(task).subscription,/does not use a separate channel/);
 assert.ok(m.providerSocketSubscriptions(task).events.includes('playing'));
 assert.match(m.providerSocketSubscriptions({...task,provider:'jellyfin'}).subscription,/SessionsStart/);
 assert.ok(m.providerSocketSubscriptions({...task,provider:'emby'}).events.includes('Sessions'));
});
