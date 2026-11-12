import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {readProfileRemoteAccess,disableProfileRemoteAccess,validRemoteReason,type ProfileRemoteAccessPlan,type ProfileRemoteOutcome,type ServiceRemoteAccess} from '../../lib/serviceRemoteAccess';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

const state:Record<ServiceRemoteAccess['state'],string>={none:'not changed from MUM',running:'in progress',disabled:'verified disabled',enabled:'verified enabled',deleted:'verified deleted',absent:'verified absent',failed:'not changed',unknown:'outcome unknown'};
const blocked:Record<ServiceRemoteAccess['availability'],string>={available:'',running:'operation in progress',unsupported:'not supported for this service',server_inactive:'server inactive',identity_unknown:'remote identity incomplete',pending_work:'pending work on this server',owner_only:'owner only',protected_owner:'protected owner account',protected_self:'your own account'};
const result:Record<ProfileRemoteOutcome['result'],string>={disabled:'verified disabled',absent:'verified absent',failed:'not changed (refused or not verified)',unknown:'outcome unknown — inspect again',skipped:'skipped: changed since the plan was read',rejected:'rejected — read again',uncertain:'outcome unknown — the run stopped here',not_attempted:'not attempted'};
const scope=(a:ServiceRemoteAccess)=>a.cleanup_scope==='media'?' (media access only; login stays enabled)':'';

export function ProfileRemoteAccessCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined;
  // A plan is bound to the profile and session it was read for.
  const key=useMemo(()=>({actor,target,token:session.accessToken}),[actor,target,session.accessToken]),visible=useRef(key);visible.current=key;
  const current=()=>visible.current===key&&!!key.token&&key.token===getAccessToken();
  const [plan,setPlan]=useState<{key:typeof key;value:ProfileRemoteAccessPlan}|null>(null),[lock,setLock]=useState<{key:typeof key;count:number}>({key,count:0}),[reason,setReason]=useState({key,value:''});
  const [outcomes,setOutcomes]=useState<{key:typeof key;value:readonly ProfileRemoteOutcome[]}|null>(null),[notice,setNotice]=useState<{key:typeof key;text:string}|null>(null);
  // The lock is scoped to this profile/session key, so a stale request can never leave a new view stuck.
  const busy=lock.key===key&&lock.count>0;
  const hold=(delta:number)=>setLock(l=>l.key===key?{key,count:l.count+delta}:delta>0?{key,count:delta}:l);
  const load=async(message?:string)=>{if(!actor)return;hold(1);setPlan(null);
    try{const value=await readProfileRemoteAccess(actor,target);if(current()){setPlan({key,value});if(message)setNotice({key,text:message});}}
    catch(error){if(current())setNotice({key,text:String(error instanceof Error?error.message:error)});}finally{hold(-1);}};
  const read=(message?:string)=>{if(!busy)void load(message);};
  useEffect(()=>{setOutcomes(null);setNotice(null);if(actor)void load();},[key]);
  const page=plan?.key===key?plan.value:null,draft=reason.key===key?reason.value:'',available=page?page.accounts.filter(a=>a.can_disable):[];
  const run=async()=>{if(!page||busy||!available.length||!validRemoteReason(draft))return;
    if(!window.confirm(`Disable remote access for ${available.length} account(s): ${available.map(a=>`${a.username||'unnamed'} on ${a.service_type}${scope(a)}`).join('; ')}? Each account is inspected first and written at most once, one at a time. If a response is lost, the run stops and that outcome stays unknown; nothing is retried automatically. The MUM profile, its ownership and its history are not deleted.`))return;
    hold(1);setPlan(null);setOutcomes({key,value:[]});
    try{const value=await disableProfileRemoteAccess(page,draft,current,progress=>{if(current())setOutcomes({key,value:progress});});if(current()){setOutcomes({key,value});setReason({key,value:''});}
      try{await refreshUser();}catch{}}
    catch(error){if(current())setNotice({key,text:String(error instanceof Error?error.message:error)});}
    finally{hold(-1);if(current())void load('Remote access read again after the run. No change was retried.');}};
  if(!isAdministrator)return null;
  const shown=outcomes?.key===key?outcomes.value:null;
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Remote Service Access</CardTitle><CardDescription>Explicitly disable this person’s linked accounts on their media servers. Local MUM expiry never does this automatically.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.key===key&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {shown&&shown.length>0&&<div className="space-y-2"><p className="text-sm text-muted-foreground">Last run:</p><ul className="space-y-2">{shown.map(o=><li key={o.service_uuid} className="text-sm text-muted-foreground">{o.username||'unnamed'} on {o.service_type}: {result[o.result]}{o.error_code?` [${o.error_code}]`:''}</li>)}</ul></div>}
    {page?<>{page.accounts.length===0?<p className="text-sm text-muted-foreground">No owned service accounts are linked to this profile.</p>
      :<ul className="space-y-2">{page.accounts.map(a=><li key={a.service_uuid} className="text-sm text-muted-foreground">{a.username||'unnamed'} on {a.service_type}{scope(a)}: {state[a.state]}{a.error_code?` [${a.error_code}]`:''}{blocked[a.availability]?` — ${blocked[a.availability]}`:''}</li>)}</ul>}
      {available.length>0&&<div className="space-y-2"><Label htmlFor={`profile-remote-reason-${target}`}>Reason (audited)</Label><Input id={`profile-remote-reason-${target}`} value={draft} maxLength={1000} disabled={busy} onChange={event=>setReason({key,value:event.target.value})}/><p className="text-sm text-muted-foreground">Enter 10–1000 bytes describing why access is being disabled.</p></div>}</>
      :<p className="text-sm text-muted-foreground">{busy?'Loading remote access…':'Remote access state is unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={busy||!actor} onClick={()=>read('Saved remote access read. No change was retried.')}>Read remote access</Button>{available.length>0&&<Button variant="destructive" disabled={busy||!validRemoteReason(draft)} onClick={()=>void run()}>Disable {available.length} available</Button>}</div>
  </CardContent></Card>;
}
