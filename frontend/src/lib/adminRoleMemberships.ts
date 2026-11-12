import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {roleCatalog,type AdminRoleMember} from './adminRoleReads';
import {admitRoleChange,releaseRoleChange,refreshRoleViews} from './adminRoleChanges';

export type RoleTarget={user_uuid:string;profile_revision:number};
export type MembershipSnapshot={actor_uuid:string;role_id:string;snapshot_revision:number;member_changes_available:boolean};
export type CandidateSnapshot=MembershipSnapshot&{candidates:AdminRoleMember[]};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export async function fetchAdminRoleCandidates(actor:string,role:string):Promise<CandidateSnapshot>{
 if(!uuid(actor)||!/^[A-Za-z0-9_-]{1,128}$/.test(role))throw Error('Invalid owner or role');
 const token=getAccessToken(),candidates:AdminRoleMember[]=[],seen=new Set<string>();let after:string|null=null,revision:number|null=null,total:number|null=null;
 for(let page=0;page<100;page++){
  const{data:p}=await requestJson<{data:MembershipSnapshot&{total:number;next_after:string|null;candidates:AdminRoleMember[]}}>(`/api/admin-roles/${encodeURIComponent(role)}/candidates${after?`?after=${after}`:''}`,{retryAuthentication:false});
  if(!token||token!==getAccessToken()||!p||p.actor_uuid!==actor||p.role_id!==role||p.member_changes_available!==true||!Number.isSafeInteger(p.snapshot_revision)||p.snapshot_revision<1||revision!==null&&revision!==p.snapshot_revision||!Number.isSafeInteger(p.total)||p.total<0||p.total>10000||total!==null&&total!==p.total||!Array.isArray(p.candidates)||p.candidates.length>100||p.next_after!==null&&!uuid(p.next_after))throw Error('Candidate accounts changed or are incomplete. Refresh.');
  revision=p.snapshot_revision;total=p.total;
  for(const c of p.candidates){if(!c||!uuid(c.uuid)||c.user_type!=='local'||c.is_active!==true||typeof c.username!=='string'||!c.username||c.email!==null&&typeof c.email!=='string'||!Number.isSafeInteger(c.profile_revision)||c.profile_revision<1||c.can_assign!==true||c.can_remove!==false||c.uuid===actor||seen.has(c.uuid)||after&&c.uuid<=after||candidates.length&&c.uuid<=candidates[candidates.length-1].uuid)throw Error('Invalid or repeated candidate');seen.add(c.uuid);candidates.push({uuid:c.uuid,username:c.username,user_type:c.user_type,email:c.email,is_active:c.is_active,profile_revision:c.profile_revision,can_assign:true,can_remove:false});}
  if(p.next_after===null){if(candidates.length!==total)throw Error('Incomplete candidate accounts');return{actor_uuid:actor,role_id:role,snapshot_revision:p.snapshot_revision,member_changes_available:true,candidates};}
  if(p.candidates.length!==100||p.next_after!==p.candidates[99].uuid||p.next_after===after)throw Error('Invalid candidate cursor');after=p.next_after;
 }
 throw Error('Candidate list exceeds its complete-read limit');
}

export function membershipTargets(source:AdminRoleMember[],selected:string[],operation:'assign'|'remove'):RoleTarget[]{
 if(!selected.length||selected.length>100||new Set(selected).size!==selected.length)throw Error('Select 1–100 distinct local accounts.');
 return selected.map(id=>{const user=source.find(u=>u.uuid===id);if(!user||!uuid(user.uuid)||user.user_type!=='local'||!Number.isSafeInteger(user.profile_revision)||user.profile_revision<1||operation==='assign'&&(!user.is_active||user.can_assign!==true)||operation==='remove'&&user.can_remove!==true)throw Error('Refresh the selected target accounts.');return{user_uuid:user.uuid,profile_revision:user.profile_revision};});
}

export async function changeAdminRoleMembership(base:MembershipSnapshot,operation:'assign'|'remove',targets:RoleTarget[]){
 if(!base.member_changes_available||!uuid(base.actor_uuid)||!Number.isSafeInteger(base.snapshot_revision)||base.snapshot_revision<1||!/^[A-Za-z0-9_-]{1,128}$/.test(base.role_id)||!['assign','remove'].includes(operation)||!targets.length||targets.length>100||new Set(targets.map(t=>t.user_uuid)).size!==targets.length||targets.some(t=>!uuid(t.user_uuid)||t.user_uuid===base.actor_uuid||!Number.isSafeInteger(t.profile_revision)||t.profile_revision<1))throw Error('Refresh owner membership settings and exact target revisions.');
 const selected=targets.map(t=>({...t}));admitRoleChange(base.actor_uuid);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),token=getAccessToken();
 try{
  const{data}=await requestJson<{data:unknown}>('/api/admin-roles',{signal:abort.signal,retryAuthentication:false});const current=roleCatalog(data,base.actor_uuid),role=current.roles.find(r=>r.id===base.role_id);
  if(!token||token!==getAccessToken()||abort.signal.aborted||current.snapshot_revision!==base.snapshot_revision||!role?.member_changes_available||operation==='assign'&&!role.member_assignment_available||role.is_protected)throw Error('Owner, role or catalog changed');
  const{data:result}=await requestJson<{data:{actor_uuid:string;role_id:string;snapshot_revision:number;operation:string;targets:RoleTarget[]}}>(`/api/admin-roles/${encodeURIComponent(base.role_id)}/memberships`,{method:'POST',signal:abort.signal,retryAuthentication:false,body:JSON.stringify({expected_actor_uuid:base.actor_uuid,snapshot_revision:base.snapshot_revision,operation,targets:selected,acknowledge_permission_change:true})});
  if(token!==getAccessToken()||abort.signal.aborted||result?.actor_uuid!==base.actor_uuid||result.role_id!==base.role_id||result.operation!==operation||!Number.isSafeInteger(result.snapshot_revision)||result.snapshot_revision<=base.snapshot_revision||!Array.isArray(result.targets)||result.targets.length!==selected.length||result.targets.some((t,i)=>t.user_uuid!==selected[i].user_uuid||t.profile_revision!==selected[i].profile_revision))throw Error('Unconfirmed membership result');
  refreshRoleViews(base.actor_uuid);return result;
 }catch{if(token===getAccessToken())refreshRoleViews(base.actor_uuid);throw Error('Membership change could not be confirmed. Refresh and inspect the role before another attempt. No request was replayed.');}
 finally{clearTimeout(timer);releaseRoleChange(base.actor_uuid);}
}
