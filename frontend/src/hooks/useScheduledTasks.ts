import useSWR from 'swr';
import {useEffect} from 'react';
import {useAuth} from '../contexts/AuthContext';
import {fetchScheduledTasks,TASKS_EVENT,type SyncTask,type TaskSnapshot} from '../lib/scheduledTasks';
export type ScheduledTask=SyncTask&{id:string;name:string;type:string;side:string;channels:string[];coalesce:boolean;misfire_grace_time:null;actor_uuid:string;configuration_available:boolean;base:TaskSnapshot};
export const useScheduledTasks=()=>{
 const{user,isAdministrator}=useAuth(),actor=isAdministrator?user?.uuid:undefined;
 const state=useSWR(actor?['/api/settings/scheduled-tasks',actor]:null,([,owner]:[string,string])=>fetchScheduledTasks(owner),{refreshInterval:5000,keepPreviousData:false});
 useEffect(()=>{const changed=(e:Event)=>{if((e as CustomEvent<{actor_uuid:string}>).detail?.actor_uuid===actor)void state.mutate().catch(()=>{});};window.addEventListener(TASKS_EVENT,changed);return()=>window.removeEventListener(TASKS_EVENT,changed);},[actor,state.mutate]);
 const snapshot=state.data?.actor_uuid===actor&&!state.error?state.data:undefined;
 const tasks:ScheduledTask[]=snapshot?snapshot.tasks.map(t=>({...t,id:`provider-sync-${t.server_id}`,name:`Synchronize ${t.server_name}`,type:'Synchronization',side:'Server',channels:[],coalesce:true,misfire_grace_time:null,actor_uuid:snapshot.actor_uuid,configuration_available:snapshot.configuration_available,base:snapshot})):[];
 return{actor,tasks,loading:state.isLoading,error:state.error||(!actor?'Administrator access is required.':null),runtimeAvailable:snapshot?.runtime_available??false,checkpointError:snapshot?.checkpoint_error??false,refresh:state.mutate};
};
