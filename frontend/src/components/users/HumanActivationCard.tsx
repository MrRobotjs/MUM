import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanActivationController} from '../../lib/humanActivation';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,changedWhileConfirming,type Notice} from './AccountSettings';
import {Button} from '../ui/button';

const unavailable={protected_owner:'The owner account is protected.',protected_self:'You cannot change your own activation here.',
  administrator_unavailable:'Only the owner can deactivate or reactivate an administrator.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',
  credentials_unavailable:'Activation changes require a supported local sign-in account.',expired:'The account is expired. Extend or clear its local expiry before activating it.',available:''};

export function HumanActivationCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<HumanActivationController|null>(null);
  const controller=useMemo(()=>{const value:HumanActivationController=new HumanActivationController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[notice,setNotice]=useState<{controller:HumanActivationController;value:Notice}|null>(null),[confirming,setConfirming]=useState(false);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const say=(value:Notice)=>{if(controller.current())setNotice({controller,value});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(update).catch(error=>{if(controller.current()){say({text:String(error.message),error:true});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;say(null);}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{update();}};
  const page=controller.current()?controller.base:null;
  // The dialog shows what was read; the change goes ahead only if a fresh read still matches it.
  const change=async()=>{if(controller.busy||!controller.current()||!page)return;const shown=page,active=!shown.is_active;
    const pending=controller.change(active,p=>p.is_active===shown.is_active&&p.username===shown.username);update();
    try{const result=await pending;if(!controller.current())return;if(!result){say({text:changedWhileConfirming,error:true});return;}say({text:active?'MUM sign-in activated. Their MUM sessions were signed out.':'MUM sign-in deactivated. Their MUM sessions were signed out.'});
      try{await refreshUser();}catch{say({text:'Activation changed. Reload the profile to refresh its display.'});}
    }catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{setConfirming(false);update();}};
  const name=page?.username||'this account';
  return <Card>
    <SettingHeader title="MUM sign-in" summary={page?(page.is_active?'Active':'Inactive'):controller.busy?'Loading…':'Unavailable'}
      info={<><p>Turns this person's own MUM sign-in on or off. Changing it signs out all of their MUM sessions. Linked media accounts don't change.</p>{page&&unavailable[page.availability]&&<p>{unavailable[page.availability]}</p>}</>}
      action={page&&(page.can_activate||page.can_deactivate)&&<Button type="button" variant="outline" size="sm" disabled={controller.busy||controller.needsRead} onClick={()=>setConfirming(true)}>{page.is_active?'Deactivate':'Activate'}</Button>}/>
    {(notice?.controller===controller&&notice.value||controller.needsRead)&&<CardContent><SettingNotice notice={notice?.controller===controller&&notice.value?notice.value:{text:'Read the current state before another change.',error:true}} busy={controller.busy||!actor} onRetry={()=>void read()}/></CardContent>}
    <ConfirmAction open={confirming} onOpenChange={setConfirming} title={page?.is_active?`Deactivate ${name}?`:`Activate ${name}?`} confirmLabel={page?.is_active?'Deactivate':'Activate'} destructive={page?.is_active} busy={controller.busy} onConfirm={()=>void change()}>
      {page?.is_active?'They will no longer be able to sign in to MUM, and all of their MUM sessions are signed out.':'They will be able to sign in to MUM again. Any MUM sessions are signed out.'} Linked media accounts don't change.
    </ConfirmAction>
  </Card>;
}
