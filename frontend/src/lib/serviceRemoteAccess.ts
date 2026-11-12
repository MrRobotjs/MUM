import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {validSavedExpiry} from './humanExpiry';

export type RemoteAccessState='none'|'running'|'disabled'|'enabled'|'deleted'|'absent'|'failed'|'unknown';
type Availability='available'|'running'|'unsupported'|'server_inactive'|'identity_unknown'|'pending_work'|'owner_only'|'protected_owner'|'protected_self';
export type ServiceRemoteAccess=Readonly<{actor_uuid:string;service_uuid:string;server_id:string;service_type:string;username:string;owner_uuid:string|null;is_active:boolean;access_expires_at:string|null;
 operation_revision:string;link_revision:string;server_revision:string;state:RemoteAccessState;error_code:string|null;checked_at:string|null;cleanup_scope:'account'|'media'|'';
 availability:Availability;can_disable:boolean;enable_availability:Availability|'service_expired'|'owner_inactive';can_enable:boolean;
 delete_availability:Availability|'disable_first';can_delete:boolean}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const integer=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const states=['none','running','disabled','enabled','deleted','absent','failed','unknown'],availability=['available','running','unsupported','server_inactive','identity_unknown','pending_work','owner_only','protected_owner','protected_self'];
function project(p:ServiceRemoteAccess,actor:string,target:string):ServiceRemoteAccess{
 if(!p||p.actor_uuid!==actor||p.service_uuid!==target||!integer(p.server_id)||!/^[a-z]{1,32}$/.test(String(p.service_type))||!text(p.username,255)||p.owner_uuid!==null&&!uuid(p.owner_uuid)||typeof p.is_active!=='boolean'||!validSavedExpiry(p.access_expires_at)
  ||!integer(p.operation_revision)||!integer(p.link_revision)||!integer(p.server_revision)||!states.includes(p.state)||p.error_code!==null&&!/^[A-Z_]{1,64}$/.test(String(p.error_code))||p.checked_at!==null&&!(typeof p.checked_at==='string'&&Number.isFinite(Date.parse(p.checked_at)))
  ||!['account','media',''].includes(p.cleanup_scope)||!availability.includes(p.availability)||p.can_disable!==(p.availability==='available')||![...availability,'service_expired','owner_inactive'].includes(p.enable_availability)||p.can_enable!==(p.enable_availability==='available')
  ||p.availability!=='available'&&p.enable_availability!==p.availability||p.can_enable&&p.cleanup_scope!=='account'
  ||![...availability,'disable_first'].includes(p.delete_availability)||p.can_delete!==(p.delete_availability==='available')||p.availability!=='available'&&p.delete_availability!==p.availability||p.can_delete&&p.state!=='disabled'
  ||p.availability==='running'&&p.state!=='running'||p.state==='running'&&!['running','owner_only','protected_owner','protected_self'].includes(p.availability))throw Error('Remote access is unavailable. Read again.');
 return Object.freeze({actor_uuid:actor,service_uuid:target,server_id:p.server_id,service_type:p.service_type,username:p.username,owner_uuid:p.owner_uuid,is_active:p.is_active,access_expires_at:p.access_expires_at,operation_revision:p.operation_revision,link_revision:p.link_revision,
  server_revision:p.server_revision,state:p.state,error_code:p.error_code,checked_at:p.checked_at,cleanup_scope:p.cleanup_scope,availability:p.availability,can_disable:p.can_disable,enable_availability:p.enable_availability,can_enable:p.can_enable,delete_availability:p.delete_availability,can_delete:p.can_delete});
}
const tokens=new WeakMap<ServiceRemoteAccess,string>(),attempted=new WeakSet<ServiceRemoteAccess>();
export async function readServiceRemoteAccess(actor:string,target:string):Promise<ServiceRemoteAccess>{
 const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Select a current service profile.');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const{data}=await requestJson<{data:ServiceRemoteAccess}>(`/api/service-accounts/${target}/remote-access`,{signal:abort.signal,retryAuthentication:false});if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,target);tokens.set(p,token);return p}finally{clearTimeout(timer)}
}
export const validRemoteReason=(reason:string)=>{const bytes=new TextEncoder().encode(reason.trim()).length;return bytes>=10&&bytes<=1000};
export class ServiceRemoteAccessWriteError extends Error{constructor(public uncertain:boolean){super(uncertain?'The remote outcome is unknown. Read remote access before another change; the request was not retried.':'The remote access change was rejected. Read remote access before another change.')}}
export type RemoteOperation='disable'|'enable'|'delete';
const results:Record<RemoteOperation,readonly RemoteAccessState[]>={disable:['disabled','absent','failed','unknown'],enable:['enabled','absent','failed','unknown'],delete:['deleted','absent','failed','unknown']};
export const disableServiceRemoteAccess=(base:ServiceRemoteAccess,reason:string)=>remoteOperation(base,reason,'disable');
export const enableServiceRemoteAccess=(base:ServiceRemoteAccess,reason:string)=>remoteOperation(base,reason,'enable');
// Irreversible: the exact recorded username must be typed; it is never prefilled.
export const deleteServiceRemoteAccess=(base:ServiceRemoteAccess,reason:string,confirmName:string)=>remoteOperation(base,reason,'delete',confirmName);
// One explicit attempt per fresh read. A network or server failure is never replayed.
async function remoteOperation(base:ServiceRemoteAccess,reason:string,kind:RemoteOperation,confirmName=''):Promise<ServiceRemoteAccess>{
 const allowed={disable:base.can_disable,enable:base.can_enable,delete:base.can_delete&&confirmName===base.username}[kind];
 const token=tokens.get(base);if(!token||token!==getAccessToken()||attempted.has(base)||!allowed||!validRemoteReason(reason))throw Error('Read current remote access first.');attempted.add(base);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
 try{const{data}=await requestJson<{data:ServiceRemoteAccess}>(`/api/service-accounts/${base.service_uuid}/remote-access/${kind}`,{method:'POST',signal:abort.signal,retryAuthentication:false,body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_service_uuid:base.service_uuid,
   operation_revision:base.operation_revision,link_revision:base.link_revision,server_revision:base.server_revision,expected_is_active:base.is_active,expected_owner_uuid:base.owner_uuid,reason:reason.trim(),acknowledge_remote_write:true,acknowledge_in_flight_risk:true,...(kind==='delete'?{confirm_username:confirmName,acknowledge_irreversible:true}:{})})});
  if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.service_uuid);
  if(!results[kind].includes(p.state)||p.server_id!==base.server_id||p.owner_uuid!==base.owner_uuid||BigInt(p.operation_revision)!==BigInt(base.operation_revision)+2n)throw Error('Unconfirmed remote access outcome');return p;
 }catch(e){throw new ServiceRemoteAccessWriteError(!(e instanceof ApiError&&[400,401,403,404,405,409,422].includes(e.status)))}finally{clearTimeout(timer)}
}
export class ServiceRemoteAccessController{
 base:ServiceRemoteAccess|null=null;busy=false;needsRead=false;uncertain=false;private token=getAccessToken();
 constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
 current(){return this.visible()&&!!this.token&&this.token===getAccessToken()}
 async load(){if(!this.current()||this.busy)throw Error('Select a current service profile.');this.busy=true;this.base=null;try{const p=await readServiceRemoteAccess(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p}finally{this.busy=false}}
 disable(reason:string,confirm:(selection:ServiceRemoteAccess)=>boolean){return this.run(reason,confirm,'disable')}
 enable(reason:string,confirm:(selection:ServiceRemoteAccess)=>boolean){return this.run(reason,confirm,'enable')}
 delete(reason:string,confirmName:string,confirm:(selection:ServiceRemoteAccess)=>boolean){return this.run(reason,confirm,'delete',confirmName)}
 private async run(reason:string,confirm:(selection:ServiceRemoteAccess)=>boolean,kind:RemoteOperation,confirmName=''){if(!this.current()||this.busy||this.needsRead||!validRemoteReason(reason))throw Error('Read remote access first.');this.busy=true;
  try{const p=await readServiceRemoteAccess(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;if(!{disable:p.can_disable,enable:p.can_enable,delete:p.can_delete&&confirmName===p.username}[kind])throw Error('This change is unavailable.');if(!confirm(p))return null;if(!this.current())throw Error('The selected profile changed.');
   const result=await remoteOperation(p,reason,kind,confirmName);if(this.current())this.base=result;return result}
  catch(e){this.base=null;this.needsRead=true;this.uncertain=e instanceof ServiceRemoteAccessWriteError&&e.uncertain;throw e}finally{this.busy=false}
 }
}

export type ProfileRemoteAccessPlan=Readonly<{actor_uuid:string;user_uuid:string;link_revision:string;accounts:readonly ServiceRemoteAccess[]}>;
export async function readProfileRemoteAccess(actor:string,user:string):Promise<ProfileRemoteAccessPlan>{
 const token=getAccessToken();if(!token||!uuid(actor)||!uuid(user))throw Error('Select a current profile.');
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
 try{const{data}=await requestJson<{data:{actor_uuid:string;user_uuid:string;link_revision:string;accounts:ServiceRemoteAccess[]}}>(`/api/users/${user}/remote-access`,{signal:abort.signal,retryAuthentication:false});
  if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');
  if(!data||data.actor_uuid!==actor||data.user_uuid!==user||!integer(data.link_revision)||!Array.isArray(data.accounts)||data.accounts.length>200)throw Error('Remote access is unavailable. Read again.');
  const seen=new Set<string>();const accounts=data.accounts.map(row=>{if(!uuid(row?.service_uuid))throw Error('Remote access is unavailable. Read again.');const p=project(row,actor,row.service_uuid);if(seen.has(p.service_uuid)||p.owner_uuid!==user||p.link_revision!==data.link_revision)throw Error('Remote access is unavailable. Read again.');seen.add(p.service_uuid);return p});
  return Object.freeze({actor_uuid:actor,user_uuid:user,link_revision:data.link_revision,accounts:Object.freeze(accounts)});
 }finally{clearTimeout(timer)}
}
export type ProfileRemoteOutcome=Readonly<{service_uuid:string;username:string;service_type:string;result:'disabled'|'absent'|'failed'|'unknown'|'skipped'|'rejected'|'uncertain'|'not_attempted';error_code:string|null}>;
// Runs the confirmed accounts one at a time. Each gets a fresh read and one
// attempt; it must still belong to the profile and be available. A transport
// uncertainty stops the run: later accounts are reported, never silently retried.
export async function disableProfileRemoteAccess(plan:ProfileRemoteAccessPlan,reason:string,current:()=>boolean,progress:(outcomes:readonly ProfileRemoteOutcome[])=>void=()=>{}):Promise<readonly ProfileRemoteOutcome[]>{
 if(!validRemoteReason(reason)||!current())throw Error('Read current remote access first.');
 const selected=plan.accounts.filter(account=>account.can_disable),outcomes:ProfileRemoteOutcome[]=[];let stopped=false;
 for(const account of selected){
  const entry={service_uuid:account.service_uuid,username:account.username,service_type:account.service_type};
  if(stopped||!current()){outcomes.push(Object.freeze({...entry,result:'not_attempted',error_code:null}));stopped=true;progress([...outcomes]);continue}
  let fresh:ServiceRemoteAccess;
  try{fresh=await readServiceRemoteAccess(plan.actor_uuid,account.service_uuid)}catch{outcomes.push(Object.freeze({...entry,result:'not_attempted',error_code:null}));stopped=true;progress([...outcomes]);continue}
  if(fresh.owner_uuid!==plan.user_uuid||!fresh.can_disable||fresh.server_id!==account.server_id){outcomes.push(Object.freeze({...entry,result:'skipped',error_code:null}));progress([...outcomes]);continue}
  try{const result=await disableServiceRemoteAccess(fresh,reason);outcomes.push(Object.freeze({...entry,result:result.state==='disabled'||result.state==='absent'||result.state==='failed'?result.state:'unknown',error_code:result.error_code}))}
  catch(e){const uncertain=e instanceof ServiceRemoteAccessWriteError&&e.uncertain;outcomes.push(Object.freeze({...entry,result:uncertain?'uncertain':'rejected',error_code:null}));if(uncertain)stopped=true}
  progress([...outcomes]);
 }
 return Object.freeze(outcomes);
}
