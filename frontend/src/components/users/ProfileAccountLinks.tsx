import {useEffect,useMemo,useRef,useState} from 'react';
import {getAccessToken} from '../../store/authStore';
import type {UserDetail} from '../../lib/profileMetadata';
import {useProfileAccountSnapshot} from '../../hooks/useProfileAccountSnapshot';
import {ProfileLinkController} from '../../lib/profileLinkController';
import {ServiceAccountsCard} from './ServiceAccountsCard';
import {ServiceAccountLinkModal} from './ServiceAccountLinkModal';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader} from './AccountSettings';
import {Button} from '../ui/button';

export function ProfileAccountLinks({user,refreshUser}:{user:UserDetail;refreshUser:()=>Promise<unknown>}) {
  const service=user.user_type==='service';
  const target=service?user.linked_local_user?.uuid:user.uuid;
  const {actor,session,state,page}=useProfileAccountSnapshot(target);
  const visible=useRef<unknown>(null);
  const context=useMemo(()=>{
    const value:{controller:ProfileLinkController;running:boolean}={controller:null as unknown as ProfileLinkController,running:false};
    value.controller=new ProfileLinkController(actor??'',target??'',()=>visible.current===value);
    return value;
  },[actor,target,user.uuid,session.accessToken]);
  visible.current=context;
  useEffect(()=>{visible.current=context;return ()=>{if(visible.current===context)visible.current=null;};},[context]);
  const [,redraw]=useState(0);
  const [notice,setNotice]=useState<{context:unknown;text:string}|null>(null);
  const [modal,setModal]=useState<unknown>(null);
  const [unlinking,setUnlinking]=useState<{context:unknown;uuid:string}|null>(null);
  const current=()=>context.controller.current();
  const blocked=context.running||!!context.controller.uncertain;
  const message=notice?.context===context?notice.text:'';

  const change=async(uuid:string,action:'link'|'unlink')=>{
    if(!page||context.running||context.controller.uncertain||!current())return;
    const account=(action==='link'?page.available_accounts:page.linked_accounts).find(a=>a.uuid===uuid);
    if(!account||service&&(action!=='unlink'||uuid!==user.uuid))return;
    setModal(null);
    context.running=true;redraw(x=>x+1);
    try{
      // Choosing an account in the link dialog, or confirming an unlink, is the confirmation.
      const result=await context.controller.change(uuid,action,()=>true);
      if(!result||!current())return;
      setModal(null);setNotice({context,text:'Ownership change confirmed.'});
      try{await Promise.all([state.mutate(),refreshUser()]);}
      catch{if(current())setNotice({context,text:'Ownership change confirmed. Reload the profile to refresh its display.'});}
    }catch(error){if(current())setNotice({context,text:String(error instanceof Error?error.message:error)});}
    finally{context.running=false;setUnlinking(null);if(current())redraw(x=>x+1);}
  };
  const reconcile=async()=>{
    if(context.running||!current())return;
    context.running=true;redraw(x=>x+1);
    try{
      const result=await context.controller.reconcile();
      if(!current())return;
      await state.mutate({page:result.accounts,token:getAccessToken()},false);
      if(!current())return;
      setNotice({context,text:result.linked?'Current ownership read: this service account is linked to the selected local account. Make a new explicit choice if needed.':'Current ownership read: this service account is not linked to the selected local account. Make a new explicit choice if needed.'});
      await refreshUser();
    }catch(error){if(current())setNotice({context,text:String(error instanceof Error?error.message:error)});}
    finally{context.running=false;if(current())redraw(x=>x+1);}
  };
  if(!target)return null;
  const linked=page?.linked_accounts.find(a=>a.uuid===user.uuid);
  const owner=service?user.linked_local_user?.display_name||user.linked_local_user?.username||'the local account':user.display_name||user.username||'this profile';
  const asking=unlinking?.context===context?(page?.linked_accounts.find(a=>a.uuid===unlinking.uuid)??null):null;
  const status=<>
    {message&&<p className="text-sm text-muted-foreground" role="status">{message}</p>}
    {context.controller.uncertain&&<div><Button type="button" variant="outline" size="sm" disabled={context.running} onClick={()=>void reconcile()}>Read current ownership</Button></div>}
  </>;
  return <>
    {service?<Card>
      <SettingHeader title="Linked local account" summary={state.error?'Unavailable':!page?'Loading…':linked?(user.linked_local_user?.display_name??user.linked_local_user?.username??'Local account'):'Not linked'}
        info={<><p>The MUM profile that owns this service account. Unlinking changes ownership in MUM only; access on the server doesn't change.</p>{linked&&user.linked_local_user?.email&&<p>Email: {user.linked_local_user.email}</p>}</>}
        action={linked&&page?.can_unlink&&<Button type="button" variant="outline" size="sm" disabled={blocked} onClick={()=>setUnlinking({context,uuid:user.uuid})}>{context.running?'Unlinking…':'Unlink'}</Button>}/>
      {(message||context.controller.uncertain||state.error)&&<CardContent className="space-y-3">{state.error&&<p className="text-sm text-destructive">Current ownership is unavailable.</p>}{status}</CardContent>}
    </Card>:<ServiceAccountsCard accounts={page?.linked_accounts??[]} loading={!state.error&&!page} error={state.error} onLink={page?.can_link&&page.available_accounts.length&&!blocked?()=>setModal(context):undefined} onUnlink={page?.can_unlink&&!blocked?uuid=>setUnlinking({context,uuid}):undefined}>{(message||context.controller.uncertain)&&status}</ServiceAccountsCard>}
    {!service&&<ServiceAccountLinkModal key={`${actor}:${target}`} open={modal===context&&!blocked&&!!page?.can_link} onClose={()=>setModal(null)} accounts={page?.available_accounts??[]} loading={!page&&!state.error} error={state.error} onSubmit={uuid=>change(uuid,'link')}/>}
    <ConfirmAction open={asking!==null} onOpenChange={value=>{if(!value)setUnlinking(null);}} title={`Unlink ${asking?.external_username||'this service account'}?`} confirmLabel="Unlink" destructive busy={context.running} onConfirm={()=>{if(asking)void change(asking.uuid,'unlink');}}>
      It will no longer be owned by {owner}. This changes ownership in MUM only; access on the server doesn't change.
    </ConfirmAction>
  </>;
}
