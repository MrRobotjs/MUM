import {requestJson} from '../util/apiClient';
import {getAccessToken} from '../store/authStore';
import {roleCatalog,type AdminRole,type RoleCreation} from './adminRoleReads';
export const ROLE_CHANGE_EVENT='mum:admin-roles-changed';
export function refreshRoleViews(actor:string){try{if(typeof window!=='undefined'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent(ROLE_CHANGE_EVENT,{detail:{actor_uuid:actor}}));}catch{/* Optional cache signal; never changes a confirmed durable outcome. */}}
export type RoleValues={name:string;description:string|null;position:number;color:string|null;icon:string|null;badge_style:'default'|'fill'|'outline';permission_ids:string[]};
export type RoleChangeBase={actor_uuid:string;snapshot_revision:number;mutations_available:boolean;creation?:RoleCreation;reorder_available?:boolean};
export function valuesFromRole(role:AdminRole):RoleValues{return{name:role.name,description:role.description,position:role.position,color:role.color,icon:role.icon,badge_style:role.badge_style,permission_ids:role.permissions.map(p=>p.id)};}
export function roleOrderPositions(original:AdminRole[],orderedIDs:string[]){
 if(orderedIDs.length!==original.length||new Set(orderedIDs).size!==original.length||orderedIDs.some(id=>!original.some(role=>role.id===id)))throw Error('Refresh the complete role order.');
 let slots=original.map(role=>role.position).sort((a,b)=>a-b);
 if(new Set(slots).size!==slots.length){if(original.some(role=>!role.can_reorder||role.is_protected))throw Error('Tied protected positions require explicit position resolution before dragging.');slots=slots.map((_,i)=>i+1);}
 const result=orderedIDs.map((id,i)=>({id,position:slots[i]}));
 if(result.some(entry=>original.some(role=>role.id===entry.id&&(!role.can_reorder||role.is_protected)&&role.position!==entry.position)))throw Error('Protected roles must keep their positions.');
 if(result.some(entry=>original.some(role=>role.id===entry.id&&role.position!==entry.position&&(!role.can_reorder||role.reorder_max_position===null||entry.position>role.reorder_max_position))))throw Error('Role order exceeds current move scope.');
 return result;
}
export function roleValues(input:RoleValues):RoleValues{
 const v={...input,name:input.name.trim(),permission_ids:[...input.permission_ids]};
 if(!v.name||new TextEncoder().encode(v.name).length>100||/[\u0000-\u001f\u007f]/.test(v.name)||!Number.isSafeInteger(v.position)||v.position<0||v.position>1000000||v.description!==null&&(typeof v.description!=='string'||new TextEncoder().encode(v.description).length>4000)||v.color!==null&&!/^#[0-9a-f]{6}$/i.test(v.color)||v.icon!==null&&!/^[A-Za-z0-9 _-]{0,128}$/.test(v.icon)||!['default','fill','outline'].includes(v.badge_style)||v.permission_ids.length>1||v.permission_ids.some(p=>p!=='admin'))throw Error('Use valid complete role fields and only the implemented Administrator permission.');
 return v;
}
const pending=new Set<string>();
export function admitRoleChange(actor:string){if(pending.has(actor))throw Error('A role change is already pending.');pending.add(actor);}
export function releaseRoleChange(actor:string){pending.delete(actor);}
export async function changeAdminRole(base:RoleChangeBase,operation:'create'|'update'|'delete'|'reorder',role?:AdminRole,values?:RoleValues,positions?:{id:string;position:number}[]){
 if(operation==='reorder'&&base.reorder_available!==true||operation==='create'&&!base.creation?.available||!Number.isSafeInteger(base.snapshot_revision)||base.snapshot_revision<1)throw Error('Refresh role settings before changing roles.');
 if((operation==='update'||operation==='delete')&&(!role||operation==='update'&&!role.mutations_available||operation==='delete'&&!role.can_delete||role.is_protected||role.snapshot_revision!==base.snapshot_revision))throw Error('This role is protected or changed. Refresh first.');
 if(operation==='delete'&&!role?.can_delete)throw Error('Remove all assignments before deleting this role.');
 const payload:Record<string,unknown>={expected_actor_uuid:base.actor_uuid,snapshot_revision:base.snapshot_revision};
 if(operation==='create'||operation==='update'){if(!values)throw Error('Complete role values are required.');payload.role=roleValues(values);if(operation==='create'&&(!Number.isSafeInteger(base.creation?.max_position)||values.position>base.creation!.max_position!))throw Error('Choose a role position within your current creation limit.');}
 if(operation==='delete')payload.acknowledge_delete=true;
 if(operation==='reorder'){
  if(!positions||positions.length<2||positions.length>1000||new Set(positions.map(p=>p.id)).size!==positions.length||new Set(positions.map(p=>p.position)).size!==positions.length||positions.some(p=>!/^[A-Za-z0-9_-]{1,128}$/.test(p.id)||!Number.isSafeInteger(p.position)||p.position<0||p.position>1000000))throw Error('Provide one complete role order with unique valid positions.');
  payload.positions=positions.map(p=>({...p}));
 }
 admitRoleChange(base.actor_uuid);
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),15000),token=getAccessToken();
 try{
  // A fresh catalog binds the draft revision to this same actor session.
  const{data:freshData}=await requestJson<{data:unknown}>('/api/admin-roles',{signal:abort.signal,retryAuthentication:false});
  const fresh=roleCatalog(freshData,base.actor_uuid);
  if(abort.signal.aborted||!token||token!==getAccessToken()||operation==='reorder'&&!fresh.reorder_available||operation==='create'&&(!fresh.creation.available||fresh.creation.max_position===null||values!.position>fresh.creation.max_position)||fresh.snapshot_revision!==base.snapshot_revision)throw Error('Role catalog changed');
  const target=role?fresh.roles.find(r=>r.id===role.id):undefined;
  if(role&&(!target||operation==='update'&&!target.mutations_available||operation==='delete'&&!target.can_delete))throw Error('Role authority changed');
  if(operation==='reorder'&&(positions!.length!==fresh.roles.length||positions!.some(p=>!fresh.roles.some(r=>r.id===p.id)||fresh.roles.some(r=>r.id===p.id&&r.position!==p.position&&(!r.can_reorder||r.reorder_max_position===null||p.position>r.reorder_max_position)))))throw Error('Protected or missing role in order');
  const path=operation==='create'?'/api/admin-roles':operation==='reorder'?'/api/admin-roles/reorder':`/api/admin-roles/${encodeURIComponent(role!.id)}`;
  const{data}=await requestJson<{data:{actor_uuid:string;snapshot_revision:number;operation:string;role_id?:string}}>(path,{method:operation==='create'||operation==='reorder'?'POST':operation==='delete'?'DELETE':'PUT',signal:abort.signal,retryAuthentication:false,body:JSON.stringify(payload)});
  if(abort.signal.aborted||token!==getAccessToken()||data?.actor_uuid!==base.actor_uuid||!Number.isSafeInteger(data.snapshot_revision)||data.snapshot_revision<=base.snapshot_revision||data.operation!==operation||(operation==='create'?!/^[A-Za-z0-9_-]{1,128}$/.test(data.role_id??''):operation!=='reorder'&&data.role_id!==role?.id))throw Error('Unconfirmed role result');
  refreshRoleViews(base.actor_uuid);
  return data;
 }catch{if(token===getAccessToken())refreshRoleViews(base.actor_uuid);throw Error('Role change could not be confirmed. Refresh and inspect the catalog before another attempt. No request was replayed.');}
 finally{clearTimeout(timer);releaseRoleChange(base.actor_uuid);}
}
