import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type HumanUserRole=Readonly<{id:string;name:string;is_auto_managed:boolean;assigned:boolean}>;
export type HumanUserRoles=Readonly<{actor_uuid:string;user_uuid:string;user_type:'owner'|'local';username:string;catalog_revision:string;profile_revision:string;role_revision:string;
  can_edit:boolean;can_create:boolean;availability:'available'|'protected_owner'|'protected_self'|'pending_work';roles:readonly HumanUserRole[]}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const roleID=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function validUserRoleName(v:unknown):v is string {
  if(typeof v!=='string'||!v||v!==v.trim()||new TextEncoder().encode(v).length>100||/[\u0000-\u001f\u007f-\u009f]/.test(v))return false;
  for(const c of v){const code=c.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff)return false;}return true;
}
export const manualRoleIDs=(p:HumanUserRoles)=>p.roles.filter(r=>r.assigned&&!r.is_auto_managed).map(r=>r.id).sort();
const tokens=new WeakMap<HumanUserRoles,string>(),attempted=new WeakSet<HumanUserRoles>();
function project(p:HumanUserRoles,actor:string,target:string):HumanUserRoles {
  if(!p||p.actor_uuid!==actor||p.user_uuid!==target||typeof p.user_type!=='string'||!['owner','local'].includes(p.user_type)||typeof p.username!=='string'||p.username.length>255||/[\u0000-\u001f\u007f]/.test(p.username)||
    !revision(p.catalog_revision)||!revision(p.profile_revision)||!revision(p.role_revision)||typeof p.can_edit!=='boolean'||typeof p.can_create!=='boolean'||typeof p.availability!=='string'||!['available','protected_owner','protected_self','pending_work'].includes(p.availability)||p.can_edit!==(p.availability==='available')||p.can_create&&!p.can_edit||
    p.user_type==='owner'&&p.availability!=='protected_owner'||p.availability==='protected_owner'&&p.user_type!=='owner'||p.availability==='protected_self'&&actor!==target||actor===target&&p.user_type==='local'&&p.availability!=='protected_self'||!Array.isArray(p.roles)||p.roles.length>1000)throw Error('Human user roles are unavailable. Read again.');
  const ids=new Set<string>(),names=new Set<string>();
  const roles=p.roles.map(r=>{if(!r||!roleID(r.id)||ids.has(r.id)||!validUserRoleName(r.name)||names.has(r.name)||typeof r.assigned!=='boolean'||typeof r.is_auto_managed!=='boolean')throw Error('Incomplete or invalid user role catalog');ids.add(r.id);names.add(r.name);return Object.freeze({id:r.id,name:r.name,is_auto_managed:r.is_auto_managed,assigned:r.assigned});});
  return Object.freeze({actor_uuid:actor,user_uuid:target,user_type:p.user_type,username:p.username,catalog_revision:p.catalog_revision,profile_revision:p.profile_revision,role_revision:p.role_revision,
    can_edit:p.can_edit,can_create:p.can_create,availability:p.availability,roles:Object.freeze(roles)});
}
function selection(p:HumanUserRoles,ids:readonly string[]):string[]{
  if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!roleID(id)||!p.roles.some(r=>r.id===id&&!r.is_auto_managed)))throw Error('Select complete manual user roles from the current catalog.');return [...ids].sort();
}
export class HumanUserRolesWriteError extends Error {
  constructor(public uncertain:boolean){super(uncertain?'The user-role outcome is unknown. Read saved user roles before another change.':'The user-role change was rejected. Read saved user roles before another change.');}
}
export async function readHumanUserRoles(actor:string,target:string):Promise<HumanUserRoles>{
  const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Invalid human profile selection.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanUserRoles}>(`/api/users/${target}/user-roles`,{signal:abort.signal,retryAuthentication:false});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,target);tokens.set(p,token);return p;
  }finally{clearTimeout(timer);}
}
export async function commitHumanUserRoles(base:HumanUserRoles,ids:readonly string[]):Promise<HumanUserRoles>{
  const chosen=selection(base,ids),token=tokens.get(base);
  if(!token||token!==getAccessToken()||attempted.has(base)||!base.can_edit||JSON.stringify(chosen)===JSON.stringify(manualRoleIDs(base)))throw Error('Read a current changed manual role selection.');
  attempted.add(base);const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanUserRoles}>(`/api/users/${base.user_uuid}/user-roles`,{method:'PUT',signal:abort.signal,retryAuthentication:false,
    body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_user_uuid:base.user_uuid,catalog_revision:base.catalog_revision,profile_revision:base.profile_revision,role_revision:base.role_revision,manual_role_ids:chosen,acknowledge_visual_only:true})});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.user_uuid);
    if(p.user_type!==base.user_type||p.username!==base.username||p.can_edit!==base.can_edit||p.can_create!==base.can_create||BigInt(p.role_revision)!==BigInt(base.role_revision)+1n||BigInt(p.profile_revision)!==BigInt(base.profile_revision)+1n||BigInt(p.catalog_revision)!==BigInt(base.catalog_revision)+BigInt(base.roles.filter(r=>!r.is_auto_managed&&r.assigned!==chosen.includes(r.id)).length)||p.roles.length!==base.roles.length||p.roles.some(r=>{const old=base.roles.find(x=>x.id===r.id);return !old||old.name!==r.name||old.is_auto_managed!==r.is_auto_managed||r.assigned!==(r.is_auto_managed?old.assigned:chosen.includes(r.id));}))throw Error('Invalid committed user-role result.');
    return p;
  }catch(error){throw new HumanUserRolesWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)));}finally{clearTimeout(timer);}
}
export async function createHumanUserRole(base:HumanUserRoles,name:string){
  const token=tokens.get(base);if(!token||token!==getAccessToken()||attempted.has(base)||!base.can_create||!validUserRoleName(name))throw Error('Read a current owner role selection and enter a valid name.');
  attempted.add(base);const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data:p}=await requestJson<{data:{actor_uuid:string;catalog_revision:string;role_revision:string;role_id:string;name:string}}>('/api/user-role-catalog',{method:'POST',signal:abort.signal,retryAuthentication:false,
    body:JSON.stringify({expected_actor_uuid:base.actor_uuid,catalog_revision:base.catalog_revision,role_revision:base.role_revision,name})});
    if(abort.signal.aborted||token!==getAccessToken()||!p||p.actor_uuid!==base.actor_uuid||p.name!==name||!uuid(p.role_id)||base.roles.some(r=>r.id===p.role_id)||!revision(p.catalog_revision)||BigInt(p.catalog_revision)!==BigInt(base.catalog_revision)+1n||p.role_revision!==base.role_revision)throw Error('Invalid committed role creation');
    return Object.freeze({role_id:p.role_id,name:p.name});
  }catch(error){throw new HumanUserRolesWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)));}finally{clearTimeout(timer);}
}
export class HumanUserRolesController {
  base:HumanUserRoles|null=null;busy=false;needsRead=false;uncertain=false;private token=getAccessToken();
  constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
  current(){return this.visible()&&!!this.token&&this.token===getAccessToken();}
  async load(){if(!this.current()||this.busy)throw Error('A current human profile is required.');this.busy=true;this.base=null;
    try{const p=await readHumanUserRoles(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p;}finally{this.busy=false;}}
  private async preflight(){
    if(!this.current()||this.busy||this.needsRead||!this.base)throw Error('Read saved user roles before another change.');const old=this.base;this.busy=true;
    const p=await readHumanUserRoles(this.actor,this.target);
    if(!this.current()||p.catalog_revision!==old.catalog_revision||p.profile_revision!==old.profile_revision||p.role_revision!==old.role_revision)throw Error('Saved roles or authority changed. Read before selecting again.');return p;
  }
  private failed(error:unknown){this.base=null;this.needsRead=true;this.uncertain=error instanceof HumanUserRolesWriteError&&error.uncertain;}
  async save(ids:readonly string[],confirm:(p:HumanUserRoles)=>boolean){
    if(this.busy)throw Error('A role change is already in progress.');const chosen=[...ids];
    try{const p=await this.preflight();const sorted=selection(p,chosen);if(JSON.stringify(sorted)===JSON.stringify(manualRoleIDs(p)))throw Error('Select changed manual roles.');if(!p.can_edit)throw Error('This role change is unavailable.');if(!confirm(p))return null;if(!this.current())throw Error('The selected profile changed.');const result=await commitHumanUserRoles(p,chosen);if(this.current())this.base=result;return result;
    }catch(error){this.failed(error);throw error;}finally{this.busy=false;}
  }
  async create(name:string,confirm:()=>boolean){
    if(this.busy)throw Error('A role change is already in progress.');
    try{const p=await this.preflight();if(!p.can_create||!validUserRoleName(name))throw Error('Only the owner can create a valid visual role.');if(!confirm())return null;if(!this.current())throw Error('The selected profile changed.');const result=await createHumanUserRole(p,name);this.base=null;this.needsRead=true;return result;
    }catch(error){this.failed(error);throw error;}finally{this.busy=false;}
  }
}
