import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAccessToken,getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {readProfileRemoteAccess,disableProfileRemoteAccess,validRemoteReason,type ProfileRemoteAccessPlan,type ProfileRemoteOutcome,type ServiceRemoteAccess} from '../../lib/serviceRemoteAccess';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,type Notice} from './AccountSettings';
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
  const [outcomes,setOutcomes]=useState<{key:typeof key;value:readonly ProfileRemoteOutcome[]}|null>(null),[notice,setNotice]=useState<{key:typeof key;value:Notice}|null>(null),[asking,setAsking]=useState<ServiceRemoteAccess[]|null>(null);
  // The lock is scoped to this profile/session key, so a stale request can never leave a new view stuck.
  const busy=lock.key===key&&lock.count>0;
  const hold=(delta:number)=>setLock(l=>l.key===key?{key,count:l.count+delta}:delta>0?{key,count:delta}:l);
  const load=async(message?:string)=>{if(!actor)return;hold(1);setPlan(null);
    try{const value=await readProfileRemoteAccess(actor,target);if(current()){setPlan({key,value});setNotice(message?{key,value:{text:message}}:null);}}
    catch(error){if(current())setNotice({key,value:{text:String(error instanceof Error?error.message:error),error:true}});}finally{hold(-1);}};
  const read=(message?:string)=>{if(!busy)void load(message);};
  useEffect(()=>{setOutcomes(null);setNotice(null);if(actor)void load();},[key]);
  const page=plan?.key===key?plan.value:null,draft=reason.key===key?reason.value:'',available=page?page.accounts.filter(a=>a.can_disable):[];
  const run=async()=>{if(!page||busy||!available.length||!validRemoteReason(draft))return;
    hold(1);setPlan(null);setOutcomes({key,value:[]});
    try{const value=await disableProfileRemoteAccess(page,draft,current,progress=>{if(current())setOutcomes({key,value:progress});});if(current()){setOutcomes({key,value});setReason({key,value:''});}
      try{await refreshUser();}catch{}}
    catch(error){if(current())setNotice({key,value:{text:String(error instanceof Error?error.message:error),error:true}});}
    finally{hold(-1);setAsking(null);if(current())void load();}};
  if(!isAdministrator)return null;
  const shown=outcomes?.key===key?outcomes.value:null,message=notice?.key===key?notice.value:null;
  return <Card>
    <SettingHeader title="Remote access" summary={page?(page.accounts.length===0?'No linked accounts':`${page.accounts.length} linked ${page.accounts.length===1?'account':'accounts'}`):busy?'Loading…':'Unavailable'}
      info={<>
        <p>Disables this person's linked accounts on their media servers. Local MUM expiry never does this by itself.</p>
        <p>Each account is checked first and written at most once, one at a time. If a reply is lost, the run stops and that outcome stays unknown; nothing is retried. The MUM profile, its links and its history are kept.</p>
      </>}
      action={available.length>0&&<Button type="button" variant="outline" size="sm" className="text-destructive" disabled={busy} onClick={()=>{setReason({key,value:''});setAsking(available);}}>Disable {available.length===page?.accounts.length?'all':`${available.length}`}</Button>}/>
    {(page&&page.accounts.length>0||shown&&shown.length>0||message)&&<CardContent className="space-y-4">
      {shown&&shown.length>0&&<div className="space-y-2"><p className="text-sm text-muted-foreground">Last run:</p><ul className="space-y-2">{shown.map(o=><li key={o.service_uuid} className="text-sm text-muted-foreground">{o.username||'unnamed'} on {o.service_type}: {result[o.result]}{o.error_code?` [${o.error_code}]`:''}</li>)}</ul></div>}
      {page&&page.accounts.length>0&&<ul className="space-y-2">{page.accounts.map(a=><li key={a.service_uuid} className="text-sm text-muted-foreground">{a.username||'unnamed'} on {a.service_type}{scope(a)}: {state[a.state]}{a.error_code?` [${a.error_code}]`:''}{blocked[a.availability]?` — ${blocked[a.availability]}`:''}</li>)}</ul>}
      <SettingNotice notice={message} busy={busy||!actor} onRetry={()=>read()}/>
    </CardContent>}
    <ConfirmAction open={asking!==null} onOpenChange={value=>{if(!value)setAsking(null);}} title={`Disable ${asking?.length??0} ${asking?.length===1?'account':'accounts'}?`} confirmLabel="Disable" destructive busy={busy} confirmDisabled={!validRemoteReason(draft)} onConfirm={()=>void run()}>
      <ul className="space-y-1">{(asking??[]).map(a=><li key={a.service_uuid}>{a.username||'unnamed'} on {a.service_type}{scope(a)}</li>)}</ul>
      <div className="space-y-2"><Label htmlFor={`profile-remote-reason-${target}`}>Reason (audited)</Label><Input id={`profile-remote-reason-${target}`} value={draft} maxLength={1000} disabled={busy} onChange={event=>setReason({key,value:event.target.value})}/><p className="text-xs text-muted-foreground">10 to 1000 characters.</p></div>
    </ConfirmAction>
  </Card>;
}
