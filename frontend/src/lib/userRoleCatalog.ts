import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {validUserRoleName} from './humanUserRoles';
export type UserRoleValues={name:string;description:string|null;color:string|null;icon:string|null;badge_style:'default'|'fill'|'outline'};
export type UserRole=Readonly<UserRoleValues&{id:string;position:number;is_auto_managed:boolean;user_count:number;can_update:boolean;can_delete:boolean;created_at:null;updated_at:null}>;
export type UserRoleCatalog=Readonly<{actor_uuid:string;catalog_revision:string;role_revision:string;link_revision:string;can_create:boolean;can_reorder:boolean;roles:readonly UserRole[]}>;
export type UserRolePosition={id:string;position:number};
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const roleID=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
export function roleCatalogValues(v:UserRoleValues):UserRoleValues {
 if(!v||!validUserRoleName(v.name)||v.description!==null&&(typeof v.description!=='string'||new TextEncoder().encode(v.description).length>4000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v.description))||v.color!==null&&(typeof v.color!=='string'||!/^#[0-9a-f]{6}$/i.test(v.color))||v.icon!==null&&(typeof v.icon!=='string'||!/^[A-Za-z0-9 _-]{0,128}$/.test(v.icon))||typeof v.badge_style!=='string'||!['default','fill','outline'].includes(v.badge_style))throw Error('Provide complete valid role name, description and visual fields.');
 return {name:v.name,description:v.description,color:v.color,icon:v.icon,badge_style:v.badge_style};
}
const tokens=new WeakMap<UserRoleCatalog,string>(),attempted=new WeakSet<UserRoleCatalog>(),pending=new Set<string>(),blocked=new Map<string,string>();
const listeners=new Set<()=>void>();let status=0;
export const subscribeRoleCatalog=(callback:()=>void)=>{listeners.add(callback);return()=>{listeners.delete(callback)}};
export const roleCatalogStatus=()=>status;
const changed=()=>{status++;for(const callback of listeners)callback()};
export const roleCatalogBusy=(actor:string)=>pending.has(actor);
export const roleCatalogNeedsRead=(actor:string)=>!!getAccessToken()&&blocked.get(actor)===getAccessToken();
function project(p:UserRoleCatalog,actor:string):UserRoleCatalog {
 if(!p||p.actor_uuid!==actor||!revision(p.catalog_revision)||!revision(p.role_revision)||!revision(p.link_revision)||typeof p.can_create!=='boolean'||typeof p.can_reorder!=='boolean'||!Array.isArray(p.roles)||p.roles.length>1000)throw Error('Role catalog is unavailable. Read again.');
 const ids=new Set<string>(),names=new Set<string>();const roles=p.roles.map(r=>{
  if(!r||!roleID(r.id)||ids.has(r.id)||names.has(r.name)||!Number.isSafeInteger(r.position)||r.position<0||r.position>1000000||typeof r.is_auto_managed!=='boolean'||!Number.isSafeInteger(r.user_count)||r.user_count<0||typeof r.can_update!=='boolean'||typeof r.can_delete!=='boolean'||r.is_auto_managed&&r.can_delete||r.can_delete&&(!r.can_update||r.user_count!==0))throw Error('Invalid role metadata or capabilities');
  const values=roleCatalogValues(r);ids.add(r.id);names.add(r.name);return Object.freeze({...values,id:r.id,position:r.position,is_auto_managed:r.is_auto_managed,user_count:r.user_count,can_update:r.can_update,can_delete:r.can_delete,created_at:null,updated_at:null});
 });
 // Automatic roles cannot be edited but can be moved, as the server allows.
 if(p.can_reorder&&(roles.length<2||roles.some(r=>!r.can_update&&!r.is_auto_managed)))throw Error('Invalid role ordering capability');
 return Object.freeze({actor_uuid:actor,catalog_revision:p.catalog_revision,role_revision:p.role_revision,link_revision:p.link_revision,can_create:p.can_create,can_reorder:p.can_reorder,roles:Object.freeze(roles)});
}
export async function readUserRoleCatalog(actor:string,reconcile=false):Promise<UserRoleCatalog>{
 const token=getAccessToken();if(!token||!uuid(actor))throw Error('Select a current administrator.');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const {data}=await requestJson<{data:UserRoleCatalog}>('/api/user-role-catalog',{signal:abort.signal,retryAuthentication:false});if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor);tokens.set(p,token);if(reconcile&&blocked.get(actor)===token){blocked.delete(actor);changed()}return p;}finally{clearTimeout(timer)}
}
export class UserRoleCatalogWriteError extends Error {
 constructor(public uncertain:boolean){super(uncertain?'The role outcome is unknown. Read saved roles before another change.':'The role change was rejected. Read saved roles before another change.')}
}
export async function changeUserRoleCatalog(base:UserRoleCatalog,operation:'create'|'update'|'delete'|'reorder',roleId?:string,values?:UserRoleValues,positions?:UserRolePosition[]){
 const actor=base.actor_uuid,token=tokens.get(base);if(!token||token!==getAccessToken()||attempted.has(base)||pending.has(actor)||roleCatalogNeedsRead(actor))throw Error('Read saved roles before another change.');
 const role=base.roles.find(r=>r.id===roleId);let payload:Record<string,unknown>={expected_actor_uuid:actor,catalog_revision:base.catalog_revision,role_revision:base.role_revision,link_revision:base.link_revision,operation,acknowledge_visual_only:true};
 if(operation==='create'){if(!base.can_create||!values)throw Error('Role creation unavailable');payload.role=roleCatalogValues(values)}
 else if(operation==='update'){if(!role?.can_update||!values)throw Error('Role update unavailable');payload.role_id=role.id;payload.role=roleCatalogValues(values);if(JSON.stringify(payload.role)===JSON.stringify(roleCatalogValues(role)))throw Error('Change at least one role field.')}
 else if(operation==='delete'){if(!role?.can_delete)throw Error('Remove all assignments before deleting an unprotected manual role.');payload.role_id=role.id;payload.acknowledge_delete=true}
 else if(operation==='reorder'){if(!base.can_reorder||!positions||positions.length!==base.roles.length||new Set(positions.map(p=>p.id)).size!==positions.length||new Set(positions.map(p=>p.position)).size!==positions.length||positions.some(p=>!base.roles.some(r=>r.id===p.id)||!Number.isSafeInteger(p.position)||p.position<0||p.position>1000000)||positions.every(p=>base.roles.find(r=>r.id===p.id)?.position===p.position))throw Error('Provide one complete changed order for a manageable manual catalog.');payload.positions=positions.map(p=>({...p}))}
 else throw Error('Invalid role operation');
 attempted.add(base);pending.add(actor);changed();const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);let dispatched=false;
 try{
  const fresh=await readUserRoleCatalog(actor);
  if(abort.signal.aborted||token!==getAccessToken()||fresh.catalog_revision!==base.catalog_revision||fresh.role_revision!==base.role_revision||fresh.link_revision!==base.link_revision)throw Error('Saved roles or authority changed.');
  const target=roleId?fresh.roles.find(r=>r.id===roleId):undefined;
  if(operation==='create'&&!fresh.can_create||operation==='update'&&!target?.can_update||operation==='delete'&&!target?.can_delete||operation==='reorder'&&!fresh.can_reorder)throw Error('Role authority changed.');
  dispatched=true;const {data:p}=await requestJson<{data:{actor_uuid:string;operation:string;role_id:string;catalog_revision:string;role_revision:string;link_revision:string}}>('/api/user-role-catalog/changes',{method:'POST',signal:abort.signal,retryAuthentication:false,body:JSON.stringify(payload)});
  const expectedAdvance=operation==='reorder'?positions!.filter(p=>base.roles.find(r=>r.id===p.id)?.position!==p.position).length:1;
  if(abort.signal.aborted||token!==getAccessToken()||!p||p.actor_uuid!==actor||p.operation!==operation||p.role_id!==(operation==='create'?p.role_id:roleId??'')||operation==='create'&&(!uuid(p.role_id)||base.roles.some(r=>r.id===p.role_id))||!revision(p.catalog_revision)||BigInt(p.catalog_revision)!==BigInt(base.catalog_revision)+BigInt(expectedAdvance)||p.role_revision!==base.role_revision||p.link_revision!==base.link_revision)throw Error('Invalid committed role receipt');
  return Object.freeze({actor_uuid:p.actor_uuid,operation:p.operation,role_id:p.role_id,catalog_revision:p.catalog_revision,role_revision:p.role_revision,link_revision:p.link_revision});
 }catch(error){if(token===getAccessToken())blocked.set(actor,token);throw new UserRoleCatalogWriteError(dispatched&&!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)))}finally{clearTimeout(timer);pending.delete(actor);changed()}
}

export function userListRoleFilter(selection:string){
 if(!selection)return null;const match=/^(admin|user):([A-Za-z0-9_-]{1,128})$/.exec(selection);
 if(!match)throw Error('Select an explicit administrator or visual role.');
 return {parameter:match[1]==='admin'?'admin_role_id':'user_role_id',id:match[2]};
}
