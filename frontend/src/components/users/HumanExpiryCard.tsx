import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanExpiryController,validNewExpiry} from '../../lib/humanExpiry';
import {Card,CardContent} from '../ui/card';
import {useAccountDisplay} from '../../hooks/useAccountDisplay';
import {ConfirmAction,SettingHeader,SettingNotice,changedWhileConfirming,type Notice} from './AccountSettings';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

const unavailable={protected_owner:'The owner account is protected.',protected_self:'You cannot change your own expiry here.',
  pending_work:'Finish or reconcile pending provisioning and authorization work first.',credentials_unavailable:'Expiry changes require a supported local sign-in account.',available:''};

export function HumanExpiryCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<HumanExpiryController|null>(null);
  const controller=useMemo(()=>{const value:HumanExpiryController=new HumanExpiryController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const {formatTimestamp}=useAccountDisplay();
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:''}),[notice,setNotice]=useState<{controller:HumanExpiryController;value:Notice}|null>(null);
  const [open,setOpen]=useState(false),[confirming,setConfirming]=useState<{expires:string|null}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const say=(value:Notice)=>{if(controller.current())setNotice({controller,value});};
  const saved=()=>{if(controller.current())setDraft({controller,value:controller.base?.access_expires_at?.slice(0,19)??''});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(()=>{saved();update();}).catch(error=>{if(controller.current()){say({text:String(error.message),error:true});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;saved();say(null);}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{update();}};
  const page=controller.current()?controller.base:null,value=draft.controller===controller?draft.value:'',candidate=value?`${value.length===16?value+':00':value}Z`:'';
  // The dialog shows what was read; the change goes ahead only if a fresh read still matches it.
  const change=async(expires:string|null)=>{if(controller.busy||!controller.current()||!page)return;const shown=page;
    const pending=controller.change(expires,p=>p.access_expires_at===shown.access_expires_at&&p.username===shown.username);update();
    try{const result=await pending;if(!controller.current())return;if(!result){saved();say({text:changedWhileConfirming,error:true});return;}saved();setOpen(false);say({text:'Local expiry changed. Their MUM sessions were signed out.'});
      try{await refreshUser();}catch{say({text:'Expiry changed. Reload the profile to refresh its display.'});}
    }catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{setConfirming(null);update();}};
  const name=page?.username||'this account';
  const shownNotice=notice?.controller===controller&&notice.value?notice.value:controller.needsRead?{text:'Read the saved expiry before another change.',error:true}:null;
  const close=()=>{setOpen(false);saved();};
  return <Card>
    <SettingHeader title="Local expiry" summary={page?(page.access_expires_at?formatTimestamp(page.access_expires_at):'Never'):controller.busy?'Loading…':'Unavailable'}
      info={<><p>When this date passes, this person can no longer sign in to MUM. Changing it signs out all of their MUM sessions. The activation setting and linked media accounts don't change.</p>{page&&unavailable[page.availability]&&<p>{unavailable[page.availability]}</p>}</>}
      action={page?.can_edit&&<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={controller.busy||controller.needsRead} onClick={()=>open?close():setOpen(true)}>{open?'Cancel':'Change'}</Button>}/>
    {(open&&page?.can_edit||shownNotice)&&<CardContent>
      {open&&page?.can_edit&&<form className="space-y-4" onSubmit={event=>{event.preventDefault();if(validNewExpiry(candidate)&&candidate!==page.access_expires_at)setConfirming({expires:candidate});}}>
        <div className="space-y-2"><Label htmlFor={`local-expiry-${target}`}>New expiry (UTC)</Label><Input id={`local-expiry-${target}`} type="datetime-local" step="1" value={value} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,value:event.target.value})}/></div>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={controller.busy||controller.needsRead||!validNewExpiry(candidate)||candidate===page.access_expires_at}>Save expiry</Button>{page.access_expires_at!==null&&<Button type="button" variant="outline" disabled={controller.busy||controller.needsRead} onClick={()=>setConfirming({expires:null})}>Remove expiry</Button>}</div>
      </form>}
      <SettingNotice notice={shownNotice} busy={controller.busy||!actor} onRetry={()=>void read()}/>
    </CardContent>}
    <ConfirmAction open={confirming!==null} onOpenChange={value=>{if(!value)setConfirming(null);}} title={confirming?.expires?`Set ${name}'s expiry to ${formatTimestamp(confirming.expires)}?`:`Remove ${name}'s expiry?`} confirmLabel={confirming?.expires?'Save expiry':'Remove expiry'} busy={controller.busy} onConfirm={()=>{if(confirming)void change(confirming.expires);}}>
      All of their MUM sessions are signed out. Activation and linked media accounts don't change.
    </ConfirmAction>
  </Card>;
}
