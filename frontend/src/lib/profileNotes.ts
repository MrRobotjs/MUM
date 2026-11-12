import {requestJson,ApiError} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';

export type ProfileNotes = Readonly<{actor_uuid:string;user_uuid:string;user_type:'owner'|'local'|'service';notes:string;
  note_revision:string;role_revision:string;link_revision:string;
  capabilities:Readonly<{edit_notes:true;activation:false;expiry:false;provider_policy:false;whitelist:false}>}>;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const revision=(v:unknown):v is string=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=9223372036854775807n;
export function validNotes(v:unknown):v is string {
  if(typeof v!=='string'||v.length>16384||new TextEncoder().encode(v).length>16384||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v))return false;
  for(const character of v){const code=character.codePointAt(0)!;if(code>=0xd800&&code<=0xdfff)return false;}
  return true;
}
const tokens=new WeakMap<ProfileNotes,string>(),attempted=new WeakSet<ProfileNotes>();
function project(p:ProfileNotes,actor:string,target:string):ProfileNotes {
  const c=p?.capabilities;
  if(!p||p.actor_uuid!==actor||p.user_uuid!==target||typeof p.user_type!=='string'||!['owner','local','service'].includes(p.user_type)||!validNotes(p.notes)||
    !revision(p.note_revision)||!revision(p.role_revision)||!revision(p.link_revision)||!c||c.edit_notes!==true||c.activation!==false||c.expiry!==false||c.provider_policy!==false||c.whitelist!==false)throw Error('Profile notes are unavailable. Read again.');
  return Object.freeze({actor_uuid:actor,user_uuid:target,user_type:p.user_type,notes:p.notes,note_revision:p.note_revision,role_revision:p.role_revision,link_revision:p.link_revision,
    capabilities:Object.freeze({edit_notes:true,activation:false,expiry:false,provider_policy:false,whitelist:false})});
}
export class ProfileNotesWriteError extends Error {
  constructor(public uncertain:boolean){super(uncertain?'The notes outcome is unknown. Read saved notes before another save.':'The notes save was rejected. Read saved notes before another save.');}
}
export async function readProfileNotes(actor:string,target:string):Promise<ProfileNotes>{
  const token=getAccessToken();if(!token||!uuid(actor)||!uuid(target))throw Error('Invalid profile selection.');
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{const {data}=await requestJson<{data:ProfileNotes}>(`/api/users/${target}/notes`,{signal:abort.signal,retryAuthentication:false});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed.');
    const p=project(data,actor,target);tokens.set(p,token);return p;
  }finally{clearTimeout(timer);}
}
export async function saveProfileNotes(base:ProfileNotes,notes:string):Promise<ProfileNotes>{
  const token=tokens.get(base);
  if(!token||token!==getAccessToken()||attempted.has(base)||!validNotes(notes)||notes===base.notes)throw Error('Read a current note selection and enter changed valid notes.');
  attempted.add(base);
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000);
  try{
    const {data}=await requestJson<{data:ProfileNotes}>(`/api/users/${base.user_uuid}/notes`,{method:'PUT',signal:abort.signal,retryAuthentication:false,
      body:JSON.stringify({expected_actor_uuid:base.actor_uuid,expected_user_uuid:base.user_uuid,note_revision:base.note_revision,role_revision:base.role_revision,link_revision:base.link_revision,notes})});
    if(abort.signal.aborted||token!==getAccessToken())throw Error('The session changed after dispatch.');
    const p=project(data,base.actor_uuid,base.user_uuid);
    if(p.user_type!==base.user_type||p.notes!==notes||BigInt(p.note_revision)!==BigInt(base.note_revision)+1n)throw Error('Invalid committed note result.');
    tokens.set(p,token);return p;
  }catch(error){throw new ProfileNotesWriteError(!(error instanceof ApiError&&[400,401,403,404,405,409,422].includes(error.status)));}
  finally{clearTimeout(timer);}
}

export class ProfileNotesEditor {
  base:ProfileNotes|null=null;
  draft='';busy=false;needsRead=false;uncertain=false;
  private token=getAccessToken();
  constructor(readonly actor:string,readonly target:string,private visible:()=>boolean){}
  current(){return this.visible()&&!!this.token&&this.token===getAccessToken();}
  async load(){
    if(!this.current()||this.busy)throw Error('A current profile is required.');this.busy=true;this.base=null;
    try{const p=await readProfileNotes(this.actor,this.target);if(!this.current())throw Error('The selected profile changed.');this.base=p;this.draft=p.notes;this.needsRead=false;this.uncertain=false;return p;}
    finally{this.busy=false;}
  }
  async save(){
    if(!this.current()||this.busy||this.needsRead||!this.base||!validNotes(this.draft)||this.draft===this.base.notes)throw Error('Read current notes and enter changed valid notes.');
    this.busy=true;
    try{const p=await saveProfileNotes(this.base,this.draft);if(this.current()){this.base=p;this.draft=p.notes;}return p;}
    catch(error){this.needsRead=true;this.uncertain=error instanceof ProfileNotesWriteError&&error.uncertain;throw error;}
    finally{this.busy=false;}
  }
}
