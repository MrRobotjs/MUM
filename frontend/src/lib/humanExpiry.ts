import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type HumanExpiry=Readonly<{actor_uuid:string;user_uuid:string;user_type:'owner'|'local';username:string;is_active:boolean;
  access_expires_at:string|null;expiry_revision:string;profile_revision:string;activation_revision:string;role_revision:string;
  can_edit:boolean;availability:'available'|'protected_owner'|'protected_self'|'pending_work'|'credentials_unavailable';sessions_revoked:boolean}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function validSavedExpiry(v:unknown):v is string|null {
  return v===null||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,19)===v.slice(0,19);
}
export function validNewExpiry(v:unknown):v is string|null {
  return v===null||typeof v==='string'&&v.length===20&&validSavedExpiry(v)&&Date.parse(v)>Date.now();
}
const tokens=new WeakMap<HumanExpiry,string>(),attempted=new WeakSet<HumanExpiry>();
function project(p:HumanExpiry,actor:string,target:string,committed:boolean):HumanExpiry {
  if(!p||p.actor_uuid!==actor||p.user_uuid!==target||typeof p.user_type!=='string'||!['owner','local'].includes(p.user_type)||
    typeof p.username!=='string'||p.username.length>255||/[\u0000-\u001f\u007f]/.test(p.username)||typeof p.is_active!=='boolean'||!validSavedExpiry(p.access_expires_at)||
    !revision(p.expiry_revision)||!revision(p.profile_revision)||!revision(p.activation_revision)||!revision(p.role_revision)||typeof p.can_edit!=='boolean'||
    typeof p.availability!=='string'||!['available','protected_owner','protected_self','pending_work','credentials_unavailable'].includes(p.availability)||p.can_edit!==(p.availability==='available')||p.sessions_revoked!==committed||
    p.user_type==='owner'&&p.availability!=='protected_owner'||p.availability==='protected_owner'&&p.user_type!=='owner'||p.availability==='protected_self'&&actor!==target||actor===target&&p.user_type==='local'&&p.availability!=='protected_self')throw Error('Local expiry is unavailable. Read again.');
  return Object.freeze({actor_uuid:actor,user_uuid:target,user_type:p.user_type,username:p.username,is_active:p.is_active,access_expires_at:p.access_expires_at,
    expiry_revision:p.expiry_revision,profile_revision:p.profile_revision,activation_revision:p.activation_revision,role_revision:p.role_revision,
    can_edit:p.can_edit,availability:p.availability,sessions_revoked:committed});
}
export class HumanExpiryWriteError extends Error {
  constructor(public uncertain:boolean){super(uncertain?'The expiry outcome is unknown. Read saved expiry before another change.':'The expiry change was rejected. Read saved expiry before another change.');}
}
export async function readHumanExpiry(actor:string,target:string):Promise<HumanExpiry>{
  const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Invalid human profile selection.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanExpiry}>(`/api/users/${target}/expiry`,{signal:abort.signal,retryAuthentication:false});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,target,false);tokens.set(p,token);return p;
  }finally{clearTimeout(timer);}
}
export async function commitHumanExpiry(base:HumanExpiry,expires:string|null):Promise<HumanExpiry>{
  const token=tokens.get(base);
  if(!token||token!==getAccessToken()||attempted.has(base)||!base.can_edit||!validNewExpiry(expires)||expires===base.access_expires_at)throw Error('Read a current supported expiry selection and enter a future UTC time or clear it.');
  attempted.add(base);const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanExpiry}>(`/api/users/${base.user_uuid}/expiry`,{method:'PUT',signal:abort.signal,retryAuthentication:false,
    body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_user_uuid:base.user_uuid,expiry_revision:base.expiry_revision,profile_revision:base.profile_revision,activation_revision:base.activation_revision,role_revision:base.role_revision,
      expected_is_active:base.is_active,expected_access_expires_at:base.access_expires_at,access_expires_at:expires,acknowledge_revoke_sessions:true,acknowledge_local_only:true})});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.user_uuid,true);
    if(p.user_type!==base.user_type||p.is_active!==base.is_active||p.activation_revision!==base.activation_revision||p.access_expires_at!==expires||BigInt(p.expiry_revision)!==BigInt(base.expiry_revision)+1n||BigInt(p.profile_revision)!==BigInt(base.profile_revision)+1n)throw Error('Invalid committed expiry result.');
    return p;
  }catch(error){throw new HumanExpiryWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)));}
  finally{clearTimeout(timer);}
}
export class HumanExpiryController {
  base:HumanExpiry|null=null;busy=false;needsRead=false;uncertain=false;
  private token=getAccessToken();
  constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
  current(){return this.visible()&&!!this.token&&this.token===getAccessToken();}
  async load(){
    if(!this.current()||this.busy)throw Error('A current human profile is required.');this.busy=true;this.base=null;
    try{const p=await readHumanExpiry(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p;}
    finally{this.busy=false;}
  }
  async change(expires:string|null,confirm:(selection:HumanExpiry)=>boolean){
    if(!this.current()||this.busy||this.needsRead||!validNewExpiry(expires))throw Error('Read saved expiry and enter a future UTC time or clear it.');this.busy=true;
    try{const p=await readHumanExpiry(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;
      if(!p.can_edit||expires===p.access_expires_at)throw Error('This expiry change is unavailable.');
      if(!confirm(p))return null;if(!this.current())throw Error('The selected profile changed.');
      const result=await commitHumanExpiry(p,expires);if(this.current())this.base=result;return result;
    }catch(error){this.base=null;this.needsRead=true;this.uncertain=error instanceof HumanExpiryWriteError&&error.uncertain;throw error;}
    finally{this.busy=false;}
  }
}
