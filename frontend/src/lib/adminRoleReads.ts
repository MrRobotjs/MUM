import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
export type RoleCreation={available:boolean;max_position:number|null};
export type AdminPermission={id:string;name:string;description:string|null;implemented:boolean};
export type AdminRole={id:string;name:string;description:string|null;position:number;color:string|null;icon:string|null;badge_style:'default'|'fill'|'outline';is_auto_managed:boolean;permissions:AdminPermission[];user_count:number;is_protected:boolean;snapshot_revision:number;can_update:boolean;can_reorder:boolean;reorder_max_position:number|null;mutations_available:boolean;member_changes_available:boolean;member_assignment_available:boolean;can_delete:boolean};
export type AdminRoleMember={uuid:string;username:string;user_type:'owner'|'local';email:string|null;is_active:boolean;profile_revision:number;can_assign:boolean;can_remove:boolean};
type ReadMeta={actor_uuid:string;snapshot_revision:number;mutations_available:boolean};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text=(v:unknown)=>v===null||typeof v==='string';
function meta(value:unknown,actor:string):ReadMeta{
 const p=value as ReadMeta;if(!p||p.actor_uuid!==actor||!Number.isSafeInteger(p.snapshot_revision)||p.snapshot_revision<1||typeof p.mutations_available!=='boolean')throw Error('Invalid administrator read authority');
 return{actor_uuid:actor,snapshot_revision:p.snapshot_revision,mutations_available:p.mutations_available};
}
export function permissionRecord(value:unknown):AdminPermission{
 const p=value as AdminPermission;if(!p||!id(p.id)||typeof p.name!=='string'||!p.name||!text(p.description)||p.implemented!==(p.name==='administrator'))throw Error('Invalid administrator permission');
 return{id:p.id,name:p.name,description:p.description,implemented:p.implemented};
}
export function roleRecord(value:unknown,revision=0):AdminRole{
 const p=value as AdminRole;if(!p||!id(p.id)||typeof p.name!=='string'||!p.name||!Number.isSafeInteger(p.position)||p.position<0||!text(p.description)||!text(p.color)||!text(p.icon)||!['default','fill','outline'].includes(p.badge_style)||typeof p.is_auto_managed!=='boolean'||typeof p.is_protected!=='boolean'||typeof p.can_reorder!=='boolean'||(p.can_reorder?(!Number.isSafeInteger(p.reorder_max_position)||p.reorder_max_position! < p.position||p.reorder_max_position! > 1000000||p.is_protected):p.reorder_max_position!==null)||typeof p.can_update!=='boolean'||typeof p.can_delete!=='boolean'||p.is_protected&&(p.can_update||p.can_delete)||p.can_delete&&p.user_count!==0||p.can_update&&!p.member_assignment_available||p.can_delete&&!p.member_changes_available||typeof p.member_changes_available!=='boolean'||typeof p.member_assignment_available!=='boolean'||p.is_protected&&(p.member_changes_available||p.member_assignment_available)||p.member_assignment_available&&!p.member_changes_available||!Number.isSafeInteger(p.user_count)||p.user_count<0||!Array.isArray(p.permissions)||p.permissions.length>256)throw Error('Invalid administrator role');
 const permissions=p.permissions.map(permissionRecord);if(new Set(permissions.map(v=>v.id)).size!==permissions.length)throw Error('Duplicate permissions');
 return{id:p.id,name:p.name,description:p.description,position:p.position,color:p.color,icon:p.icon,badge_style:p.badge_style,is_auto_managed:p.is_auto_managed,permissions,user_count:p.user_count,is_protected:p.is_protected,snapshot_revision:revision,can_update:p.can_update,can_reorder:p.can_reorder,reorder_max_position:p.reorder_max_position,mutations_available:p.can_update,member_changes_available:p.member_changes_available,member_assignment_available:p.member_assignment_available,can_delete:p.can_delete};
}
export function roleCatalog(value:unknown,actor:string){
 const p=value as {roles:unknown[];creation:RoleCreation;reorder_available:boolean},authority=meta(value,actor);if(!Array.isArray(p.roles)||p.roles.length>1000)throw Error('Invalid role catalog');
 if(!p.creation||typeof p.creation.available!=='boolean'||(p.creation.available?(!Number.isSafeInteger(p.creation.max_position)||p.creation.max_position! < 0||p.creation.max_position! > 1000000||p.roles.length>=1000):p.creation.max_position!==null))throw Error('Invalid role creation capability');
 const roles=p.roles.map(value=>roleRecord(value,authority.snapshot_revision));if(new Set(roles.map(v=>v.id)).size!==roles.length)throw Error('Duplicate roles');if(typeof p.reorder_available!=='boolean'||p.reorder_available&&(roles.length<2||!roles.some(role=>role.can_reorder)))throw Error('Invalid reorder capability');return{...authority,roles,reorder_available:p.reorder_available,creation:{available:p.creation.available,max_position:p.creation.max_position}};
}
async function read(path:string){const token=getAccessToken();const{data}=await requestJson<{data:unknown}>(path,{retryAuthentication:false});if(!token||token!==getAccessToken())throw Error('Administrator session changed. Refresh roles.');return data;}
export async function fetchAdminRoles(actor:string){return roleCatalog(await read('/api/admin-roles'),actor);}
export async function fetchAdminPermissions(actor:string){
 const value=await read('/api/admin-permissions'),authority=meta(value,actor),items=(value as {permissions:unknown[]}).permissions;
 if(!Array.isArray(items)||items.length>256)throw Error('Invalid permission catalog');const permissions=items.map(permissionRecord);if(new Set(permissions.map(v=>v.id)).size!==permissions.length)throw Error('Duplicate permissions');return{...authority,permissions};
}
export async function fetchAdminRole(actor:string,role:string){
 if(!id(role))throw Error('Invalid role ID');const value=await read(`/api/admin-roles/${encodeURIComponent(role)}`),authority=meta(value,actor),result=roleRecord((value as {role:unknown}).role,authority.snapshot_revision);if(result.id!==role)throw Error('Role identity changed');return{...authority,role:result};
}
export async function fetchAdminRoleMembers(actor:string,role:string){
 if(!id(role))throw Error('Invalid role ID');const token=getAccessToken(),members:AdminRoleMember[]=[],seen=new Set<string>();let after:string|null=null,revision:number|null=null,total:number|null=null,capability:boolean|null=null;
 for(let page=0;page<100;page++){
  const value=await read(`/api/admin-roles/${encodeURIComponent(role)}/users${after?`?after=${encodeURIComponent(after)}`:''}`),authority=meta(value,actor),p=value as{role_id:string;total:number;next_after:string|null;members:AdminRoleMember[];member_changes_available:boolean};
  if(typeof p.member_changes_available!=='boolean'||capability!==null&&capability!==p.member_changes_available||token!==getAccessToken()||p.role_id!==role||!Number.isSafeInteger(p.total)||p.total<0||p.total>10000||!Array.isArray(p.members)||p.members.length>100||p.next_after!==null&&!uuid(p.next_after)||revision!==null&&revision!==authority.snapshot_revision||total!==null&&total!==p.total)throw Error('Role membership changed or is incomplete. Refresh.');
  revision=authority.snapshot_revision;total=p.total;capability=p.member_changes_available;
  for(const m of p.members){if(!m||!uuid(m.uuid)||typeof m.username!=='string'||!['owner','local'].includes(m.user_type)||!text(m.email)||typeof m.is_active!=='boolean'||!Number.isSafeInteger(m.profile_revision)||m.profile_revision<1||typeof m.can_remove!=='boolean'||m.can_assign!==false||m.can_remove&&(!p.member_changes_available||m.user_type!=='local'||m.uuid===actor)||seen.has(m.uuid)||after&&m.uuid<=after||members.length&&m.uuid<=members[members.length-1].uuid)throw Error('Invalid or repeated role member');seen.add(m.uuid);members.push({uuid:m.uuid,username:m.username,user_type:m.user_type,email:m.email,is_active:m.is_active,profile_revision:m.profile_revision,can_assign:false,can_remove:m.can_remove});}
  if(p.next_after===null){if(members.length!==total)throw Error('Incomplete role member catalog');return{...authority,members,role_id:role,member_changes_available:p.member_changes_available};}
  if(p.members.length!==100||p.next_after!==p.members[99].uuid||p.next_after===after)throw Error('Invalid role member cursor');after=p.next_after;
 }
 throw Error('Role member catalog exceeded its safe read limit');
}
