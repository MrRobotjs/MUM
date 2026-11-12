import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanActivationController} from '../../lib/humanActivation';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';

const unavailable={protected_owner:'The owner account is protected.',protected_self:'You cannot change your own activation here.',
  administrator_unavailable:'Administrator activation changes are not available yet.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',
  credentials_unavailable:'Activation changes require a supported local sign-in account.',expired:'The account is expired. Extend or clear its local expiry before activating it.',available:''};

export function HumanActivationCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<HumanActivationController|null>(null);
  const controller=useMemo(()=>{const value:HumanActivationController=new HumanActivationController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[notice,setNotice]=useState<{controller:HumanActivationController;text:string}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(update).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;if(controller.current())setNotice({controller,text:'Current local activation read. No change was retried.'});}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const change=async(active:boolean)=>{if(controller.busy||!controller.current())return;
    const pending=controller.change(active,p=>window.confirm(`${active?'Activate':'Deactivate'} local MUM sign-in for ${p.username||'this account'}? All MUM sessions will be signed out. Linked media accounts will remain unchanged.`));update();
    try{const result=await pending;if(!result||!controller.current())return;setNotice({controller,text:'Local activation changed. All prior MUM sessions were revoked.'});
      try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:'Local activation changed and sessions revoked. Reload the profile to refresh its display.'});}
    }catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const page=controller.current()?controller.base:null;
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Local Account Activation</CardTitle><CardDescription>Applies to local MUM sign-in only. Linked media accounts are unchanged. Changes sign out all MUM sessions.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.controller===controller&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {page?<><p className="text-sm text-muted-foreground">Local activation flag: {page.is_active?'Active':'Inactive'}</p>{unavailable[page.availability]&&<p className="text-sm text-muted-foreground">{unavailable[page.availability]}</p>}</>:<p className="text-sm text-muted-foreground">{controller.busy?'Loading account state…':'Current local activation is unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={controller.busy||!actor} onClick={()=>void read()}>Read local activation</Button>{page&&(page.can_activate||page.can_deactivate)&&<Button disabled={controller.busy||controller.needsRead} onClick={()=>void change(!page.is_active)}>{page.is_active?'Deactivate MUM account':'Activate MUM account'}</Button>}</div>
  </CardContent></Card>;
}
