import {useEffect,useMemo,useRef,useState} from 'react';
import {getAccessToken} from '../../store/authStore';
import type {UserDetail} from '../../lib/profileMetadata';
import {useProfileAccountSnapshot} from '../../hooks/useProfileAccountSnapshot';
import {ProfileLinkController} from '../../lib/profileLinkController';
import {ServiceAccountsCard} from './ServiceAccountsCard';
import {ServiceAccountLinkModal} from './ServiceAccountLinkModal';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
import {Button} from '../ui/button';
import {FontAwesomeIcon} from '@fortawesome/react-fontawesome';
import {faLink} from '@fortawesome/free-solid-svg-icons';

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
      const result=await context.controller.change(uuid,action,()=>window.confirm(`${action==='link'?'Link':'Unlink'} ${account.external_username||'this service account'} ${action==='link'?'to':'from'} ${service?user.linked_local_user?.display_name||'the local account':user.display_name||user.username||'this local account'}? This changes local primary ownership only.`));
      if(!result||!current())return;
      setModal(null);setNotice({context,text:'Ownership change confirmed.'});
      try{await Promise.all([state.mutate(),refreshUser()]);}
      catch{if(current())setNotice({context,text:'Ownership change confirmed. Reload the profile to refresh its display.'});}
    }catch(error){if(current())setNotice({context,text:String(error instanceof Error?error.message:error)});}
    finally{context.running=false;if(current())redraw(x=>x+1);}
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
  return <>
    {message&&<p className="text-sm text-muted-foreground" role="status">{message}</p>}
    {context.controller.uncertain&&<Button variant="outline" disabled={context.running} onClick={()=>void reconcile()}>Read current ownership</Button>}
    {service?<Card><CardHeader><CardTitle>Linked Local Account</CardTitle><CardDescription>This service user is currently linked to a local MUM account.</CardDescription></CardHeader><CardContent className="space-y-4">
      {state.error?<p className="text-sm text-destructive">Current ownership is unavailable.</p>:!page?<p className="text-sm text-muted-foreground">Loading service accounts.</p>:linked?<>
        <div className="rounded-lg border border-border bg-muted/30 p-4"><div className="text-sm text-muted-foreground">Linked to</div><div className="text-base font-semibold text-foreground">{user.linked_local_user?.display_name??user.linked_local_user?.username??'Local account'}</div>{user.linked_local_user?.email&&<div className="text-xs text-muted-foreground">{user.linked_local_user.email}</div>}</div>
        <button type="button" className="inline-flex items-center justify-center rounded-md text-sm font-medium border border-destructive/50 text-destructive hover:bg-destructive/10 h-9 px-4 py-2" disabled={blocked||!page.can_unlink} onClick={()=>void change(user.uuid,'unlink')}><FontAwesomeIcon icon={faLink} className="mr-2"/>{context.running?'Unlinking…':'Unlink account'}</button>
      </>:<p className="text-sm text-muted-foreground">This service account has no current primary link to this local account.</p>}
    </CardContent></Card>:<ServiceAccountsCard accounts={page?.linked_accounts??[]} loading={!state.error&&!page} error={state.error} onLink={page?.can_link&&page.available_accounts.length&&!blocked?()=>setModal(context):undefined} onUnlink={page?.can_unlink&&!blocked?uuid=>change(uuid,'unlink'):undefined}/>}
    {!service&&<ServiceAccountLinkModal key={`${actor}:${target}`} open={modal===context&&!blocked&&!!page?.can_link} onClose={()=>setModal(null)} accounts={page?.available_accounts??[]} loading={!page&&!state.error} error={state.error} onSubmit={uuid=>change(uuid,'link')}/>}
  </>;
}
