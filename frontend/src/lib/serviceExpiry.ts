import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {validNewExpiry,validSavedExpiry} from './humanExpiry';
export {validNewExpiry};
export type ServiceExpiry=Readonly<{actor_uuid:string;service_uuid:string;username:string;server_id:string;owner_uuid:string|null;is_active:boolean;access_expires_at:string|null;expiry_revision:string;link_revision:string;server_revision:string;can_edit:boolean;availability:'available'|'pending_work';local_only:true}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const integer=(v:unknown,zero=false):v is string=>typeof v==='string'&&(zero?/^(0|[1-9][0-9]{0,18})$/:/^[1-9][0-9]{0,18}$/).test(v)&&BigInt(v)<=9223372036854775807n;
function project(p:ServiceExpiry,actor:string,target:string):ServiceExpiry{
 if(!p||p.actor_uuid!==actor||p.service_uuid!==target||typeof p.username!=='string'||p.username.length>255||/[\u0000-\u001f\u007f]/.test(p.username)||!integer(p.server_id)||p.owner_uuid!==null&&!uuid(p.owner_uuid)||typeof p.is_active!=='boolean'||!validSavedExpiry(p.access_expires_at)||!integer(p.expiry_revision)||!integer(p.link_revision)||!integer(p.server_revision,true)||!['available','pending_work'].includes(p.availability)||p.can_edit!==(p.availability==='available')||p.local_only!==true)throw Error('Service expiry is unavailable. Read again.');
 return Object.freeze({actor_uuid:actor,service_uuid:target,username:p.username,server_id:p.server_id,owner_uuid:p.owner_uuid,is_active:p.is_active,access_expires_at:p.access_expires_at,expiry_revision:p.expiry_revision,link_revision:p.link_revision,server_revision:p.server_revision,can_edit:p.can_edit,availability:p.availability,local_only:true});
}
const tokens=new WeakMap<ServiceExpiry,string>(),attempted=new WeakSet<ServiceExpiry>();
export async function readServiceExpiry(actor:string,target:string):Promise<ServiceExpiry>{
 const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Select a current service profile.');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const{data}=await requestJson<{data:ServiceExpiry}>(`/api/service-accounts/${target}/expiry`,{signal:abort.signal,retryAuthentication:false});if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,target);tokens.set(p,token);return p}finally{clearTimeout(timer)}
}
export class ServiceExpiryWriteError extends Error{constructor(public uncertain:boolean){super(uncertain?'The service expiry outcome is unknown. Read saved expiry before another change.':'The service expiry was rejected. Read saved expiry before another change.')}}
export async function commitServiceExpiry(base:ServiceExpiry,expires:string|null):Promise<ServiceExpiry>{
 const token=tokens.get(base);if(!token||token!==getAccessToken()||attempted.has(base)||!base.can_edit||!validNewExpiry(expires)||expires===base.access_expires_at)throw Error('Read a current service expiry selection.');attempted.add(base);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const{data}=await requestJson<{data:ServiceExpiry}>(`/api/service-accounts/${base.service_uuid}/expiry`,{method:'PUT',signal:abort.signal,retryAuthentication:false,body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_service_uuid:base.service_uuid,expiry_revision:base.expiry_revision,link_revision:base.link_revision,server_revision:base.server_revision,expected_is_active:base.is_active,expected_owner_uuid:base.owner_uuid,expected_access_expires_at:base.access_expires_at,access_expires_at:expires,acknowledge_local_only:true})});
  if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.service_uuid);
  if(p.access_expires_at!==expires||p.owner_uuid!==base.owner_uuid||p.is_active!==base.is_active||p.server_id!==base.server_id||p.server_revision!==base.server_revision||BigInt(p.expiry_revision)!==BigInt(base.expiry_revision)+1n||BigInt(p.link_revision)!==BigInt(base.link_revision)+1n)throw Error('Unconfirmed service expiry outcome');return p;
 }catch(e){throw new ServiceExpiryWriteError(!(e instanceof ApiError&&[400,401,403,404,405,409,422].includes(e.status)))}finally{clearTimeout(timer)}
}
export class ServiceExpiryController{
 base:ServiceExpiry|null=null;busy=false;needsRead=false;uncertain=false;private token=getAccessToken();
 constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
 current(){return this.visible()&&!!this.token&&this.token===getAccessToken()}
 async load(){if(!this.current()||this.busy)throw Error('Select a current service profile.');this.busy=true;this.base=null;try{const p=await readServiceExpiry(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p}finally{this.busy=false}}
 async change(expires:string|null,confirm:(selection:ServiceExpiry)=>boolean){if(!this.current()||this.busy||this.needsRead||!validNewExpiry(expires))throw Error('Read saved service expiry first.');this.busy=true;
  try{const p=await readServiceExpiry(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;if(!p.can_edit||expires===p.access_expires_at)throw Error('This change is unavailable.');if(!confirm(p))return null;if(!this.current())throw Error('The selected profile changed.');const result=await commitServiceExpiry(p,expires);if(this.current())this.base=result;return result}
  catch(e){this.base=null;this.needsRead=true;this.uncertain=e instanceof ServiceExpiryWriteError&&e.uncertain;throw e}finally{this.busy=false}
 }
}
