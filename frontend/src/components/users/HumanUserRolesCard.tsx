import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanUserRolesController,manualRoleIDs,validUserRoleName} from '../../lib/humanUserRoles';
import {Card,CardContent} from '../ui/card';
import {ConfirmAction,SettingHeader,SettingNotice,changedWhileConfirming,type Notice} from './AccountSettings';
import {Button} from '../ui/button';
import {Input} from '../ui/input';
import {Label} from '../ui/label';
import {Checkbox} from '../ui/checkbox';

const unavailable={protected_owner:'The owner account is protected.',protected_self:'You cannot change your own labels here.',pending_work:'Finish or reconcile pending provisioning and authorization work first.',available:''};
export function HumanUserRolesCard({target,refreshUser}:{target:string;refreshUser:()=>Promise<unknown>}){
  const {user,isAdministrator}=useAuth(),session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
  const actor=isAdministrator&&session.accessToken?user?.uuid:undefined,visible=useRef<HumanUserRolesController|null>(null);
  const controller=useMemo(()=>{const value:HumanUserRolesController=new HumanUserRolesController(actor??'',target,()=>visible.current===value);return value;},[actor,target,session.accessToken]);
  visible.current=controller;
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,ids:[] as string[],name:''}),[notice,setNotice]=useState<{controller:HumanUserRolesController;value:Notice}|null>(null);
  const [open,setOpen]=useState(false),[asking,setAsking]=useState<'save'|'create'|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const say=(value:Notice)=>{if(controller.current())setNotice({controller,value});};
  const saved=()=>{if(controller.current()&&controller.base)setDraft({controller,ids:manualRoleIDs(controller.base),name:''});};
  useEffect(()=>{visible.current=controller;setOpen(false);if(actor&&!controller.busy)void controller.load().then(()=>{saved();update();}).catch(error=>{if(controller.current()){say({text:String(error.message),error:true});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();try{await pending;saved();say(null);}catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{update();}};
  const ids=draft.controller===controller?draft.ids:[],name=draft.controller===controller?draft.name:'';
  const page=controller.current()?controller.base:null,changed=!!page&&JSON.stringify([...ids].sort())!==JSON.stringify(manualRoleIDs(page));
  const names=(p:NonNullable<typeof page>,chosen:readonly string[])=>p.roles.filter(r=>chosen.includes(r.id)).map(r=>r.name).join(', ');
  // The dialog shows what was read; the change goes ahead only if a fresh read still matches it.
  const save=async()=>{if(controller.busy||!controller.current()||!page)return;const chosen=[...ids],shown=page,label=names(page,chosen);
    const pending=controller.save(chosen,p=>p.username===shown.username&&names(p,chosen)===label&&JSON.stringify(manualRoleIDs(p))===JSON.stringify(manualRoleIDs(shown)));update();
    try{const result=await pending;if(!controller.current())return;if(!result){saved();say({text:changedWhileConfirming,error:true});return;}saved();setOpen(false);say({text:'Roles saved. Automatic roles were kept.'});try{await refreshUser();}catch{say({text:'Roles saved. Reload the profile to refresh its badges.'});}}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{setAsking(null);update();}};
  const create=async()=>{if(controller.busy||!controller.current())return;const pending=controller.create(name,()=>true);update();
    try{const result=await pending;if(!result||!controller.current())return;say({text:'Role created.'});try{await controller.load();saved();}catch{say({text:'Role created. Read the roles again to select it.',error:true});}}
    catch(error){say({text:String(error instanceof Error?error.message:error),error:true});}finally{setAsking(null);update();}};
  const assigned=page?page.roles.filter(r=>r.assigned).map(r=>r.name).join(', '):'';
  const shownNotice=notice?.controller===controller&&notice.value?notice.value:controller.needsRead?{text:'Read the saved roles before another change.',error:true}:null;
  const close=()=>{setOpen(false);saved();};
  return <Card>
    <SettingHeader title="Roles" summary={page?(assigned||'None'):controller.busy?'Loading…':'Unavailable'}
      info={<><p>Roles are visual labels only. Administrator permissions and media access are managed separately, and automatic roles are kept.</p>{page&&unavailable[page.availability]&&<p>{unavailable[page.availability]}</p>}</>}
      action={page&&(page.can_edit||page.can_create)&&<Button type="button" variant="outline" size="sm" aria-expanded={open} disabled={controller.busy||controller.needsRead} onClick={()=>open?close():setOpen(true)}>{open?'Cancel':'Edit'}</Button>}/>
    {(open&&page||shownNotice)&&<CardContent className="space-y-4">
      {open&&page&&<>
        {page.roles.length===0?<p className="text-sm text-muted-foreground">No roles are set up yet.</p>:
          <div className="space-y-2">{page.roles.map(role=><div key={role.id} className="flex items-center gap-2"><Checkbox id={`human-role-${target}-${role.id}`} checked={role.is_auto_managed?role.assigned:ids.includes(role.id)} disabled={controller.busy||controller.needsRead||!page.can_edit||role.is_auto_managed} onCheckedChange={checked=>setDraft({controller,name,ids:checked===true?[...ids.filter(id=>id!==role.id),role.id]:ids.filter(id=>id!==role.id)})}/><Label htmlFor={`human-role-${target}-${role.id}`}>{role.name}{role.is_auto_managed?' (automatic)':''}</Label></div>)}</div>}
        {page.can_edit&&<div><Button type="button" disabled={controller.busy||controller.needsRead||!changed} onClick={()=>setAsking('save')}>Save roles</Button></div>}
        {page.can_create&&<form className="space-y-4" onSubmit={event=>{event.preventDefault();if(!changed&&validUserRoleName(name))setAsking('create');}}>
          <div className="space-y-2"><Label htmlFor={`new-user-role-${target}`}>New role</Label><Input id={`new-user-role-${target}`} value={name} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,ids,name:event.target.value})}/></div>
          <Button type="submit" variant="outline" disabled={controller.busy||controller.needsRead||changed||!validUserRoleName(name)}>Create role</Button>
        </form>}
      </>}
      <SettingNotice notice={shownNotice} busy={controller.busy||!actor} onRetry={()=>void read()}/>
    </CardContent>}
    <ConfirmAction open={asking!==null} onOpenChange={value=>{if(!value)setAsking(null);}} title={asking==='create'?`Create the role “${name}”?`:`Save roles for ${page?.username||'this account'}?`} confirmLabel={asking==='create'?'Create role':'Save roles'} busy={controller.busy} onConfirm={()=>void (asking==='create'?create():save())}>
      {asking==='create'?'The role is a visual label. It grants no administrator or media permissions.':`Manual roles become: ${page&&ids.length?names(page,ids):'none'}. Automatic roles, administrator permissions and media access don't change.`}
    </ConfirmAction>
  </Card>;
}
