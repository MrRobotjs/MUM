import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanCredentialsController,validCredentialSelection} from '../../lib/humanCredentials';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,changedWhileConfirming,type Notice} from './AccountSettings';
import {Button} from '../ui/button';import {Input} from '../ui/input';import {Label} from '../ui/label';
const empty=()=>({new_username:'',current_owner_password:'',new_password:'',confirm_password:'',acknowledge_revoke_sessions:false,acknowledge_local_only:false});
const reasons={available:'',protected_owner:'The owner account is protected.',protected_self:'Use your own account password settings.',protected_administrator:'This administrator has no supported local credentials.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',username_unavailable:'Initial credentials require a supported existing local username.'};
export function HumanCredentialsCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
 const {user,isOwner}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot),actor=isOwner&&session.accessToken?user?.uuid:undefined,visible=useRef<HumanCredentialsController|null>(null);
 const controller=useMemo(()=>{const c:HumanCredentialsController=new HumanCredentialsController(actor??'',target,()=>visible.current===c);return c;},[actor,target,session.accessToken]);visible.current=controller;
 const [,redraw]=useState(0),[draft,setDraft]=useState({controller,value:empty()}),[notice,setNotice]=useState<{controller:HumanCredentialsController;value:Notice}|null>(null);
 const [open,setOpen]=useState(false),[confirming,setConfirming]=useState(false);
 const update=()=>{if(controller.current())redraw(n=>n+1);};
 const say=(value:Notice)=>{if(controller.current())setNotice({controller,value});};
 useEffect(()=>{visible.current=controller;setDraft({controller,value:empty()});setOpen(false);if(actor)void controller.load().then(update).catch(()=>{if(controller.current()){say({text:'Could not read the password state.',error:true});update();}});return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
 const read=async()=>{if(!controller.current()||controller.busy)return;setDraft({controller,value:empty()});const pending=controller.load();update();try{await pending;say(null);}catch{say({text:'Could not read the password state.',error:true});}finally{update();}};
 const page=controller.current()?controller.base:null,value=draft.controller===controller?draft.value:empty();
 // Confirming the dialog is the acknowledgement the server asks for.
 const acknowledged={...value,acknowledge_revoke_sessions:true,acknowledge_local_only:true};
 const change=async()=>{if(!controller.current()||controller.busy||!page)return;const shown=page;const pending=controller.change(acknowledged,p=>p.has_password===shown.has_password&&p.username===shown.username);setDraft({controller,value:empty()});update();
 try{const result=await pending;if(!controller.current())return;if(!result){say({text:changedWhileConfirming,error:true});return;}setOpen(false);say({text:'Password saved. Their MUM sessions were signed out.'});try{await refreshUser();}catch{}}
 catch{say({text:controller.uncertain?'The outcome is unknown. Read the password state before trying again.':'The change was refused. Read the password state before trying again.',error:true});}finally{setConfirming(false);update();}};
 if(!actor)return null;
 const editable=!!(page?.can_reset||page?.can_set_initial),disabled=controller.busy||controller.needsRead||!editable;
 const name=(page?.can_set_username?value.new_username:page?.username)||'this account';
 const shownNotice=notice?.controller===controller&&notice.value?notice.value:controller.needsRead?{text:'Read the password state before another change.',error:true}:null;
 const close=()=>{setOpen(false);setDraft({controller,value:empty()});};
 return <Card>
 <SettingHeader title="Local password" summary={page?(page.has_password?'Set':'Not set'):controller.busy?'Loading…':'Unavailable'}
  info={<><p>Only the owner can set or replace someone's MUM password. Saving it signs out all of their MUM sessions. Activation, expiry and media server passwords don't change.</p>
   <p>Use 12 to 1024 characters, different from your own password. The password is permanent and no email is sent, so share it privately.</p>
   {page?.can_set_username&&<p>The username can use English letters, numbers, spaces and standard symbols (no accents or emoji). Capital and small letters count as the same.</p>}
   {page&&reasons[page.availability]&&<p>{reasons[page.availability]}</p>}</>}
  action={editable&&<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={controller.busy||controller.needsRead} onClick={()=>open?close():setOpen(true)}>{open?'Cancel':page?.can_set_initial?'Set password':'Replace'}</Button>}/>
 {(open&&editable||shownNotice)&&<CardContent>
 {open&&editable&&<form className="space-y-4" onSubmit={e=>{e.preventDefault();if(page&&validCredentialSelection(page,acknowledged))setConfirming(true);}}>
 {page.can_set_username&&<div className="space-y-2"><Label htmlFor={`initial-username-${target}`}>Username</Label><Input id={`initial-username-${target}`} autoComplete="username" maxLength={255} value={value.new_username} disabled={disabled} onChange={e=>setDraft({controller,value:{...value,new_username:e.target.value}})}/></div>}
 {(['current_owner_password','new_password','confirm_password'] as const).map((field,index)=><div className="space-y-2" key={field}><Label htmlFor={`local-credential-${target}-${field}`}>{['Your password','New password','Confirm new password'][index]}</Label><Input id={`local-credential-${target}-${field}`} type="password" autoComplete={index===0?'current-password':'new-password'} maxLength={1024} value={value[field]} disabled={disabled} onChange={e=>setDraft({controller,value:{...value,[field]:e.target.value}})}/></div>)}
 <Button type="submit" disabled={disabled||!page||!validCredentialSelection(page,acknowledged)}>{page.can_set_initial?'Set password':'Replace password'}</Button>
 </form>}
 <SettingNotice notice={shownNotice} busy={controller.busy} onRetry={()=>void read()}/>
 </CardContent>}
 <ConfirmAction open={confirming} onOpenChange={setConfirming} title={page?.has_password?`Replace ${name}'s password?`:`Set ${name}'s password?`} confirmLabel={page?.has_password?'Replace password':'Set password'} busy={controller.busy} onConfirm={()=>void change()}>
  All of their MUM sessions are signed out. The password is permanent, so share it privately. Activation, expiry and media server passwords don't change.
 </ConfirmAction>
 </Card>;
}
