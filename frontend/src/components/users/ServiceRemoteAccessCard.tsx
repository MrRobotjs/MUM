import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {ServiceRemoteAccessController,validRemoteReason,type ServiceRemoteAccess} from '../../lib/serviceRemoteAccess';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,changedWhileConfirming,type Notice} from './AccountSettings';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

const unavailable:Record<ServiceRemoteAccess['availability'],string>={available:'',running:'A remote access operation is in progress. Read again shortly.',
  unsupported:'Remote disable is not available for this service type.',server_inactive:'The server or its provider is inactive or has no API key.',
  identity_unknown:'The recorded remote identity is incomplete. Sync the server first.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',
  owner_only:'Only the owner can delete an administrator’s server account.',protected_owner:'The owner’s accounts are protected.',protected_self:'You cannot disable your own linked accounts here.'};
const enableBlocked:Record<string,string>={unsupported:'Re-enabling is not supported here: restoring removed media access would require a new grant.',service_expired:'Re-enabling is blocked while this account’s local MUM expiry has passed.',owner_inactive:'Re-enabling is blocked while the linked profile is inactive or expired.'};
const outcome:Record<ServiceRemoteAccess['state'],string>={none:'No remote access change has been made from MUM.',running:'In progress.',disabled:'Verified disabled on the remote service.',enabled:'Verified enabled on the remote service.',deleted:'Verified deleted from the remote service. The MUM profile and history are kept.',
  absent:'Verified absent from the remote service.',failed:'Not changed: the last attempt was refused or could not be verified.',unknown:'Outcome unknown. Inspect again before relying on remote access state.'};
type Kind='enable'|'disable'|'delete';
const short:Record<ServiceRemoteAccess['state'],string>={none:'Not changed from MUM',running:'In progress',disabled:'Disabled',enabled:'Enabled',deleted:'Deleted',absent:'Not on the server',failed:'Last change failed',unknown:'Outcome unknown'};
const scope=(p:ServiceRemoteAccess)=>p.cleanup_scope==='media'?'This removes the account’s media access. The remote login itself stays enabled.':'This disables the account on the remote service.';

export function ServiceRemoteAccessCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<ServiceRemoteAccessController|null>(null);
  const controller=useMemo(()=>{const value:ServiceRemoteAccessController=new ServiceRemoteAccessController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:''}),[typed,setTyped]=useState({controller,value:''}),[notice,setNotice]=useState<{controller:ServiceRemoteAccessController;value:Notice}|null>(null);
  const [asking,setAsking]=useState<Kind|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const say=(value:Notice)=>{if(controller.current())setNotice({controller,value});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(update).catch(error=>{if(controller.current()){say({text:String(error.message),error:true});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;say(null);}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{update();}};
  const reason=draft.controller===controller?draft.value:'';
  const confirmName=typed.controller===controller?typed.value:'';
  const page=controller.current()?controller.base:null;
  const ask=(kind:Kind)=>{setDraft({controller,value:''});setTyped({controller,value:''});setAsking(kind);};
  // The dialog shows what was read and collects the audited reason; the
  // change goes ahead only if a fresh read still matches what was shown.
  const run=async()=>{const kind=asking;if(!kind||controller.busy||!controller.current()||!page)return;const shown=page;
    const same=(p:ServiceRemoteAccess)=>p.username===shown.username&&p.cleanup_scope===shown.cleanup_scope&&p.state===shown.state&&p.service_type===shown.service_type;
    const pending=kind==='delete'?controller.delete(reason,confirmName,same):controller[kind](reason,same);update();
    try{const result=await pending;if(!controller.current())return;if(!result){say({text:changedWhileConfirming,error:true});return;}setDraft({controller,value:''});setTyped({controller,value:''});say({text:outcome[result.state]});
      try{await refreshUser();}catch{say({text:`${outcome[result.state]} Reload the profile to refresh its display.`});}
    }catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{setAsking(null);update();}};
  if(!isAdministrator)return null;
  const name=page?.username||'this account',server=page?`this ${page.service_type} server`:'this server';
  const shownNotice=notice?.controller===controller&&notice.value?notice.value:controller.needsRead?{text:'Read the current remote access before another change.',error:true}:null;
  const busy=controller.busy||controller.needsRead;
  const dialog:Record<Kind,{title:string;label:string;text:string}>={
    enable:{title:`Re-enable ${name}?`,label:'Re-enable',text:`This turns remote access back on for ${name} on ${server}. Other remote settings are kept.`},
    disable:{title:`Disable ${name}?`,label:'Disable',text:page?`${scope(page)}`:''},
    delete:{title:`Delete ${name} from ${server}?`,label:'Delete account',text:'This cannot be undone: the remote account and its history on the server are removed. The MUM profile, its links and its MUM history are kept.'}};
  return <Card>
    <SettingHeader title="Remote access" summary={page?short[page.state]:controller.busy?'Loading…':'Unavailable'}
      info={<>
        <p>Disables or removes this account on its media server. Local MUM expiry never does this by itself.</p>
        <p>MUM checks the account first and writes at most once. If the reply is lost, the outcome stays unknown and nothing is retried.</p>
        {page&&<p>Last outcome: {outcome[page.state]}{page.checked_at?` (${page.checked_at})`:''}{page.error_code?` [${page.error_code}]`:''}</p>}
        {page&&unavailable[page.availability]&&<p>{unavailable[page.availability]}</p>}
        {page?.availability==='available'&&enableBlocked[page.enable_availability]&&<p>{enableBlocked[page.enable_availability]}</p>}
      </>}
      action={page&&<>
        {page.can_enable&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>ask('enable')}>Re-enable</Button>}
        {page.can_disable&&<Button type="button" variant="outline" size="sm" disabled={busy} onClick={()=>ask('disable')}>Disable</Button>}
        {page.can_delete&&<Button type="button" variant="outline" size="sm" className="text-destructive" disabled={busy} onClick={()=>ask('delete')}>Delete</Button>}
      </>}/>
    {shownNotice&&<CardContent><SettingNotice notice={shownNotice} busy={controller.busy||!actor} onRetry={()=>void read()}/></CardContent>}
    <ConfirmAction open={asking!==null} onOpenChange={value=>{if(!value)setAsking(null);}} title={asking?dialog[asking].title:''} confirmLabel={asking?dialog[asking].label:''} destructive={asking!=='enable'} busy={controller.busy}
      confirmDisabled={!validRemoteReason(reason)||asking==='delete'&&confirmName!==page?.username} onConfirm={()=>void run()}>
      <p>{asking?dialog[asking].text:''}</p>
      <div className="space-y-2"><Label htmlFor={`remote-access-reason-${target}`}>Reason (audited)</Label><Input id={`remote-access-reason-${target}`} value={reason} maxLength={1000} disabled={controller.busy} onChange={event=>setDraft({controller,value:event.target.value})}/><p className="text-xs text-muted-foreground">10 to 1000 characters.</p></div>
      {asking==='delete'&&<div className="space-y-2"><Label htmlFor={`remote-delete-name-${target}`}>Type {page?.username} to confirm</Label><Input id={`remote-delete-name-${target}`} value={confirmName} autoComplete="off" disabled={controller.busy} onChange={event=>setTyped({controller,value:event.target.value})}/></div>}
    </ConfirmAction>
  </Card>;
}
