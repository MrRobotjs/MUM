import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {validUserRoleName} from './humanUserRoles';
export type UserRoleIdentity=Readonly<{uuid:string;user_type:'owner'|'local'|'service';username:string;service_type:string;server_nickname:string;primary_owner_uuid:string|null;is_member:boolean;can_change:boolean;availability:'available'|'automatic'|'protected_owner'|'pending_work'}>;
export type UserRoleMembers=Readonly<{actor_uuid:string;role_id:string;role_name:string;is_auto_managed:boolean;catalog_revision:string;role_revision:string;link_revision:string;selector_revision:string;complete:true;mutations_available:boolean;items:readonly UserRoleIdentity[]}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const roleID=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const text=(v:unknown):v is string=>typeof v==='string'&&v.length<=255&&!/[\u0000-\u001f\u007f]/.test(v);
const tokens=new WeakMap<UserRoleMembers,string>(),attempted=new WeakSet<UserRoleMembers>();
function project(p:UserRoleMembers,actor:string,role:string):UserRoleMembers{
 if(!p||p.actor_uuid!==actor||p.role_id!==role||!validUserRoleName(p.role_name)||typeof p.is_auto_managed!=='boolean'||!revision(p.catalog_revision)||!revision(p.role_revision)||!revision(p.link_revision)||!revision(p.selector_revision)||p.complete!==true||typeof p.mutations_available!=='boolean'||p.is_auto_managed&&p.mutations_available||!Array.isArray(p.items)||p.items.length>1000)throw Error('Complete role-member selection is unavailable. Read again.');
 const ids=new Set<string>();let owners=0;
 const items=p.items.map(r=>{
  if(!r||!uuid(r.uuid)||ids.has(r.uuid)||typeof r.user_type!=='string'||!['owner','local','service'].includes(r.user_type)||!text(r.username)||!text(r.service_type)||!text(r.server_nickname)||r.primary_owner_uuid!==null&&!uuid(r.primary_owner_uuid)||typeof r.is_member!=='boolean'||typeof r.can_change!=='boolean'||typeof r.availability!=='string'||!['available','automatic','protected_owner','pending_work'].includes(r.availability)||r.can_change!==(r.availability==='available')||!p.mutations_available&&r.can_change||p.is_auto_managed!==(r.availability==='automatic'))throw Error('Invalid role-member identity or capabilities');
  if(r.user_type==='service'){if(!['plex','jellyfin','emby','kavita','audiobookshelf','komga','romm'].includes(r.service_type)||r.primary_owner_uuid===actor&&r.can_change)throw Error('Invalid service ownership selection');}
  else if(r.service_type!==''||r.server_nickname!==''||r.primary_owner_uuid!==null)throw Error('Invalid human ownership selection');
  if(r.user_type==='owner'){owners++;if(r.uuid!==actor||r.can_change)throw Error('Invalid protected owner selection');}
  ids.add(r.uuid);return Object.freeze({uuid:r.uuid,user_type:r.user_type,username:r.username,service_type:r.service_type,server_nickname:r.server_nickname,primary_owner_uuid:r.primary_owner_uuid,is_member:r.is_member,can_change:r.can_change,availability:r.availability});
 });
 if(owners!==1)throw Error('The complete owner selection is missing.');
 return Object.freeze({actor_uuid:actor,role_id:role,role_name:p.role_name,is_auto_managed:p.is_auto_managed,catalog_revision:p.catalog_revision,role_revision:p.role_revision,link_revision:p.link_revision,selector_revision:p.selector_revision,complete:true,mutations_available:p.mutations_available,items:Object.freeze(items)});
}
export async function readUserRoleMembers(actor:string,role:string):Promise<UserRoleMembers>{
 const token=getAccessToken();if(!token||!uuid(actor)||!roleID(role))throw Error('Select a current owner and role.');const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const {data}=await requestJson<{data:UserRoleMembers}>(`/api/user-role-catalog/${role}/members`,{signal:abort.signal,retryAuthentication:false});if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,role);tokens.set(p,token);return p;}finally{clearTimeout(timer)}
}
function selectMembers(base:UserRoleMembers,operation:'add'|'remove',ids:readonly string[]):UserRoleIdentity[]{
 if(!base.mutations_available||!['add','remove'].includes(operation)||!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length)throw Error('Choose one distinct batch of at most 100 eligible identities.');
 return ids.map(id=>{const r=base.items.find(row=>row.uuid===id);if(!r||!r.can_change||r.is_member===(operation==='add'))throw Error('Read a current eligible membership selection.');return r});
}
export class UserRoleMembersWriteError extends Error{constructor(public uncertain:boolean){super(uncertain?'The membership outcome is unknown. Read saved members before another change.':'The membership change was rejected. Read saved members before another change.')}}
export async function commitUserRoleMembers(base:UserRoleMembers,operation:'add'|'remove',ids:readonly string[]):Promise<UserRoleMembers>{
 const selectedIds=[...ids],chosen=selectMembers(base,operation,selectedIds),token=tokens.get(base);if(!token||token!==getAccessToken()||attempted.has(base))throw Error('Read a current member selection.');attempted.add(base);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const {data}=await requestJson<{data:UserRoleMembers}>(`/api/user-role-catalog/${base.role_id}/members`,{method:'POST',signal:abort.signal,retryAuthentication:false,
   body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_role_id:base.role_id,catalog_revision:base.catalog_revision,role_revision:base.role_revision,link_revision:base.link_revision,selector_revision:base.selector_revision,operation,acknowledge_visual_only:true,targets:chosen.map(r=>({user_uuid:r.uuid,expected_member:r.is_member}))})});
  if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.role_id),humans=chosen.filter(r=>r.user_type==='local').length;
  if(p.role_name!==base.role_name||p.is_auto_managed!==base.is_auto_managed||p.mutations_available!==base.mutations_available||p.link_revision!==base.link_revision||BigInt(p.catalog_revision)!==BigInt(base.catalog_revision)+BigInt(chosen.length)||BigInt(p.role_revision)!==BigInt(base.role_revision)+BigInt(humans)||BigInt(p.selector_revision)!==BigInt(base.selector_revision)+BigInt(humans)||p.items.length!==base.items.length||p.items.some(r=>{const old=base.items.find(x=>x.uuid===r.uuid);return !old||r.user_type!==old.user_type||r.username!==old.username||r.service_type!==old.service_type||r.server_nickname!==old.server_nickname||r.primary_owner_uuid!==old.primary_owner_uuid||r.can_change!==old.can_change||r.availability!==old.availability||r.is_member!==(selectedIds.includes(r.uuid)?operation==='add':old.is_member)}))throw Error('Invalid committed membership receipt.');return p;
 }catch(error){throw new UserRoleMembersWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)))}finally{clearTimeout(timer)}
}
export class UserRoleMembersController{
 base:UserRoleMembers|null=null;busy=false;needsRead=false;uncertain=false;private token=getAccessToken();
 constructor(readonly actor:string,readonly role:string,private visible:()=>boolean){}
 current(){return this.visible()&&!!this.token&&this.token===getAccessToken()}
 async load(){if(!this.current()||this.busy)throw Error('Select a current owner role.');this.busy=true;this.base=null;try{const p=await readUserRoleMembers(this.actor,this.role);if(!this.current())throw Error('The selected role changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p}finally{this.busy=false}}
 async change(operation:'add'|'remove',ids:readonly string[],confirm:(p:UserRoleMembers,chosen:readonly UserRoleIdentity[])=>boolean){
  if(!this.current()||this.busy||this.needsRead||!this.base)throw Error('Read saved members before another change.');const old=this.base,chosen=[...ids];this.busy=true;
  try{const fresh=await readUserRoleMembers(this.actor,this.role);if(!this.current()||fresh.catalog_revision!==old.catalog_revision||fresh.role_revision!==old.role_revision||fresh.link_revision!==old.link_revision||fresh.selector_revision!==old.selector_revision)throw Error('Membership, ownership or candidates changed. Read before selecting again.');
   const rows=selectMembers(fresh,operation,chosen);if(!confirm(fresh,rows))return null;if(!this.current())throw Error('The selected role changed.');const result=await commitUserRoleMembers(fresh,operation,chosen);if(this.current())this.base=result;return result;
  }catch(error){this.base=null;this.needsRead=true;this.uncertain=error instanceof UserRoleMembersWriteError&&error.uncertain;throw error}finally{this.busy=false}
 }
}
