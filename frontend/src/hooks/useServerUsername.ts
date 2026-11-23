import useSWR from 'swr';
import {requestJson} from '../util/apiClient';
import {useAuth} from '../contexts/AuthContext';
import {getAuthSnapshot,subscribeToAuthStore} from '../store/authStore';
import {useSyncExternalStore} from 'react';
type Match={uuid:string;username:string;email:string|null;external_id:string};
export function useServerUsername(serverId?:number,username?:string,id?:string) {
 const {user,isAdministrator}=useAuth();const session=useSyncExternalStore(subscribeToAuthStore,getAuthSnapshot);
 const key=isAdministrator&&user?.uuid&&session.accessToken&&serverId&&username?['/api/servers',serverId,username,id??'',user.uuid,session.accessToken] as const:null;
 const state=useSWR(key,async ([,server,name,selected])=>{
  const q=new URLSearchParams({username:name});if(selected)q.set('id',selected);
  const result=await requestJson<{data:Match|{matches:Match[]}}>(`/api/servers/${server}/accounts/lookup?${q}`);
  const valid=(v:Match)=>v&&v.username===name&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.uuid)&&(v.email===null||typeof v.email==='string')&&typeof v.external_id==='string';
  if(!result.data)throw new Error('Invalid server account lookup');
  if('matches' in result.data){if(selected||!Array.isArray(result.data.matches)||result.data.matches.length<2||result.data.matches.length>100||!result.data.matches.every(valid)||new Set(result.data.matches.map(v=>v.uuid)).size!==result.data.matches.length)throw new Error('Invalid server account lookup');}
  else if(!valid(result.data)||(selected&&result.data.uuid!==selected))throw new Error('Invalid server account lookup');
  return result.data;
 });
 const data=state.data;
 return {uuid:data&&!('matches' in data)?data.uuid:undefined,username:data&&!('matches' in data)?data.username:undefined,matches:data&&'matches' in data?data.matches:[],loading:Boolean(key)&&state.isLoading,error:state.error};
}
