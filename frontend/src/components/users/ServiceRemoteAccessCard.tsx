import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {ServiceRemoteAccessController,validRemoteReason,type ServiceRemoteAccess} from '../../lib/serviceRemoteAccess';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

const unavailable:Record<ServiceRemoteAccess['availability'],string>={available:'',running:'A remote access operation is in progress. Read again shortly.',
  unsupported:'Remote disable is not available for this service type.',server_inactive:'The server or its provider is inactive or has no API key.',
  identity_unknown:'The recorded remote identity is incomplete. Sync the server first.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',
  owner_only:'Only the owner can disable an account that is not linked to a profile.',protected_owner:'The owner’s accounts are protected.',protected_self:'You cannot disable your own linked accounts here.'};
const enableBlocked:Record<string,string>={unsupported:'Re-enabling is not supported here: restoring removed media access would require a new grant.',service_expired:'Re-enabling is blocked while this account’s local MUM expiry has passed.',owner_inactive:'Re-enabling is blocked while the linked profile is inactive or expired.'};
const outcome:Record<ServiceRemoteAccess['state'],string>={none:'No remote access change has been made from MUM.',running:'In progress.',disabled:'Verified disabled on the remote service.',enabled:'Verified enabled on the remote service.',deleted:'Verified deleted from the remote service. The MUM profile and history are kept.',
  absent:'Verified absent from the remote service.',failed:'Not changed: the last attempt was refused or could not be verified.',unknown:'Outcome unknown. Inspect again before relying on remote access state.'};
const scope=(p:ServiceRemoteAccess)=>p.cleanup_scope==='media'?'This removes the account’s media access. The remote login itself stays enabled.':'This disables the account on the remote service.';

export function ServiceRemoteAccessCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<ServiceRemoteAccessController|null>(null);
  const controller=useMemo(()=>{const value:ServiceRemoteAccessController=new ServiceRemoteAccessController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:''}),[typed,setTyped]=useState({controller,value:''}),[notice,setNotice]=useState<{controller:ServiceRemoteAccessController;text:string}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(update).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;if(controller.current())setNotice({controller,text:'Saved remote access read. No change was retried.'});}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const reason=draft.controller===controller?draft.value:'';
  const confirmName=typed.controller===controller?typed.value:'';
  const remove=async()=>{if(controller.busy||!controller.current())return;
    const pending=controller.delete(reason,confirmName,p=>window.confirm(`Permanently delete ${p.username} from this ${p.service_type} server? This cannot be undone: the remote account and its server-side history are removed. MUM inspects first, deletes at most once and never retries. The MUM profile, ownership links and MUM history are kept.`));update();
    try{const result=await pending;if(!result||!controller.current())return;setDraft({controller,value:''});setTyped({controller,value:''});setNotice({controller,text:outcome[result.state]});
      try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:`${outcome[result.state]} Reload the profile to refresh its display.`});}
    }catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const operate=async(kind:'disable'|'enable')=>{if(controller.busy||!controller.current())return;
    const text=(p:ServiceRemoteAccess)=>kind==='enable'?`Re-enable remote access for ${p.username||'this account'} on this ${p.service_type} server? This reverses a disable; other remote settings are kept.`:`Disable remote access for ${p.username||'this account'} on this ${p.service_type} server? ${scope(p)}`;
    const pending=controller[kind](reason,p=>window.confirm(`${text(p)} MUM inspects the account first and writes at most once. If the response is lost, the outcome stays unknown and nothing is retried automatically. The MUM profile, its ownership and its history are not deleted.`));update();
    try{const result=await pending;if(!result||!controller.current())return;setDraft({controller,value:''});setNotice({controller,text:outcome[result.state]});
      try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:`${outcome[result.state]} Reload the profile to refresh its display.`});}
    }catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const page=controller.current()?controller.base:null;
  if(!isAdministrator)return null;
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Remote Service Access</CardTitle><CardDescription>Explicitly disable this account on its media server. Local MUM expiry never does this automatically.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.controller===controller&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {page?<><p className="text-sm text-muted-foreground">Last remote outcome: {outcome[page.state]}{page.checked_at?` (${page.checked_at})`:''}{page.error_code?` [${page.error_code}]`:''}</p>
      {unavailable[page.availability]&&<p className="text-sm text-muted-foreground">{unavailable[page.availability]}</p>}{page.availability==='available'&&enableBlocked[page.enable_availability]&&<p className="text-sm text-muted-foreground">{enableBlocked[page.enable_availability]}</p>}
      {page.can_delete&&<div className="space-y-2"><Label htmlFor={`remote-delete-name-${target}`}>Type the username to enable permanent deletion</Label><Input id={`remote-delete-name-${target}`} value={confirmName} autoComplete="off" disabled={controller.busy||controller.needsRead} onChange={event=>setTyped({controller,value:event.target.value})}/></div>}{(page.can_disable||page.can_enable||page.can_delete)&&<div className="space-y-2"><p className="text-sm text-muted-foreground">{scope(page)}</p><Label htmlFor={`remote-access-reason-${target}`}>Reason (audited)</Label><Input id={`remote-access-reason-${target}`} value={reason} maxLength={1000} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,value:event.target.value})}/><p className="text-sm text-muted-foreground">Enter 10–1000 bytes describing why remote access is changing.</p></div>}</>
      :<p className="text-sm text-muted-foreground">{controller.busy?'Loading remote access…':'Remote access state is unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={controller.busy||!actor} onClick={()=>void read()}>Read remote access</Button>{page?.can_enable&&<Button variant="outline" disabled={controller.busy||controller.needsRead||!validRemoteReason(reason)} onClick={()=>void operate('enable')}>Re-enable remote access</Button>}{page?.can_disable&&<Button variant="destructive" disabled={controller.busy||controller.needsRead||!validRemoteReason(reason)} onClick={()=>void operate('disable')}>Disable remote access</Button>}{page?.can_delete&&<Button variant="destructive" disabled={controller.busy||controller.needsRead||!validRemoteReason(reason)||confirmName!==page.username} onClick={()=>void remove()}>Delete remote account</Button>}</div>
  </CardContent></Card>;
}
