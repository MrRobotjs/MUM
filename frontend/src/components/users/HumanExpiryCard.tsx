import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanExpiryController,validNewExpiry} from '../../lib/humanExpiry';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
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
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:''}),[notice,setNotice]=useState<{controller:HumanExpiryController;text:string}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const saved=()=>{if(controller.current())setDraft({controller,value:controller.base?.access_expires_at?.slice(0,19)??''});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(()=>{saved();update();}).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;saved();if(controller.current())setNotice({controller,text:'Saved local expiry read. No change was retried.'});}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const change=async(expires:string|null)=>{if(controller.busy||!controller.current())return;
    const pending=controller.change(expires,p=>window.confirm(`${expires===null?'Clear local MUM expiry':`Set local MUM expiry to ${expires}`} for ${p.username||'this account'}? All MUM sessions will be signed out. The activation flag and linked media accounts will remain unchanged.`));update();
    try{const result=await pending;if(!result||!controller.current())return;saved();setNotice({controller,text:'Local expiry changed. All prior MUM sessions were revoked.'});
      try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:'Local expiry changed and sessions revoked. Reload the profile to refresh its display.'});}
    }catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const page=controller.current()?controller.base:null,value=draft.controller===controller?draft.value:'',candidate=value?`${value.length===16?value+':00':value}Z`:'';
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Local Account Expiry</CardTitle><CardDescription>Applies to local MUM sign-in only. Changes sign out all MUM sessions. Activation and linked media accounts are unchanged.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.controller===controller&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {page?<><p className="text-sm text-muted-foreground">Saved local expiry: {page.access_expires_at??'No local expiry'}</p>{unavailable[page.availability]&&<p className="text-sm text-muted-foreground">{unavailable[page.availability]}</p>}
      {page.can_edit&&<div className="space-y-2"><Label htmlFor={`local-expiry-${target}`}>New expiry (UTC)</Label><Input id={`local-expiry-${target}`} type="datetime-local" step="1" value={value} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,value:event.target.value})}/><p className="text-sm text-muted-foreground">Enter a future UTC date and time, or explicitly clear the saved expiry below.</p></div>}</>:<p className="text-sm text-muted-foreground">{controller.busy?'Loading account expiry…':'Saved local expiry is unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={controller.busy||!actor} onClick={()=>void read()}>Read saved expiry</Button>{page?.can_edit&&<><Button variant="outline" disabled={controller.busy||controller.needsRead||page.access_expires_at===null} onClick={()=>void change(null)}>Clear local expiry</Button><Button disabled={controller.busy||controller.needsRead||!validNewExpiry(candidate)||candidate===page.access_expires_at} onClick={()=>void change(candidate)}>Save local expiry</Button></>}</div>
  </CardContent></Card>;
}
