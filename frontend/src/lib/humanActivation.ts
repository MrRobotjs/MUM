import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type HumanActivation = Readonly<{actor_uuid:string;user_uuid:string;user_type:'owner'|'local';username:string;is_active:boolean;
  activation_revision:string;profile_revision:string;role_revision:string;can_activate:boolean;can_deactivate:boolean;
  availability:'available'|'protected_owner'|'protected_self'|'administrator_unavailable'|'pending_work'|'credentials_unavailable'|'expired';sessions_revoked:boolean}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
const tokens=new WeakMap<HumanActivation,string>(),attempted=new WeakSet<HumanActivation>();
function project(p:HumanActivation,actor:string,target:string,committed:boolean):HumanActivation {
  if(!p||p.actor_uuid!==actor||p.user_uuid!==target||typeof p.user_type!=='string'||!['owner','local'].includes(p.user_type)||
    typeof p.username!=='string'||p.username.length>255||/[\u0000-\u001f\u007f]/.test(p.username)||typeof p.is_active!=='boolean'||
    !revision(p.activation_revision)||!revision(p.profile_revision)||!revision(p.role_revision)||typeof p.can_activate!=='boolean'||typeof p.can_deactivate!=='boolean'||
    typeof p.availability!=='string'||!['available','protected_owner','protected_self','administrator_unavailable','pending_work','credentials_unavailable','expired'].includes(p.availability)||p.sessions_revoked!==committed||
    (p.availability==='available'?(p.can_activate!==!p.is_active||p.can_deactivate!==p.is_active):(p.can_activate||p.can_deactivate))||
    p.user_type==='owner'&&p.availability!=='protected_owner'||p.availability==='protected_owner'&&p.user_type!=='owner'||p.availability==='protected_self'&&actor!==target||actor===target&&p.user_type==='local'&&p.availability!=='protected_self')throw Error('Local activation state is unavailable. Read again.');
  return Object.freeze({actor_uuid:actor,user_uuid:target,user_type:p.user_type,username:p.username,is_active:p.is_active,
    activation_revision:p.activation_revision,profile_revision:p.profile_revision,role_revision:p.role_revision,
    can_activate:p.can_activate,can_deactivate:p.can_deactivate,availability:p.availability,sessions_revoked:committed});
}
export class HumanActivationWriteError extends Error {
  constructor(public uncertain:boolean){super(uncertain?'The activation outcome is unknown. Read local activation before another change.':'The activation change was rejected. Read local activation before another change.');}
}
export async function readHumanActivation(actor:string,target:string):Promise<HumanActivation>{
  const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Invalid human profile selection.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanActivation}>(`/api/users/${target}/activation`,{signal:abort.signal,retryAuthentication:false});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');const p=project(data,actor,target,false);tokens.set(p,token);return p;
  }finally{clearTimeout(timer);}
}
export async function commitHumanActivation(base:HumanActivation,active:boolean):Promise<HumanActivation>{
  const token=tokens.get(base);
  if(!token||token!==getAccessToken()||attempted.has(base)||typeof active!=='boolean'||active===base.is_active||!(active?base.can_activate:base.can_deactivate))throw Error('Read a current supported activation selection.');
  attempted.add(base);const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:HumanActivation}>(`/api/users/${base.user_uuid}/activation`,{method:'PUT',signal:abort.signal,retryAuthentication:false,
    body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_user_uuid:base.user_uuid,activation_revision:base.activation_revision,profile_revision:base.profile_revision,role_revision:base.role_revision,
      expected_is_active:base.is_active,is_active:active,acknowledge_revoke_sessions:true,acknowledge_local_only:true})});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');const p=project(data,base.actor_uuid,base.user_uuid,true);
    if(p.user_type!==base.user_type||p.is_active!==active||BigInt(p.activation_revision)!==BigInt(base.activation_revision)+1n||BigInt(p.profile_revision)!==BigInt(base.profile_revision)+1n)throw Error('Invalid committed activation result.');
    return p;
  }catch(error){throw new HumanActivationWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)));}
  finally{clearTimeout(timer);}
}
export class HumanActivationController {
  base:HumanActivation|null=null;busy=false;needsRead=false;uncertain=false;
  private token=getAccessToken();
  constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
  current(){return this.visible()&&!!this.token&&this.token===getAccessToken();}
  async load(){
    if(!this.current()||this.busy)throw Error('A current human profile is required.');this.busy=true;this.base=null;
    try{const p=await readHumanActivation(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.needsRead=false;this.uncertain=false;return p;}
    finally{this.busy=false;}
  }
  async change(active:boolean,confirm:(selection:HumanActivation)=>boolean){
    if(!this.current()||this.busy||this.needsRead)throw Error('Read local activation before another change.');this.busy=true;
    try{const p=await readHumanActivation(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;
      if(!(active?p.can_activate:p.can_deactivate))throw Error('This activation change is unavailable.');
      if(!confirm(p))return null;if(!this.current())throw Error('The selected profile changed.');
      const result=await commitHumanActivation(p,active);if(this.current())this.base=result;return result;
    }catch(error){this.base=null;this.needsRead=true;this.uncertain=error instanceof HumanActivationWriteError&&error.uncertain;throw error;}
    finally{this.busy=false;}
  }
}
