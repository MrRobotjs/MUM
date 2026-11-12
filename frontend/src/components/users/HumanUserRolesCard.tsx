import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {useAuth} from '../../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../../store/authStore';
import {HumanUserRolesController,manualRoleIDs,validUserRoleName} from '../../lib/humanUserRoles';
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from '../ui/card';
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
  const [,redraw]=useState(0),[draft,setDraft]=useState({controller,ids:[] as string[],name:''}),[notice,setNotice]=useState<{controller:HumanUserRolesController;text:string}|null>(null);
  const update=()=>{if(controller.current())redraw(x=>x+1);};
  const saved=()=>{if(controller.current()&&controller.base)setDraft({controller,ids:manualRoleIDs(controller.base),name:''});};
  useEffect(()=>{visible.current=controller;if(actor&&!controller.busy)void controller.load().then(()=>{saved();update();}).catch(error=>{if(controller.current()){setNotice({controller,text:String(error.message)});update();}});update();return()=>{if(visible.current===controller)visible.current=null;};},[actor,controller]);
  const read=async()=>{if(controller.busy||!controller.current())return;const pending=controller.load();update();try{await pending;saved();if(controller.current())setNotice({controller,text:'Saved user roles read. No change was retried.'});}catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const ids=draft.controller===controller?draft.ids:[],name=draft.controller===controller?draft.name:'';
  const save=async()=>{if(controller.busy||!controller.current())return;const chosen=[...ids];
    const pending=controller.save(chosen,p=>window.confirm(`Replace manual visual labels for ${p.username||'this account'} with ${chosen.length? p.roles.filter(r=>chosen.includes(r.id)).map(r=>r.name).join(', '):'no manual labels'}? Automatic labels, administrator permissions and media policies will remain unchanged.`));update();
    try{const result=await pending;if(!result||!controller.current())return;saved();setNotice({controller,text:'Manual user roles saved. Automatic labels were preserved.'});try{await refreshUser();}catch{if(controller.current())setNotice({controller,text:'Manual user roles saved. Reload the profile to refresh its badges.'});}}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const create=async()=>{if(controller.busy||!controller.current())return;const pending=controller.create(name,()=>window.confirm(`Create the visual label “${name}”? This label grants no administrator or media permissions.`));update();
    try{const result=await pending;if(!result||!controller.current())return;setNotice({controller,text:'Visual role created. Read saved user roles to select it.'});try{await controller.load();saved();}catch{if(controller.current())setNotice({controller,text:'Visual role created. Read saved user roles to refresh the catalog.'});}}
    catch(error){if(controller.current())setNotice({controller,text:String(error instanceof Error?error.message:error)});}finally{update();}};
  const page=controller.current()?controller.base:null,changed=!!page&&JSON.stringify([...ids].sort())!==JSON.stringify(manualRoleIDs(page));
  return <Card className="border-border shadow-sm"><CardHeader><CardTitle>User Roles</CardTitle><CardDescription>Visual labels only. Administrator permissions and media policies are managed separately. Automatic labels are preserved.</CardDescription></CardHeader><CardContent className="space-y-4">
    {notice?.controller===controller&&<p className="text-sm text-muted-foreground" role="status">{notice.text}</p>}
    {page?<>{unavailable[page.availability]&&<p className="text-sm text-muted-foreground">{unavailable[page.availability]}</p>}
      {page.roles.length===0&&<p className="text-sm text-muted-foreground">No user roles are configured.</p>}
      <div className="space-y-2">{page.roles.map(role=><div key={role.id} className="flex items-center gap-2"><Checkbox id={`human-role-${target}-${role.id}`} checked={role.is_auto_managed?role.assigned:ids.includes(role.id)} disabled={controller.busy||controller.needsRead||!page.can_edit||role.is_auto_managed} onCheckedChange={checked=>setDraft({controller,name,ids:checked===true?[...ids.filter(id=>id!==role.id),role.id]:ids.filter(id=>id!==role.id)})}/><Label htmlFor={`human-role-${target}-${role.id}`}>{role.name}{role.is_auto_managed?' (automatic)':''}</Label></div>)}</div>
      {page.can_create&&<div className="space-y-2"><Label htmlFor={`new-user-role-${target}`}>New visual role name</Label><Input id={`new-user-role-${target}`} value={name} disabled={controller.busy||controller.needsRead} onChange={event=>setDraft({controller,ids,name:event.target.value})}/><Button variant="outline" disabled={controller.busy||controller.needsRead||changed||!validUserRoleName(name)} onClick={()=>void create()}>Create visual role</Button></div>}</>:<p className="text-sm text-muted-foreground">{controller.busy?'Loading user roles…':'Saved user roles are unavailable.'}</p>}
    <div className="flex justify-end gap-3"><Button variant="outline" disabled={controller.busy||!actor} onClick={()=>void read()}>Read saved user roles</Button>{page?.can_edit&&<Button disabled={controller.busy||controller.needsRead||!changed} onClick={()=>void save()}>Save manual roles</Button>}</div>
  </CardContent></Card>;
}
