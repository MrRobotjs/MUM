import assert from 'node:assert/strict';
import test from 'node:test';
import {loadFrontend} from './frontendLoader.mjs';
const load=()=>loadFrontend("export * from './src/lib/memberCapacity';");
const capacity=(extra={})=>({members:96,limit:99,home_members:3,home_limit:14,state:'nearly_full',home_state:'open',...extra});

test('member capacity reader and labels',async()=>{
 const m=await load();
 const c=m.readMemberCapacity(capacity());assert.equal(m.memberCapacityLabel(c),'96/99 members');assert.equal(m.homeCapacityLabel(c),'Home 3/14');assert.equal(m.capacityTone(c.state),'text-amber-500');
 assert.equal(m.memberCapacityLabel(m.readMemberCapacity(capacity({members:99,state:'full'}))),'Full 99/99 members');
 assert.equal(m.worstCapacityState(m.readMemberCapacity(capacity({state:'open',home_state:'full'}))),'full');
 for(const bad of [null,undefined,{},capacity({members:-1}),capacity({limit:0}),capacity({state:'closed'})])assert.equal(m.readMemberCapacity(bad),null);
});

test('full server warnings for copied invite links',async()=>{
 const m=await load();const full=m.readMemberCapacity(capacity({members:99,state:'full'}));
 assert.equal(m.fullServersWarning([{server_nickname:'Jelly',member_capacity:null}]),null);
 assert.match(m.fullServersWarning([{server_nickname:'Plex++',member_capacity:full},{server_nickname:'Jelly',member_capacity:null}]),/^Plex\+\+ is full.*other servers/);
 assert.equal(m.fullServersWarning([{server_nickname:'Plex++',member_capacity:full}]),'Plex++ is full, so no one can join with this invite right now.');
 assert.match(m.fullServersWarning([{server_nickname:'A',member_capacity:full},{name:'B',member_capacity:full},{server_nickname:'C'}]),/^A and B are full/);
});

test('a full Plex Home only matters to invites into Plex Home',async()=>{
 const m=await load();const homeFull=m.readMemberCapacity(capacity({home_members:14,home_state:'full'}));
 assert.equal(m.serverIsFullForInvite({member_capacity:homeFull}),false);
 assert.equal(m.serverIsFullForInvite({member_capacity:homeFull,invite_to_plex_home:true}),true);
 assert.match(m.fullServersWarning([{server_nickname:'Plex++',member_capacity:homeFull,invite_to_plex_home:true},{server_nickname:'Jelly'}]),/^Plex Home on Plex\+\+ is full/);
});
