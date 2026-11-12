import {fetchAdminRoleCandidates} from '../lib/adminRoleMemberships';
import {useEffect} from 'react';
import {ROLE_CHANGE_EVENT} from '../lib/adminRoleChanges';
import useSWR from 'swr';
import {useAuth} from '../contexts/AuthContext';
import {fetchAdminRoles,fetchAdminRole,fetchAdminPermissions,fetchAdminRoleMembers,type AdminRole,type AdminPermission,type AdminRoleMember} from '../lib/adminRoleReads';
export type {AdminRole,AdminPermission} from '../lib/adminRoleReads';
function useRoleRefresh(actor:string|undefined,refresh:()=>Promise<unknown>){
 useEffect(()=>{const changed=(event:Event)=>{if(actor&&(event as CustomEvent<{actor_uuid:string}>).detail?.actor_uuid===actor)void refresh().catch(()=>{});};window.addEventListener(ROLE_CHANGE_EVENT,changed);return()=>window.removeEventListener(ROLE_CHANGE_EVENT,changed);},[actor,refresh]);
}
const emptyRoles:AdminRole[]=[],emptyPermissions:AdminPermission[]=[],emptyMembers:AdminRoleMember[]=[];
export const useAdminRoles=()=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor?['/api/admin-roles',actor]:null,([,owner]:[string,string])=>fetchAdminRoles(owner),{keepPreviousData:false});
 useRoleRefresh(actor,state.mutate);
 const current=state.data?.actor_uuid===actor&&!state.error?state.data:undefined;
 return{actor,roles:current?.roles??emptyRoles,loading:state.isLoading,error:state.error,refresh:async()=>{await state.mutate();},catalog:current,reorderAvailable:current?.reorder_available??false,creationAvailable:current?.creation.available??false,creationMaximum:current?.creation.max_position??null,mutationsAvailable:current?.mutations_available??false};
};
export const useAdminPermissions=()=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor?['/api/admin-permissions',actor]:null,([,owner]:[string,string])=>fetchAdminPermissions(owner),{keepPreviousData:false});
 useRoleRefresh(actor,state.mutate);
 return{permissions:state.data&&state.data.actor_uuid===actor&&!state.error?state.data.permissions:emptyPermissions,loading:state.isLoading,error:state.error};
};
export const useAdminRoleDetail=(roleId?:string)=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor&&roleId?['/api/admin-roles',actor,roleId]:null,([,owner,role]:[string,string,string])=>fetchAdminRole(owner,role),{keepPreviousData:false});
 useRoleRefresh(actor,state.mutate);
 return{actor,role:state.data&&state.data.actor_uuid===actor&&state.data.role.id===roleId&&!state.error?state.data.role:null,loading:state.isLoading,error:state.error,refresh:async()=>{await state.mutate();}};
};
export const useAdminRoleMembers=(roleId:string)=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor?['/api/admin-role-members',actor,roleId]:null,([,owner,role]:[string,string,string])=>fetchAdminRoleMembers(owner,role),{keepPreviousData:false});
 useRoleRefresh(actor,state.mutate);
 return{actor,snapshot:state.data&&state.data.actor_uuid===actor&&state.data.role_id===roleId&&!state.error?state.data:undefined,members:state.data&&state.data.actor_uuid===actor&&state.data.role_id===roleId&&!state.error?state.data.members:emptyMembers,loading:state.isLoading,error:state.error,refresh:async()=>{await state.mutate();}};
};

export const useAdminRoleCandidates=(roleId:string,enabled:boolean)=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor&&enabled?['/api/admin-role-candidates',actor,roleId]:null,([,owner,role]:[string,string,string])=>fetchAdminRoleCandidates(owner,role),{keepPreviousData:false});
 useRoleRefresh(enabled?actor:undefined,state.mutate);
 return{snapshot:enabled&&state.data&&state.data.actor_uuid===actor&&state.data.role_id===roleId&&!state.error?state.data:undefined,loading:state.isLoading,error:state.error,refresh:async()=>await state.mutate()};
};
