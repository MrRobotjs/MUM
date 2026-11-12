import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {ServiceExpiryController,validNewExpiry} from '../../lib/serviceExpiry';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';

const unavailable={protected_owner:'The owner account is protected.',protected_self:'You cannot change your own expiry here.',
  pending_work:'Finish or reconcile pending provisioning and authorization work first.',credentials_unavailable:'Expiry changes require a supported local sign-in account.',available:''};

export function ServiceExpiryCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isOwner}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isOwner&&session.accessToken?user?.uuid:undefined,visible=useRef<ServiceExpiryController|null>(null);
  const controller=useMemo(()=>{const value:ServiceExpiryController=new ServiceExpiryController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:''}),[notice,setNotice]=useState<{controller:ServiceExpiryController;text:string}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const saved=()=>{if(controller.current())setDraft({controller,value:controller.base?.access_expires_at?.slice(0,19)??''});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(()=>{saved();update();}).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();
    try{await pending;saved();if(controller.current())setNotice({controller,text:'Saved service expiry read. No change was retried.'});}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const change=async(expires:string|null)=>{if(controller.busy||!controller.current())return;
    const pending=controller.change(expires,p=>window.confirm(`${expires===null?'Clear local service expiry':`Set local service expiry to ${expires}`} for ${p.username||'this account'}? This changes local MUM visibility only. Human sign-in, ownership, activation and remote service access will remain unchanged.`));update();
    try{const result=await pending;if(!result||!controller.current())return;saved();setNotice({controller,text:'Local service expiry changed. Remote service access was not changed.'});
      try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:'Local service expiry changed. Reload the profile to refresh its display.'});}
    }catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const page=controller.current()?controller.base:null,value=draft.controller===controller?draft.value:'',candidate=value?`${value.length===16?value+':00':value}Z`:'';
  if(!isOwner)return null;
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>Service Account Expiry</CardTitle><CardDescription>Controls local MUM visibility only. Your MUM sign-in and remote service access are unchanged.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.controller===controller&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {page?<><p className="text-sm text-muted-foreground">Saved service expiry: {page.access_expires_at??'No service expiry'}</p>{unavailable[page.availability]&&<p className="text-sm text-muted-foreground">{unavailable[page.availability]}</p>}
      {page.can_edit&&<div className="space-y-2"><Label htmlFor={`service-expiry-${target}`}>New expiry (UTC)</Label><Input id={`service-expiry-${target}`} type="datetime-local" step="1" value={value} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,value:event.target.value})}/><p className="text-sm text-muted-foreground">Enter a future UTC date and time, or explicitly clear the saved expiry below.</p></div>}</>:<p className="text-sm text-muted-foreground">{controller.busy?'Loading account expiry…':'Saved service expiry is unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={controller.busy||!actor} onClick={()=>void read()}>Read saved expiry</Button>{page?.can_edit&&<><Button variant="outline" disabled={controller.busy||controller.needsRead||page.access_expires_at===null} onClick={()=>void change(null)}>Clear service expiry</Button><Button disabled={controller.busy||controller.needsRead||!validNewExpiry(candidate)||candidate===page.access_expires_at} onClick={()=>void change(candidate)}>Save service expiry</Button></>}</div>
  </CardContent></Card>;
}
